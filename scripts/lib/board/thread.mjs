import { BoardError } from './errors.mjs';
import { jsonLine } from './frontmatter.mjs';

/**
 * The thread file of an issue (`issues/<TEAM>/<ID>.thread.md`): its comments, imported and later native, one entry each.
 *
 *   ### 2025-02-01T09:00:00.000Z author name
 *   <!-- {"id":"cm-1","source":"linear","replyTo":"cm-0"} -->
 *   > first line of the comment
 *   >
 *   > third line
 *
 *   ### 2025-02-01T09:05:00.000Z another author
 *   ...
 *
 * An entry is a header line (`### ` + the time, one space, the author to the end of the line), one line with a JSON
 * object in an HTML comment (`id` and `source` always, `replyTo` when the comment answers another one), and the text with
 * every line prefixed `> ` (an empty line is a lone `>`). Because every text line starts with `>`, no line of a comment can
 * look like a header or a meta line; entries are told apart by a blank line. Unknown keys of the meta object are kept, so
 * a file written by a newer version loses nothing here.
 *
 * Every value that lands on the header or meta line is checked: the time is an ISO date, the author is one line,
 * ids and sources are plain names (letters, digits, `_`, `-`). A text may hold anything; its line breaks (`\r\n`, `\r`,
 * U+0085, U+2028, U+2029) all become line ends, so the file always has the line structure it shows.
 *
 * `parseThread` is strict: a line that belongs to no entry (a sync-conflict marker, a hand edit) is a `damaged` error,
 * so a caller never rewrites a file it did not understand.
 */

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TIME = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const HEADER = /^### (\S+) (.+)$/;
const META = /^<!-- (\{.*\}) -->$/;
const KNOWN_META = new Set(['id', 'source', 'replyTo']);

const LINE_BREAKS = new Set([0x0d, 0x85, 0x2028, 0x2029]);

/** True when `text` holds a character that ends a line or is a control character (so it cannot sit on one header line). */
function hasLineBreakOrControl(text) {
	for (const ch of text) {
		const n = ch.codePointAt(0);
		if (n < 0x20 || n === 0x7f || LINE_BREAKS.has(n)) return true;
	}
	return false;
}

/** The text split into lines on every kind of line end. */
export function splitLines(text) {
	let out = '';
	for (const ch of text.split('\r\n').join('\n')) out += LINE_BREAKS.has(ch.codePointAt(0)) ? '\n' : ch;
	return out.split('\n');
}

function check(entry, index) {
	const where = `thread entry ${index + 1}`;
	if (entry === null || typeof entry !== 'object') throw new BoardError('bad-value', `${where} is not an object`);
	if (typeof entry.time !== 'string' || !TIME.test(entry.time)) throw new BoardError('bad-value', `${where}: the time is not an ISO date`);
	if (typeof entry.author !== 'string' || entry.author.trim() === '' || hasLineBreakOrControl(entry.author)) throw new BoardError('bad-value', `${where}: the author is empty or not one line`);
	if (entry.author !== entry.author.trim()) throw new BoardError('bad-value', `${where}: the author has spaces at an end`);
	if (typeof entry.id !== 'string' || !NAME.test(entry.id)) throw new BoardError('bad-value', `${where}: the id is not a plain name`);
	if (typeof entry.source !== 'string' || !NAME.test(entry.source)) throw new BoardError('bad-value', `${where}: the source is not a plain name`);
	if (entry.replyTo !== undefined && (typeof entry.replyTo !== 'string' || !NAME.test(entry.replyTo))) throw new BoardError('bad-value', `${where}: replyTo is not a plain name`);
	if (typeof entry.body !== 'string') throw new BoardError('bad-value', `${where}: the text is not a string`);
	if (entry.extra !== undefined && (entry.extra === null || typeof entry.extra !== 'object' || Array.isArray(entry.extra))) throw new BoardError('bad-value', `${where}: extra is not an object`);
}

/** The file text for entries `{ time, author, id, source, replyTo?, body, extra? }`, in the order given. */
export function serializeThread(entries) {
	if (!Array.isArray(entries)) throw new BoardError('bad-value', 'a thread is a list of entries');
	const ids = new Set();
	const blocks = entries.map((entry, i) => {
		check(entry, i);
		if (ids.has(entry.id)) throw new BoardError('bad-value', `thread entry ${i + 1} repeats an id`);
		ids.add(entry.id);
		const meta = { id: entry.id, source: entry.source };
		if (entry.replyTo !== undefined) meta.replyTo = entry.replyTo;
		for (const [key, value] of Object.entries(entry.extra ?? {})) if (!KNOWN_META.has(key) && key !== '__proto__' && value !== undefined) meta[key] = value;
		const lines = splitLines(entry.body).map((line) => (line === '' ? '>' : `> ${line}`));
		return `### ${entry.time} ${entry.author}\n<!-- ${jsonLine(meta)} -->\n${lines.join('\n')}\n`; // jsonLine: a NaN or BigInt is refused, U+2028 and U+2029 are escaped (one line, and it reads back)
	});
	return blocks.join('\n');
}

/** `{ entries }` for a thread file's text; the text of an entry has its line ends as `\n`. Throws `damaged` for anything it does not understand. */
export function parseThread(text) {
	if (typeof text !== 'string') throw new BoardError('damaged', 'a thread file is not text');
	const lines = text.split(/\r?\n/); // a file that went through a CRLF editor or checkout reads the same as its LF form
	if (lines[lines.length - 1] === '') lines.pop();
	const entries = [];
	let i = 0;
	const damaged = (what, at) => new BoardError('damaged', `thread file: ${what} (line ${at + 1})`);
	while (i < lines.length) {
		if (lines[i] === '') {
			i++;
			continue;
		}
		const header = HEADER.exec(lines[i]);
		if (!header || !TIME.test(header[1]) || header[2] !== header[2].trim() || hasLineBreakOrControl(header[2])) throw damaged('a line that is not an entry header', i);
		const metaLine = META.exec(lines[i + 1] ?? '');
		if (!metaLine) throw damaged('an entry header without its meta line', i + 1);
		let meta;
		try {
			meta = JSON.parse(metaLine[1]);
		} catch {
			throw damaged('a meta line that is not JSON', i + 1);
		}
		if (meta === null || typeof meta !== 'object' || Array.isArray(meta) || typeof meta.id !== 'string' || !NAME.test(meta.id) || typeof meta.source !== 'string' || !NAME.test(meta.source) || (meta.replyTo !== undefined && (typeof meta.replyTo !== 'string' || !NAME.test(meta.replyTo)))) {
			throw damaged('a meta line without a valid id and source', i + 1);
		}
		const body = [];
		let at = i + 2;
		for (; at < lines.length && lines[at] !== ''; at++) {
			if (lines[at] === '>') body.push('');
			else if (lines[at].startsWith('> ')) body.push(lines[at].slice(2));
			else throw damaged('a text line that does not start with ">"', at);
		}
		if (body.length === 0) throw damaged('an entry without text lines', at);
		const extra = {};
		for (const [key, value] of Object.entries(meta)) if (!KNOWN_META.has(key) && key !== '__proto__') extra[key] = value;
		const entry = { time: header[1], author: header[2], id: meta.id, source: meta.source, ...(meta.replyTo === undefined ? {} : { replyTo: meta.replyTo }), body: body.join('\n') };
		if (Object.keys(extra).length > 0) entry.extra = extra;
		entries.push(entry);
		i = at;
	}
	return { entries };
}
