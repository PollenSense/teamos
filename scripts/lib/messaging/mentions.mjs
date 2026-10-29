/**
 * @mentions: the rule that turns `@name` in a message body into a tag.
 *
 * Everything here is pure (no files), so the rule can be tested on its own; `file.mjs` applies it when a message
 * is sent, and `ui/src/lib/mentions.ts` repeats it for the compose preview (both are tested against
 * `mentions-cases.json`, so they cannot drift apart). The server decides; the preview is advice.
 *
 * A tag is `@name` in the body where
 *   - `name` is an active member of the roster (case-insensitive; the canonical spelling is stored),
 *   - the `@` starts the text or follows a space or an opening or separating mark, so `van@pollensense.com` and
 *     `https://host/@nate` are not tags,
 *   - the name does not run on into more letters, digits or an underscore (`@salary` is not `@sal`), and is not
 *     joined to more word by a hyphen or a dot (`@sal-ary`, `@sal.smith`), while `@sal.` and `@sal,` end a sentence,
 *   - it is not inside a code span, a fenced code block, or a `>` quote line, and is not the sender tagging themself.
 * Roster names are matched when they are one word of letters, digits and underscores (every member name today).
 */

/** What may stand directly before the `@`: the start of a line is handled separately, these are the marks. */
const BEFORE_OK = new Set([...' \t(["\'<{*_~,;:!?—–‘“-']);

const WORD = /^[A-Za-z0-9_]$/;

/** `text` with every character but the line breaks replaced by a space (same length, so positions line up). */
const blanked = (text) => text.replace(/[^\n]/g, ' ');

/**
 * Blank `from..to` of `chars` (an array of single characters), keeping line breaks.
 */
function blankRange(chars, from, to) {
	for (let i = from; i < to; i++) if (chars[i] !== '\n') chars[i] = ' ';
}

/**
 * Inline code spans (a run of backticks up to the next run of the same length, across lines of one paragraph) and
 * markdown links and images (`[text](address)`, text and address both) blanked out. One pass over the text with
 * cached lookups, so a long run of backticks or brackets costs time in proportion to its length, not its square.
 */
function maskInline(text) {
	const chars = [...text];
	// Code spans. A run with no later run of the same length is plain text.
	const runs = [];
	for (let i = 0; i < chars.length; ) {
		if (chars[i] !== '`') {
			i++;
			continue;
		}
		let j = i;
		while (chars[j] === '`') j++;
		runs.push({ start: i, len: j - i });
		i = j;
	}
	const byLen = new Map();
	runs.forEach((run, index) => {
		if (!byLen.has(run.len)) byLen.set(run.len, []);
		byLen.get(run.len).push(index);
	});
	const seen = new Map();
	for (let r = 0; r < runs.length; ) {
		const same = byLen.get(runs[r].len);
		let p = seen.get(runs[r].len) ?? 0;
		while (p < same.length && same[p] <= r) p++;
		seen.set(runs[r].len, p);
		if (p < same.length) {
			const close = runs[same[p]];
			blankRange(chars, runs[r].start, close.start + close.len);
			r = same[p] + 1;
		} else {
			r++;
		}
	}
	// Links and images, outside the code spans just blanked. `close` caches the next `]`; `parenGone` the fact
	// that no `)` is left anywhere, so an unclosed `[a](` repeated many times is not searched for each time.
	let close = -2;
	let parenGone = false;
	for (let i = 0; i < chars.length; ) {
		const open = chars[i] === '[' ? i : chars[i] === '!' && chars[i + 1] === '[' ? i + 1 : -1;
		if (open < 0) {
			i++;
			continue;
		}
		if (close < open) {
			close = chars.indexOf(']', open);
			if (close === -1) break;
		}
		if (chars[close + 1] === '(' && !parenGone) {
			const end = chars.indexOf(')', close + 2);
			if (end === -1) parenGone = true;
			else {
				blankRange(chars, i, end + 1);
				i = end + 1;
				continue;
			}
		}
		i = open + 1;
	}
	return chars.join('');
}

const FENCE = /^\s*(`{3,}|~{3,})/;
const QUOTE = /^\s*(?:(?:[-*+]|\d+[.)])\s+)*>/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const BLOCK_START = /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|(?:-{3,}|\*{3,}|_{3,})\s*$)/;

/**
 * The body with everything a tag may not live in blanked out (same length, so positions line up): fenced code blocks
 * (at any indent), indented code blocks, quote lines (also inside a list item, and the lazy lines that continue a
 * quote), inline code spans, and the text and address of markdown links and images. This follows what a markdown
 * renderer shows as code, quote or link, because the dashboard highlights a tag only where it shows as plain text;
 * where the two could disagree the rule skips, since a tag that is not made is visible on Send and one that is made
 * by accident is not.
 */
export function maskNonProse(body) {
	const lines = String(body ?? '').split('\n');
	const kept = [];
	let fence = null; // the fence characters that opened the block we are in
	let inQuote = false;
	let afterBlank = true;
	let afterList = false; // inside list content: indented lines there are not code
	let afterCode = false;
	for (const line of lines) {
		const open = line.match(FENCE);
		if (fence) {
			if (open && open[1][0] === fence[0] && open[1].length >= fence.length && line.trim() === open[1]) fence = null;
			kept.push(blanked(line));
			continue;
		}
		if (open) {
			fence = open[1];
			kept.push(blanked(line));
			inQuote = false;
			afterBlank = false;
			continue;
		}
		if (line.trim() === '') {
			kept.push(line);
			inQuote = false;
			afterBlank = true;
			afterCode = false;
			continue;
		}
		const quoted = QUOTE.test(line);
		const blockStart = BLOCK_START.test(line);
		const indented = /^(?: {4}|\t)/.test(line);
		if (quoted || (inQuote && !blockStart && !indented)) {
			kept.push(blanked(line));
			inQuote = true;
			afterBlank = false;
			continue;
		}
		inQuote = false;
		if (indented && (afterBlank || afterCode) && !afterList) {
			kept.push(blanked(line));
			afterCode = true;
			afterBlank = false;
			continue;
		}
		afterCode = false;
		afterBlank = false;
		if (LIST_ITEM.test(line)) afterList = true;
		else if (!indented) afterList = false;
		kept.push(line);
	}
	// Inline code and links within each paragraph (consecutive lines that were kept as text).
	const out = [];
	for (let i = 0; i < kept.length; ) {
		if (kept[i].trim() === '') {
			out.push(kept[i++]);
			continue;
		}
		let j = i;
		while (j < kept.length && kept[j].trim() !== '') j++;
		out.push(...maskInline(kept.slice(i, j).join('\n')).split('\n'));
		i = j;
	}
	return out.join('\n');
}

/**
 * The members tagged in `body`, canonical names in order of first appearance, without repeats.
 *
 * @param {string} body
 * @param {(string | { name: string, active?: boolean })[]} roster member names, or `{ name, active }` entries
 *   (`active: false` entries cannot be tagged)
 * @param {{ sender?: string }} [opts] `sender` is never tagged by their own message
 */
export function findMentions(body, roster, { sender } = {}) {
	const canonical = new Map();
	for (const entry of roster ?? []) {
		const name = typeof entry === 'string' ? entry : entry?.name;
		const active = typeof entry === 'string' ? true : entry?.active !== false;
		if (typeof name === 'string' && /^[A-Za-z0-9_]+$/.test(name) && active) canonical.set(name.toLowerCase(), name);
	}
	if (canonical.size === 0) return [];

	const text = maskNonProse(body);
	const found = [];
	const re = /@([A-Za-z0-9_]+)/g;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		const at = m.index;
		const before = at === 0 ? '\n' : text[at - 1];
		if (before !== '\n' && !BEFORE_OK.has(before)) continue;
		const after = text[at + m[0].length];
		const next = text[at + m[0].length + 1];
		// `@sal-ary` and `@sal.smith` are one word; `@sal.` and `@sal-` at the end of a phrase are not.
		if ((after === '-' || after === '.') && next !== undefined && WORD.test(next)) continue;
		if (after === '@') continue;
		const name = canonical.get(m[1].toLowerCase());
		if (name && name !== sender && !found.includes(name)) found.push(name);
	}
	return found;
}

/** Tagged names as stored in a frontmatter line (`mentions: [nate, van]`); anything else is no tag. */
export function readMentions(metadata) {
	const raw = metadata?.mentions;
	const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw.trim() ? [raw.trim()] : [];
	return list.filter((n) => typeof n === 'string' && n.length > 0);
}

/**
 * A message cannot be "nothing needed" and "please look" at once: a tag asks for attention, so a message marked
 * `fyi` that tags someone is refused (the sender writes the plain name instead, or drops the mark).
 */
export function refuseTagOnFyi(fyi, mentioned) {
	if (fyi === true && mentioned.length > 0) {
		throw Object.assign(
			new Error(
				`fyi cannot be combined with an @tag (${mentioned.map((n) => `@${n}`).join(', ')}): a tag asks the person to look. Write the plain name instead of the @, or drop fyi.`,
			),
			{ status: 400 },
		);
	}
}

/** Who must be added to Cc so every tagged member receives the message: the tagged who are not already in To or Cc. */
export function missingFromCc(mentioned, to, cc) {
	const have = new Set([...(to ?? []), ...(cc ?? [])]);
	return mentioned.filter((n) => !have.has(n));
}
