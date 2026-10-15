/**
 * Images in messages, browser side.
 *
 * A stored image lives at `team/messages/attachments/<id>/<name>` and the body points at it with
 * a markdown image relative to `team/messages/`: `![caption](attachments/<id>/<name>)`. The
 * dashboard serves it from `/api/messages/<id>/attachments/<name>` and that is the only address
 * an `<img>` in a message may have: an image from anywhere else would load the moment the
 * message is opened, which tells that site who read it and when. Every other image becomes a
 * plain link.
 *
 * The rules for what the server stores live in `scripts/lib/messaging/attachments.mjs`; the
 * limits come from `/api/messaging/info`. This file is the browser's half: the renderer
 * extension, the placeholders used while composing, and the decision whether a picked photo is
 * sent as it is or shrunk first.
 */
import type { MarkedExtension, Tokens } from 'marked';

const ID = '[A-Za-z0-9][A-Za-z0-9._-]{0,127}';
const NAME = '[a-z0-9][a-z0-9._-]{0,79}\\.(?:png|jpg|gif|webp)';
const STORED = new RegExp(`^attachments/(${ID})/(${NAME})$`);
const SERVED = new RegExp(`^/api/messages/(${ID})/attachments/(${NAME})$`);

/** The address the dashboard serves a stored image from, or null for anything else. */
export function attachmentUrl(href: string): string | null {
	const match = STORED.exec((href ?? '').trim());
	if (!match || match[1].includes('..')) return null;
	return `/api/messages/${encodeURIComponent(match[1])}/attachments/${encodeURIComponent(match[2])}`;
}

/** True for an address `attachmentUrl` produced; the sanitizer keeps an `<img>` only if this holds. */
export function isServedAttachmentUrl(src: string): boolean {
	const match = SERVED.exec(src ?? '');
	return !!match && !match[1].includes('..');
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * marked extension: a stored image becomes an `<img>` inside a link to the full-size file;
 * any other image becomes a link to its address, with its caption (or the address) as the text,
 * so nothing outside loads on its own.
 */
export function attachmentRenderer(): MarkedExtension {
	return {
		renderer: {
			image(token: Tokens.Image): string {
				const served = attachmentUrl(token.href);
				const alt = token.text || '';
				if (served) {
					const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
					return `<a class="md-image" href="${served}" target="_blank" rel="noopener noreferrer"><img src="${served}" alt="${escapeHtml(alt)}"${title} loading="lazy"></a>`;
				}
				const href = escapeHtml(token.href ?? '');
				return `<a href="${href}">${escapeHtml(alt || token.href || 'image')}</a>`;
			},
		},
	};
}

// ─── Composing ───────────────────────────────────────────────────────────────

export interface AttachmentLimits {
	maxBytes: number;
	maxCount: number;
	maxTotalBytes: number;
	types: string[];
}

/** The markdown a compose box holds for an image until the message is sent: the server swaps `attachment:<ref>` for the stored path. */
export function placeholder(name: string, ref: string): string {
	const alt = name.replace(/\.[A-Za-z0-9]+$/, '').replace(/[[\]\\\r\n]/g, ' ').trim() || 'image';
	return `![${alt}](attachment:${ref})`;
}

/** Insert `text` into `body` at `at` (clamped), on a line of its own when it lands mid-line. Returns the new body and caret. */
export function insertAt(body: string, at: number, text: string): { body: string; caret: number } {
	const pos = Math.max(0, Math.min(at, body.length));
	const before = body.slice(0, pos);
	const after = body.slice(pos);
	const lead = before === '' || before.endsWith('\n') ? '' : '\n';
	const trail = after === '' || after.startsWith('\n') ? '' : '\n';
	const inserted = `${lead}${text}${trail}`;
	return { body: `${before}${inserted}${after}`, caret: before.length + lead.length + text.length };
}

/** Append `text` as its own paragraph at the end. */
export function appendBlock(body: string, text: string): { body: string; caret: number } {
	const base = body.trimEnd();
	const next = base ? `${base}\n\n${text}\n` : `${text}\n`;
	return { body: next, caret: next.length };
}

/** `body` with every image whose address is `attachment:<ref>` taken out (its line is dropped if nothing else is on it). */
export function removePlaceholder(body: string, ref: string): string {
	const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const image = new RegExp(`!\\[[^\\]]*\\]\\(attachment:${escaped}\\)`, 'g');
	return body
		.replace(new RegExp(`^[ \\t]*${image.source}[ \\t]*\\n?`, 'gm'), '')
		.replace(image, '')
		.replace(/\n{3,}/g, '\n\n');
}

export function swapPlaceholderRef(body: string, from: string, to: string): string {
	return body.split(`(attachment:${from})`).join(`(attachment:${to})`);
}

/** A name for an image that arrived without a useful one (a pasted screenshot is called `image.png`). */
export function pastedName(now: Date, ext: string, n = 1): string {
	const pad = (v: number) => String(v).padStart(2, '0');
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	return `pasted-${stamp}${n > 1 ? `-${n}` : ''}.${ext}`;
}

// ─── Deciding what to send ───────────────────────────────────────────────────

/** Photos are shrunk to this long side before they are sent. */
export const LONG_SIDE = 2560;
export const JPEG_QUALITY = 0.85;

export type ImagePlan =
	| { kind: 'keep' }
	| { kind: 'reencode' }
	| { kind: 'refuse'; message: string };

const KEEP_TYPES = new Set(['image/png', 'image/gif', 'image/webp']);

function megabytes(bytes: number): string {
	const mb = bytes / (1024 * 1024);
	return Number.isInteger(mb) ? String(mb) : mb.toFixed(1);
}

/**
 * What to do with a picked, dropped or pasted file. PNG, GIF and WebP go as they are while they fit
 * (a screenshot must stay sharp, a GIF must keep moving). JPEG and every other image type the browser
 * may be able to decode (an iPhone's HEIC, say) are drawn again as a JPEG no larger than 2560 px on
 * the long side, which also drops the camera's EXIF block (location included). A PNG or WebP that is
 * over the limit is shrunk the same way; a GIF that is over the limit is refused, since a still
 * would not be what was sent.
 */
export function planImage(file: { type: string; name: string; size: number }, limits: AttachmentLimits): ImagePlan {
	const type = (file.type || '').toLowerCase();
	const looksLikeImage = type.startsWith('image/') || (!type && /\.(heic|heif|jpe?g|png|gif|webp|avif|bmp|tiff?)$/i.test(file.name));
	if (!looksLikeImage) return { kind: 'refuse', message: `"${file.name}" is not an image` };
	if (type === 'image/svg+xml') return { kind: 'refuse', message: 'SVG images cannot be attached; use a PNG' };
	if (KEEP_TYPES.has(type)) {
		if (file.size <= limits.maxBytes) return { kind: 'keep' };
		if (type === 'image/gif') {
			return { kind: 'refuse', message: `"${file.name}" is ${megabytes(file.size)} MB; a GIF can be at most ${megabytes(limits.maxBytes)} MB` };
		}
	}
	return { kind: 'reencode' };
}

/** Largest size with the same shape whose long side is at most `longSide`; never enlarges. */
export function fitWithin(width: number, height: number, longSide = LONG_SIDE): { width: number; height: number } {
	const long = Math.max(width, height);
	if (long <= longSide) return { width, height };
	const scale = longSide / long;
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The stored name after a re-encode: same stem, `.jpg`. */
export function jpegName(name: string): string {
	const stem = name.replace(/\.[A-Za-z0-9]+$/, '');
	return `${stem || 'image'}.jpg`;
}

export interface PreparedImage {
	blob: Blob;
	name: string;
	/** True when the picture was drawn again (resized, JPEG, EXIF gone). */
	reencoded: boolean;
}

/** Browser only (canvas). Turns a file into what is uploaded, or throws an Error with a sentence for the sender. */
export async function prepareImage(file: File, limits: AttachmentLimits, name = file.name): Promise<PreparedImage> {
	const plan = planImage(file, limits);
	if (plan.kind === 'refuse') throw new Error(plan.message);
	if (plan.kind === 'keep') return { blob: file, name, reencoded: false };

	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
	} catch {
		throw new Error(`This browser cannot read "${name}"; try a PNG or JPEG`);
	}
	try {
		const { width, height } = fitWithin(bitmap.width, bitmap.height);
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('This browser cannot resize images');
		// JPEG has no transparency: a transparent PNG would turn black without this.
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, width, height);
		ctx.drawImage(bitmap, 0, 0, width, height);
		for (const quality of [JPEG_QUALITY, 0.7]) {
			const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
			if (!blob) throw new Error(`Could not convert "${name}"`);
			if (blob.size <= limits.maxBytes) return { blob, name: jpegName(name), reencoded: true };
		}
		throw new Error(`"${name}" is still over ${megabytes(limits.maxBytes)} MB after resizing`);
	} finally {
		bitmap.close();
	}
}
