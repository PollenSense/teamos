import { createHash } from 'node:crypto';
import { BoardError } from './errors.mjs';

/**
 * Front matter for board files: `---`, one `key: <JSON>` line per field, `---`, then the body.
 *
 *   ---
 *   id: "PSE-1061"
 *   title: "[x] a title: with \"quotes\""
 *   labels: ["Bug","Portal"]
 *   relations: {"blocks":["PSE-1070"]}
 *   ---
 *
 *   The description.
 *
 * Every value is one line of JSON, read back with JSON.parse. TeamOS's own `parseFrontmatter`
 * (messaging/file.mjs) is line-based: it reads nested values as strings and a title like `[x] foo` as a list, which
 * is why the board has this small reader and writer beside it (no YAML dependency, same file style).
 *
 * Reading is tolerant, because these files sync through Drive and people edit them by hand: a value that is not
 * JSON (`status: In Review`) reads as that text, with a warning; a line that is not `key: value`, a repeated key
 * and a key named `__proto__` are dropped, with a warning. The next write normalises all of it.
 *
 * U+2028 and U+2029 are written as escapes: JSON allows them raw, but some editors and tools treat them as line
 * breaks. `\n` and `\r` inside a value are always escaped by JSON, so a field never spans two lines.
 */

const KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);
const BOM = String.fromCharCode(0xfeff);
const OPEN = new RegExp(`^${BOM}?---[ \\t]*\\r?\\n`);

/** One value as one line of JSON, or undefined when the field is to be left out (value undefined). */
export function jsonLine(value) {
	if (value === undefined) return undefined;
	const text = JSON.stringify(value, (key, v) => {
		if (typeof v === 'number' && !Number.isFinite(v)) throw new BoardError('bad-value', `front-matter value for ${JSON.stringify(key)} is not a finite number`);
		if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') throw new BoardError('bad-value', `front-matter value for ${JSON.stringify(key)} is a ${typeof v}`);
		return v;
	});
	return text.split(LINE_SEP).join('\\u2028').split(PARA_SEP).join('\\u2029');
}

/** The lines of a front-matter block (no delimiters), in the object's key order. */
export function serializeFields(fields) {
	let out = '';
	for (const [key, value] of Object.entries(fields)) {
		if (!KEY.test(key) || key === '__proto__') throw new BoardError('bad-value', `front-matter key ${JSON.stringify(key)} is not a name (letters, digits, _)`);
		const line = jsonLine(value);
		if (line !== undefined) out += `${key}: ${line}\n`;
	}
	return out;
}

/** A whole file. The body follows a blank line; a body that itself starts with a newline keeps it. */
export function serializeDocument(fields, body = '') {
	return `---\n${serializeFields(fields)}---\n\n${body}`;
}

function parseLines(lines, warnings) {
	const fields = {};
	for (const raw of lines) {
		if (raw.trim() === '') continue;
		const colon = raw.indexOf(':');
		const key = colon > 0 ? raw.slice(0, colon) : '';
		if (!KEY.test(key) || key === '__proto__') {
			warnings.push(`line dropped: not a "key: value" line (${key === '__proto__' ? 'key __proto__' : `${raw.length} characters`})`);
			continue;
		}
		const text = raw.slice(colon + 1).trim();
		let value;
		try {
			value = JSON.parse(text);
		} catch {
			value = text;
			warnings.push(`${key}: not JSON, kept as text`);
		}
		if (Object.hasOwn(fields, key)) warnings.push(`${key}: repeated, the last one wins`);
		fields[key] = value;
	}
	return fields;
}

/**
 * `{ fields, body, warnings }` for a file's text. Throws a `damaged` error when the text has no front matter
 * (a truncated file or a sync conflict marker), so the caller never mistakes it for an empty card.
 */
export function parseDocument(text) {
	const open = OPEN.exec(text);
	if (!open) throw new BoardError('damaged', 'no front matter (the file does not start with ---)');
	const rest = text.slice(open[0].length);
	const lines = [];
	let at = 0;
	for (;;) {
		if (at > rest.length) throw new BoardError('damaged', 'front matter is not closed (no second --- line)');
		let end = rest.indexOf('\n', at);
		const last = end === -1;
		if (last) end = rest.length;
		const line = rest.slice(at, end).replace(/\r$/, '');
		if (line.trimEnd() === '---') {
			let body = last ? '' : rest.slice(end + 1);
			if (body.startsWith('\r\n')) body = body.slice(2);
			else if (body.startsWith('\n')) body = body.slice(1);
			const warnings = [];
			return { fields: parseLines(lines, warnings), body, warnings };
		}
		if (last) throw new BoardError('damaged', 'front matter is not closed (no second --- line)');
		lines.push(line);
		at = end + 1;
	}
}

/** The front matter of a file's first bytes: `{ fields, warnings }`, or null when the block is not closed in `head`. */
export function parseHead(head) {
	try {
		const { fields, warnings } = parseDocument(head);
		return { fields, warnings };
	} catch (err) {
		if (err instanceof BoardError) return null;
		throw err;
	}
}

/** The content hash a writer compares before it replaces a file (sha-256 of the text, hex). */
export function contentHash(text) {
	return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * The fields a rewrite writes. `known` are the fields the writer owns: they come from `incoming` only, so one that
 * is missing there is removed (Linear cleared the milestone). Every other field in `existing` is kept, so a file
 * written by a newer version of the board loses nothing when an older one rewrites it. Known fields first, in
 * `known` order, then kept ones in their old order, then new extras.
 */
export function mergeFields(existing, incoming, known) {
	const out = {};
	const given = (key) => Object.hasOwn(incoming, key) && incoming[key] !== undefined; // own keys only: `constructor` and `toString` are field names too
	for (const key of known) if (given(key)) out[key] = incoming[key];
	const knownSet = new Set(known);
	for (const [key, value] of Object.entries(existing ?? {})) {
		if (!knownSet.has(key) && !given(key)) out[key] = value;
	}
	for (const [key, value] of Object.entries(incoming)) {
		if (!knownSet.has(key) && value !== undefined) out[key] = value;
	}
	return out;
}
