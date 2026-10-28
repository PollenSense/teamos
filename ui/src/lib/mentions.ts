/**
 * @mentions, browser side.
 *
 * The server decides who a message tags (`scripts/lib/messaging/mentions.mjs`, applied when the message is sent);
 * this file repeats the same rule so the compose box can show the effect before Send, offers the names while a
 * person types `@`, and finds the tags to highlight in a sent message. Both are tested against one table,
 * `scripts/lib/messaging/mentions-cases.json`, so they cannot drift apart. Everything here is pure (no DOM).
 */

export interface Roster {
	name: string;
	title?: string;
	active?: boolean;
}

/** What may stand directly before the `@` (the start of a line is handled separately). */
const BEFORE_OK = new Set([...' \t(["\'<{*_~,;:!?—–‘“-']);
const WORD = /^[A-Za-z0-9_]$/;

/** The body with fenced code blocks, inline code spans and `>` quote lines blanked out (same length). */
export function maskNonProse(body: string): string {
	let fence: string | null = null;
	return String(body ?? '')
		.split('\n')
		.map((line) => {
			const open = line.match(/^\s{0,3}(`{3,}|~{3,})/);
			if (fence) {
				if (open && open[1][0] === fence[0] && open[1].length >= fence.length && line.trim() === open[1]) fence = null;
				return ' '.repeat(line.length);
			}
			if (open) {
				fence = open[1];
				return ' '.repeat(line.length);
			}
			if (/^\s{0,3}>/.test(line)) return ' '.repeat(line.length);
			return line.replace(/(`+)(?:(?!\1)[\s\S])*?\1(?!`)/g, (span) => ' '.repeat(span.length));
		})
		.join('\n');
}

function canonicalNames(roster: readonly (Roster | string)[] | undefined): Map<string, string> {
	const canonical = new Map<string, string>();
	for (const entry of roster ?? []) {
		const name = typeof entry === 'string' ? entry : entry?.name;
		const active = typeof entry === 'string' ? true : entry?.active !== false;
		if (typeof name === 'string' && /^[A-Za-z0-9_]+$/.test(name) && active) canonical.set(name.toLowerCase(), name);
	}
	return canonical;
}

/** Is the `@` at `at` a place a tag may start, and does the word after it end where a name may end? */
function tagBoundaries(text: string, at: number, wordLength: number): boolean {
	const before = at === 0 ? '\n' : text[at - 1];
	if (before !== '\n' && !BEFORE_OK.has(before)) return false;
	const after = text[at + 1 + wordLength];
	const next = text[at + 2 + wordLength];
	if ((after === '-' || after === '.') && next !== undefined && WORD.test(next)) return false;
	return after !== '@';
}

/** The members tagged in `body`: canonical names in order of first appearance, without repeats (same rule as the server). */
export function findMentions(body: string, roster: readonly (Roster | string)[] | undefined, opts: { sender?: string } = {}): string[] {
	const canonical = canonicalNames(roster);
	if (canonical.size === 0) return [];
	const text = maskNonProse(body);
	const found: string[] = [];
	for (const m of text.matchAll(/@([A-Za-z0-9_]+)/g)) {
		if (!tagBoundaries(text, m.index as number, m[1].length)) continue;
		const name = canonical.get(m[1].toLowerCase());
		if (name && name !== opts.sender && !found.includes(name)) found.push(name);
	}
	return found;
}

/**
 * What Send will do with the tags, for the preview: who is tagged and who the server will add to Cc (the tagged who
 * are in neither To nor Cc). Advice only; the server decides.
 */
export function previewTags(
	body: string,
	roster: readonly (Roster | string)[] | undefined,
	opts: { sender?: string; to?: readonly string[]; cc?: readonly string[] } = {},
): { mentioned: string[]; addedToCc: string[] } {
	const mentioned = findMentions(body, roster, { sender: opts.sender });
	const have = new Set([...(opts.to ?? []), ...(opts.cc ?? [])]);
	return { mentioned, addedToCc: mentioned.filter((n) => !have.has(n)) };
}

export interface ActiveTag {
	/** Index of the `@` in the text. */
	start: number;
	/** The caret: the end of what was typed after the `@`. */
	end: number;
	/** What was typed after the `@` (may be empty). */
	query: string;
}

/**
 * The `@word` being typed at `caret`, or null: the letters before the caret run back to an `@` that may start a
 * tag, outside code and quotes. `@` alone gives an empty query (show everyone).
 */
export function activeTag(text: string, caret: number): ActiveTag | null {
	let i = caret;
	while (i > 0 && /[A-Za-z0-9_]/.test(text[i - 1])) i--;
	if (i === 0 || text[i - 1] !== '@') return null;
	const start = i - 1;
	const before = start === 0 ? '\n' : text[start - 1];
	if (before !== '\n' && !BEFORE_OK.has(before)) return null;
	if (maskNonProse(text)[start] !== '@') return null;
	return { start, end: caret, query: text.slice(i, caret) };
}

/** Members to offer for what was typed: active, not the sender, name starting with the query first, then containing it. */
export function suggestions(query: string, roster: readonly Roster[], opts: { sender?: string; limit?: number } = {}): Roster[] {
	const q = query.toLowerCase();
	const pool = roster.filter((m) => m.active !== false && m.name !== opts.sender && /^[A-Za-z0-9_]+$/.test(m.name));
	const starts = pool.filter((m) => m.name.toLowerCase().startsWith(q));
	const contains = pool.filter((m) => !m.name.toLowerCase().startsWith(q) && m.name.toLowerCase().includes(q));
	const byName = (a: Roster, b: Roster) => a.name.localeCompare(b.name);
	return [...starts.sort(byName), ...contains.sort(byName)].slice(0, opts.limit ?? 6);
}

/** The text with the typed `@word` replaced by `@name ` and the caret just after it. */
export function completeTag(text: string, tag: ActiveTag, name: string): { text: string; caret: number } {
	const insert = `@${name} `;
	const rest = text.slice(tag.end);
	// A space already after the caret is reused so completing in the middle of a line does not double it.
	const tail = rest.startsWith(' ') ? rest.slice(1) : rest;
	return { text: text.slice(0, tag.start) + insert + tail, caret: tag.start + insert.length };
}

/** The "@ Tag" button: put an `@` at the caret (after a space unless the caret is at a boundary) and leave the caret behind it. */
export function insertAtSign(text: string, caret: number): { text: string; caret: number } {
	const at = Math.max(0, Math.min(caret, text.length));
	const before = text.slice(0, at);
	const lead = before === '' || /[\s(\[{"'\u2018\u201c]$/.test(before) ? '' : ' ';
	return { text: `${before}${lead}@${text.slice(at)}`, caret: before.length + lead.length + 1 };
}

export type TagPart = { text: string } | { mention: string; text: string };

/**
 * One run of plain text cut into plain parts and the tags of `names` (the message's `mentions`), for the viewer to
 * highlight. Same boundary rules as the server; the start of the run counts as a boundary (it may follow markup).
 */
export function splitMentions(text: string, names: readonly string[] | undefined): TagPart[] {
	const canonical = canonicalNames(names);
	if (canonical.size === 0) return [{ text }];
	const parts: TagPart[] = [];
	let last = 0;
	for (const m of text.matchAll(/@([A-Za-z0-9_]+)/g)) {
		const at = m.index as number;
		const name = canonical.get(m[1].toLowerCase());
		if (!name || !tagBoundaries(text, at, m[1].length)) continue;
		if (at > last) parts.push({ text: text.slice(last, at) });
		parts.push({ mention: name, text: m[0] });
		last = at + m[0].length;
	}
	if (last < text.length) parts.push({ text: text.slice(last) });
	return parts.length > 0 ? parts : [{ text }];
}
