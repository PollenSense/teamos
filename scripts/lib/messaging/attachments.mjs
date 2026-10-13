import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

/**
 * Image attachments on messages.
 *
 * A message with images keeps them next to the message files:
 *
 *   team/messages/<id>.md
 *   team/messages/attachments/<id>/<name>.png      (png, jpg, gif, webp only)
 *
 * The body refers to an image with a normal markdown image whose address is
 * relative to `team/messages/` (`![caption](attachments/<id>/<name>)`), and the
 * frontmatter lists the names (`attachments: [a.png]`) so listings need no
 * disk walk. The type of a file is decided by its first bytes, never by its
 * name; anything that is not one of the four formats is refused, which also
 * keeps a path to a non-image file (a secrets file, say) from being copied in.
 *
 * Two entry points share these rules: the file messaging adapter
 * (`sendMessage` / `supersedeMessage` take `attachments`), and the dashboard,
 * which receives an image before the message exists and so keeps it in a
 * staging area (`AttachmentStore`) until the message is sent.
 */

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 25 * 1024 * 1024;

/** What the dashboard tells the browser it may send (the browser resizes photos to fit). */
export const ATTACHMENT_LIMITS = {
	maxBytes: MAX_ATTACHMENT_BYTES,
	maxCount: MAX_ATTACHMENTS,
	maxTotalBytes: MAX_ATTACHMENTS_TOTAL_BYTES,
	types: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
};

const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** Safe stored names: lowercase, starts with a letter or digit, one of the four extensions. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,79}\.(png|jpg|gif|webp)$/;
/** A message id is a timestamp plus a short suffix: letters, digits, dot, dash. */
const MESSAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOKEN_RE = /^[a-f0-9]{24}$/;

export function isAttachmentName(name) {
	return typeof name === 'string' && NAME_RE.test(name);
}

export function isMessageId(id) {
	return typeof id === 'string' && MESSAGE_ID_RE.test(id) && !id.includes('..');
}

export function mimeForName(name) {
	return MIME_BY_EXT[extname(name).slice(1)] ?? null;
}

/** The image format of `buf` from its first bytes, or null. */
export function sniffImage(buf) {
	if (!buf || buf.length < 12) return null;
	if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
		return { ext: 'png', mime: 'image/png' };
	}
	if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
	const head6 = buf.toString('latin1', 0, 6);
	if (head6 === 'GIF87a' || head6 === 'GIF89a') return { ext: 'gif', mime: 'image/gif' };
	if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
		return { ext: 'webp', mime: 'image/webp' };
	}
	return null;
}

/**
 * A stored name from whatever the sender called the file: the base name only,
 * lowercased, anything outside `a-z 0-9 . _ -` turned into a dash, the real
 * extension from the sniffed type, and a `-2`, `-3` suffix when `taken` has it.
 */
export function safeAttachmentName(original, ext, taken = new Set()) {
	let stem = basename(String(original ?? '').replace(/\\/g, '/'));
	stem = stem.slice(0, stem.length - extname(stem).length);
	stem = stem
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/\.{2,}/g, '.')
		.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
		.slice(0, 60)
		.replace(/[^a-z0-9]+$/g, '');
	if (!stem) stem = 'image';
	let name = `${stem}.${ext}`;
	for (let n = 2; taken.has(name); n++) name = `${stem}-${n}.${ext}`;
	return name;
}

/** `[caption](attachment:<ref>)` is the address of a staged image until the message is sent. */
export const PLACEHOLDER = (ref) => `attachment:${ref}`;
const LEFTOVER_PLACEHOLDER_RE = /\]\(\s*attachment:[A-Za-z0-9_-]+\s*\)/;

/**
 * Check and read the files named by `items` (`{ path, name?, ref? }`), before
 * anything is written. Returns `{ name, bytes, mime, ref, original }` in order
 * with unique stored names. Throws one clear error on the first problem.
 */
export async function prepareAttachments(items) {
	if (items == null) return [];
	if (!Array.isArray(items)) throw httpError(400, 'attachments must be a list');
	if (items.length > MAX_ATTACHMENTS) {
		throw httpError(400, `Too many attachments: ${items.length} (the limit is ${MAX_ATTACHMENTS} per message)`);
	}
	const taken = new Set();
	const out = [];
	let total = 0;
	for (const item of items) {
		const path = item?.path;
		if (typeof path !== 'string' || !path) throw httpError(400, 'Each attachment needs a path');
		const label = item.name || basename(path);
		let info;
		try {
			info = await stat(path);
		} catch {
			throw httpError(400, `Attachment "${label}" cannot be read`);
		}
		if (!info.isFile()) throw httpError(400, `Attachment "${label}" is not a file`);
		if (info.size > MAX_ATTACHMENT_BYTES) {
			throw httpError(413, `Attachment "${label}" is ${mb(info.size)} MB (the limit is ${mb(MAX_ATTACHMENT_BYTES)} MB each)`);
		}
		total += info.size;
		if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
			throw httpError(413, `Attachments total more than ${mb(MAX_ATTACHMENTS_TOTAL_BYTES)} MB per message`);
		}
		const bytes = await readFile(path);
		const kind = sniffImage(bytes);
		if (!kind) throw httpError(415, `Attachment "${label}" is not a png, jpg, gif or webp image`);
		const name = safeAttachmentName(item.name || basename(path), kind.ext, taken);
		taken.add(name);
		out.push({ name, bytes, mime: kind.mime, ref: item.ref ?? null, original: label });
	}
	return out;
}

function mb(bytes) {
	return (bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1);
}

/**
 * The body with each `attachment:<ref>` address replaced by the stored path,
 * and every attachment the body does not mention appended as an image line.
 * A placeholder that names no attachment is an error: a message must never
 * point at a file that is not there.
 */
export function applyAttachmentsToBody(body, id, prepared) {
	let text = body ?? '';
	const referenced = new Set();
	for (const att of prepared) {
		if (!att.ref) continue;
		const placeholder = PLACEHOLDER(att.ref);
		if (text.includes(placeholder)) {
			referenced.add(att.name);
			text = text.split(placeholder).join(`attachments/${id}/${att.name}`);
		}
	}
	if (LEFTOVER_PLACEHOLDER_RE.test(text)) {
		throw httpError(400, 'The message refers to an attachment that was not sent with it');
	}
	const rest = prepared.filter((att) => !referenced.has(att.name));
	if (rest.length > 0) {
		const lines = rest.map((att) => `![${altFor(att)}](attachments/${id}/${att.name})`);
		text = `${text.trimEnd()}\n\n${lines.join('\n\n')}`;
	}
	return text;
}

function altFor(att) {
	return String(att.original ?? att.name)
		.replace(/\.[A-Za-z0-9]+$/, '')
		.replace(/[\[\]\\\r\n]/g, ' ')
		.trim() || 'image';
}

/** Write the files of a message (`<messagesDir>/attachments/<id>/`); on any failure nothing is left behind. */
export async function writeAttachments(messagesDir, id, prepared) {
	if (prepared.length === 0) return;
	const dir = join(messagesDir, 'attachments', id);
	try {
		await mkdir(dir, { recursive: true });
		for (const att of prepared) await writeFile(join(dir, att.name), att.bytes);
	} catch (err) {
		await rm(dir, { recursive: true, force: true });
		throw err;
	}
}

export async function removeAttachments(messagesDir, id) {
	await rm(join(messagesDir, 'attachments', id), { recursive: true, force: true });
}

/**
 * The dashboard's side. The browser sends an image before the message exists,
 * so the bytes wait in `team/.logs/attachments-staging/` (outside the Drive
 * sync) under a random token, tied to the member who sent them, until
 * `POST /api/messages` names the token. Unclaimed files are swept after a day.
 */
export class AttachmentStore {
	constructor(teamDir, { maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
		this.messagesDir = join(teamDir, 'messages');
		this.stagingDir = join(teamDir, '.logs', 'attachments-staging');
		this.maxAgeMs = maxAgeMs;
	}

	get limits() {
		return ATTACHMENT_LIMITS;
	}

	/** Keep an uploaded image for `from`. Returns `{ token, name, size, mime }` or throws `{ status, message }`. */
	async stage({ from, name, bytes }) {
		if (!from) throw httpError(403, 'No sender');
		if (!bytes || bytes.length === 0) throw httpError(400, 'Empty upload');
		if (bytes.length > MAX_ATTACHMENT_BYTES) {
			throw httpError(413, `Image is larger than ${mb(MAX_ATTACHMENT_BYTES)} MB`);
		}
		const kind = sniffImage(bytes);
		if (!kind) throw httpError(415, 'Only png, jpg, gif and webp images can be attached');
		await mkdir(this.stagingDir, { recursive: true });
		await this.sweep();
		const token = randomBytes(12).toString('hex');
		const stored = safeAttachmentName(name, kind.ext);
		await writeFile(join(this.stagingDir, `${token}.bin`), bytes);
		await writeFile(
			join(this.stagingDir, `${token}.json`),
			JSON.stringify({ from, name: stored, mime: kind.mime, size: bytes.length, at: Date.now() }),
			'utf-8',
		);
		return { token, name: stored, size: bytes.length, mime: kind.mime };
	}

	/** Turn tokens into adapter items, checking each was uploaded by `from`. */
	async claim(tokens, from) {
		if (tokens == null) return [];
		if (!Array.isArray(tokens)) throw httpError(400, 'attachments must be a list of tokens');
		const items = [];
		for (const token of tokens) {
			if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw httpError(400, 'Unknown attachment');
			let meta;
			try {
				meta = JSON.parse(await readFile(join(this.stagingDir, `${token}.json`), 'utf-8'));
			} catch {
				throw httpError(400, 'An attachment expired or was already sent; add the image again');
			}
			if (meta.from !== from) throw httpError(403, 'That attachment was uploaded by someone else');
			items.push({ path: join(this.stagingDir, `${token}.bin`), name: meta.name, ref: token });
		}
		return items;
	}

	/** Forget staged files once their message is written. */
	async release(tokens) {
		for (const token of tokens ?? []) {
			if (!TOKEN_RE.test(token)) continue;
			await rm(join(this.stagingDir, `${token}.bin`), { force: true });
			await rm(join(this.stagingDir, `${token}.json`), { force: true });
		}
	}

	async sweep() {
		let names;
		try {
			names = await readdir(this.stagingDir);
		} catch {
			return;
		}
		const cutoff = Date.now() - this.maxAgeMs;
		for (const file of names) {
			try {
				const info = await stat(join(this.stagingDir, file));
				if (info.mtimeMs < cutoff) await rm(join(this.stagingDir, file), { force: true });
			} catch {
				// Gone already.
			}
		}
	}

	/**
	 * The stored image for `<id>/<name>`, or null: the name and id must be
	 * well-formed, the file must exist, and its first bytes must be an image
	 * of the type its name says. `mime` is the sniffed type.
	 */
	async read(id, name) {
		if (!isMessageId(id) || !isAttachmentName(name)) return null;
		const path = join(this.messagesDir, 'attachments', id, name);
		try {
			const info = await stat(path);
			if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES) return null;
			const bytes = await readFile(path);
			const kind = sniffImage(bytes);
			if (!kind || kind.mime !== mimeForName(name)) return null;
			return { bytes, mime: kind.mime };
		} catch {
			return null;
		}
	}
}

function httpError(status, message) {
	return Object.assign(new Error(message), { status });
}
