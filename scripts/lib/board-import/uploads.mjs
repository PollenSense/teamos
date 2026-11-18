import { createHash } from 'node:crypto';
import { parseId, redactValue } from '../board/index.mjs';

/**
 * What the uploads importer (ticket A6b) knows without a network or a disk: which upload links the texts of the
 * issues and their comments hold, what an upload is called on disk, and what its entry in the card says.
 *
 *   findUploads(entities)      the links per issue key (description and comments), with counts
 *   uploadId(url)              a short stable id of a link (host + path; query and fragment do not count)
 *   safeFileName(name, opts)   a file name that cannot leave its folder or break a sync client
 *   uniqueName(name, taken)    the name, numbered when the folder has it already (case does not count)
 *   dispositionFileName(h)     the file name a Content-Disposition header gives, or null
 *
 * Only links on the one upload host are uploads. A link to any other host is a link, not an upload (A6 keeps those).
 */

export const UPLOAD_HOST = 'uploads.linear.app';

const URL_IN_TEXT = /https:\/\/uploads\.linear\.app\/[^\s)"'<>\]]+/g;
const MARKDOWN_LINK = /!?\[([^\]]*)\]\((https:\/\/uploads\.linear\.app\/[^\s)"'<>\]]+)/g;
const TRAILING = /[.,;:!?]+$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The link as the export wrote it, without trailing sentence punctuation or a fragment; null when it is not an https link on the upload host (no user, password or port). */
export function parseUploadUrl(text) {
	if (typeof text !== 'string') return null;
	let url;
	try {
		url = new URL(text.replace(TRAILING, ''));
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' || url.hostname !== UPLOAD_HOST || url.port !== '' || url.username !== '' || url.password !== '') return null;
	if (url.pathname === '/' || url.pathname === '') return null;
	url.hash = '';
	return url.href;
}

/** 16 hex characters of the SHA-256 of host + path: the same upload under another query string has the same id. */
export function uploadId(url) {
	const parsed = new URL(url);
	return createHash('sha256').update(`${parsed.hostname}${parsed.pathname}`).digest('hex').slice(0, 16);
}

/** Every upload link in a text, with the link text of a markdown link when it has one: `[{ url, label }]`, in order of appearance. */
function linksIn(text) {
	if (typeof text !== 'string' || text === '') return [];
	const labels = new Map();
	for (const m of text.matchAll(MARKDOWN_LINK)) {
		const url = parseUploadUrl(m[2]);
		if (url !== null && !labels.has(url)) labels.set(url, m[1]);
	}
	const out = [];
	for (const m of text.matchAll(URL_IN_TEXT)) {
		const url = parseUploadUrl(m[0]);
		if (url !== null) out.push({ url, label: labels.get(url) ?? '' });
	}
	return out;
}

/** Strings anywhere inside a record, for the texts this ticket does not download from. */
function* strings(value, depth = 0) {
	if (typeof value === 'string') yield value;
	else if (depth < 6 && Array.isArray(value)) for (const v of value) yield* strings(v, depth + 1);
	else if (depth < 6 && value !== null && typeof value === 'object') for (const v of Object.values(value)) yield* strings(v, depth + 1);
}

/**
 * @param {Record<string, object[]>} entities  what `readExport` returned (`issues` and `comments` are read; documents,
 *   project updates, projects, attachments and comments on those are only scanned, to count what is left for later)
 * @returns {{byKey: Map<string, Map<string, {id: string, url: string, labels: string[], texts: {kind: string, comment?: string}[]}>>,
 *            counts: object}}
 *   `byKey`: per issue key, per upload id, the link, the link texts seen and where it was used (`description` or a comment's id)
 */
export function findUploads(entities) {
	const get = (type) => entities[type] ?? [];
	const byKey = new Map();
	const counts = { mentions: 0, distinct: 0, inDescriptions: 0, inComments: 0, cards: 0, refused: 0, leftForLater: 0 };
	const seen = new Set();
	const add = (key, kind, comment, link) => {
		if (typeof key !== 'string' || key === '') {
			counts.refused++;
			return;
		}
		if (kind === 'comment' && (typeof comment !== 'string' || !NAME.test(comment))) {
			counts.refused++; // a comment id that is not a plain name cannot be named in a thread file
			return;
		}
		counts.mentions++;
		if (kind === 'description') counts.inDescriptions++;
		else counts.inComments++;
		const id = uploadId(link.url);
		seen.add(id);
		if (!byKey.has(key)) byKey.set(key, new Map());
		const uploads = byKey.get(key);
		if (!uploads.has(id)) uploads.set(id, { id, url: link.url, labels: [], texts: [] });
		const upload = uploads.get(id);
		if (link.label !== '' && !upload.labels.includes(link.label)) upload.labels.push(link.label);
		const text = kind === 'comment' ? { kind, comment } : { kind };
		if (!upload.texts.some((t) => t.kind === text.kind && t.comment === text.comment)) upload.texts.push(text);
	};
	for (const issue of get('issues')) for (const link of linksIn(issue.description)) add(issue.key, 'description', undefined, link);
	const elsewhere = new Set();
	for (const comment of get('comments')) {
		const onIssue = typeof comment.issueKey === 'string' && comment.issueKey !== '';
		for (const link of linksIn(comment.body)) {
			if (onIssue) add(comment.issueKey, 'comment', comment.id, link);
			else elsewhere.add(uploadId(link.url));
		}
	}
	for (const type of ['documents', 'projectUpdates', 'projects', 'attachments']) {
		for (const record of get(type)) for (const text of strings(record)) for (const link of linksIn(text)) elsewhere.add(uploadId(link.url));
	}
	counts.leftForLater = [...elsewhere].filter((id) => !seen.has(id)).length;
	counts.cards = byKey.size;
	counts.distinct = seen.size;
	for (const uploads of byKey.values()) for (const upload of uploads.values()) upload.labels.sort(cmp);
	return { byKey, counts };
}

const FORBIDDEN = new Set(['/', '\\', ':', '*', '?', '"', '<', '>', '|']);
const SUPERSCRIPTS = String.fromCharCode(0xb9, 0xb2, 0xb3);
/** Windows device names (and `CON.anything`: the device wins whatever follows the first dot). */
const RESERVED = new RegExp(`^(con|prn|aux|nul|conin\\$|conout\\$|com[1-9${SUPERSCRIPTS}]|lpt[1-9${SUPERSCRIPTS}])$`, 'i');
const EXTENSION = /^[A-Za-z0-9]{1,8}$/;
const MAX_NAME_BYTES = 200;
const BREAKS = new Set([0x85, 0x2028, 0x2029, 0xfeff, 0x200b, 0x202e]);

const TYPE_EXTENSIONS = {
	'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/heic': 'heic',
	'application/pdf': 'pdf', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'text/csv': 'csv', 'text/plain': 'txt',
	'text/markdown': 'md', 'application/json': 'json', 'application/zip': 'zip',
};

/** The extension a content type stands for (`png`), or `''` when the table does not know it. */
export function extensionForType(type) {
	if (typeof type !== 'string') return '';
	return TYPE_EXTENSIONS[type.split(';')[0].trim().toLowerCase()] ?? '';
}

/**
 * `{ stem, ext }` of a file name: the extension is what follows the last dot when it is 1 to 8 letters or digits (and the dot is not the
 * first character); `ext` is `''` otherwise. The person-data scan skips an address that ends in an extension (`a@b.example.png` is
 * taken for a file name), so a name is scanned without its extension.
 */
export function splitExtension(name) {
	const text = typeof name === 'string' ? name : '';
	const dot = text.lastIndexOf('.');
	if (dot > 0 && EXTENSION.test(text.slice(dot + 1))) return { stem: text.slice(0, dot), ext: text.slice(dot + 1) };
	return { stem: text, ext: '' };
}

/**
 * Rule A for a file name: `{ value, flagged }`. The whole name is scanned (an address that ends the name, `jane@example.org`, is
 * taken for an extension below) and so is the stem without its extension (the person-data scan takes `a@b.example.png` for a
 * file name and skips it). A flagged name is redacted by whichever scan found something.
 */
export function redactFileName(name) {
	const text = typeof name === 'string' ? name : '';
	// Both scans, one after the other: what the whole-name scan leaves (a phone number was found, an address that ends in an
	// extension was skipped) is scanned again as a stem, so one finding never hides another.
	const whole = redactValue(text);
	const { stem, ext } = splitExtension(whole.value);
	const part = redactValue(stem);
	if (part.flagged) return { value: ext === '' ? part.value : `${part.value}.${ext}`, flagged: true };
	return { value: whole.value, flagged: whole.flagged };
}

/**
 * Whether a downloaded file is looked at for e-mail addresses and phone numbers. Pictures, video, audio, PDF and archives
 * are not (Van decided they go to Drive; their content cannot be scanned as text); anything else is, whatever type the
 * host gave it: a contacts file served as `application/octet-stream` is still text.
 */
const MEDIA_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'tif', 'tiff', 'ico', 'mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mp3', 'wav', 'm4a', 'ogg', 'pdf', 'glb', 'zip', 'gz', 'tgz', '7z', 'rar', 'xlsx', 'docx', 'pptx']);
export function needsTextScan(type, name) {
	const t = typeof type === 'string' ? type.split(';')[0].trim().toLowerCase() : '';
	if (t === 'image/svg+xml') return true;
	if (t.startsWith('image/') || t.startsWith('video/') || t.startsWith('audio/') || t === 'application/pdf' || t === 'application/zip') return false;
	const dot = name.lastIndexOf('.');
	return !(dot > 0 && MEDIA_EXTENSIONS.has(name.slice(dot + 1).toLowerCase()));
}

/**
 * A file name that is safe on every machine that syncs the folder: no path separator or `..`, none of the characters
 * Windows refuses, no control or line-end character, no leading dot (hidden file) or trailing dot or space, no device
 * name (`CON`), at most `maxStem` characters before the extension. The extension (up to 8 letters or digits) is kept
 * in lower case; with none, `fallbackExt` is used. An empty result becomes `upload`.
 */
export function safeFileName(original, { fallbackExt = '', maxStem = 80 } = {}) {
	const text = typeof original === 'string' ? original.normalize('NFC') : '';
	let cleaned = '';
	for (const ch of text) {
		const n = ch.codePointAt(0);
		cleaned += n < 0x20 || n === 0x7f || BREAKS.has(n) || FORBIDDEN.has(ch) ? '_' : ch;
	}
	cleaned = cleaned.split(' ').filter(Boolean).join(' ').trim();
	const split = splitExtension(cleaned);
	let stem = split.stem;
	let ext = split.ext.toLowerCase();
	while (stem.includes('..')) stem = stem.split('..').join('.');
	stem = stem.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
	if (ext === '' && typeof fallbackExt === 'string' && EXTENSION.test(fallbackExt)) ext = fallbackExt.toLowerCase();
	// At most `maxStem` characters and at most MAX_NAME_BYTES bytes in all (file systems count bytes: 255, and `-99999` may follow).
	stem = [...stem].slice(0, maxStem).join('');
	const room = MAX_NAME_BYTES - (ext === '' ? 0 : ext.length + 1) - 6;
	while (Buffer.byteLength(stem) > room) stem = [...stem].slice(0, -1).join('');
	stem = stem.replace(/[.\s]+$/, '');
	if (stem === '') stem = 'upload';
	if (RESERVED.test(stem.split('.')[0])) stem = `_${stem}`;
	return ext === '' ? stem : `${stem}.${ext}`;
}

/** `name`, or `stem-2.ext`, `stem-3.ext`, ... when `taken` (a set of lower-case names) has it: a folder on a Mac or on Windows does not tell `A.png` from `a.png`. Does not change `taken`. */
export function uniqueName(name, taken) {
	if (!taken.has(name.toLowerCase())) return name;
	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : '';
	for (let n = 2; ; n++) {
		const candidate = `${stem}-${n}${ext}`;
		if (!taken.has(candidate.toLowerCase())) return candidate;
	}
}

/** The file name in a Content-Disposition header (`filename*=UTF-8''...` first, then `filename="..."`, then a bare token), or null. */
export function dispositionFileName(header) {
	if (typeof header !== 'string') return null;
	const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
	if (star) {
		try {
			const value = decodeURIComponent(star[2].trim());
			if (value !== '') return value;
		} catch {
			// a bad escape: fall through to the plain form
		}
	}
	const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
	if (quoted) {
		const value = quoted[1].replace(/\\(.)/g, '$1');
		return value === '' ? null : value;
	}
	const bare = /filename\s*=\s*([^\s;]+)/i.exec(header);
	return bare ? bare[1] : null;
}

/** What an entry of a card's `files` list must look like: a plain object with the five fields below; anything else is not ours to read. */
export function isFileEntry(entry) {
	return (
		entry !== null && typeof entry === 'object' && !Array.isArray(entry)
		&& typeof entry.upload === 'string' && /^[0-9a-f]{16}$/.test(entry.upload)
		&& typeof entry.path === 'string' && entry.path !== '' && typeof entry.name === 'string'
		&& Number.isSafeInteger(entry.bytes) && entry.bytes >= 0
		&& typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256)
	);
}

/**
 * The path of an entry is `files/<issue id>/<name>`, or `raw/files/<issue id>/<name>` for a text file that stays local-only,
 * with plain parts (the folder is the card's ID when the file was saved: a card that moved teams since keeps its old folder,
 * so any issue ID is allowed there); false for anything that could leave the folder or name a hidden file.
 */
export function isSafeRelativePath(path) {
	if (typeof path !== 'string') return false;
	const parts = path.split('/');
	const head = parts[0] === 'raw' ? 2 : 1;
	if (parts.length !== head + 2 || parts[head - 1] !== 'files' || parseId(parts[head]) === null) return false;
	return isSafeName(parts[head + 1]);
}

/** A file name as `safeFileName` makes them, checked the other way round for a name read back from a card (which a person may have edited). */
export function isSafeName(name) {
	if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || name.startsWith('.') || /[. ]$/.test(name)) return false;
	if (Buffer.byteLength(name) > 255 || RESERVED.test(name.split('.')[0])) return false;
	return ![...name].some((ch) => {
		const n = ch.codePointAt(0);
		return FORBIDDEN.has(ch) || n < 0x20 || n === 0x7f || BREAKS.has(n);
	});
}
