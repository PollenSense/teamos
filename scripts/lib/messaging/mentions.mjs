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

/**
 * The body with everything a tag may not live in blanked out (same length, so positions line up): fenced code
 * blocks, inline code spans, and quote lines.
 */
export function maskNonProse(body) {
	const lines = String(body ?? '').split('\n');
	let fence = null; // the fence characters that opened the block we are in
	return lines
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
			// Inline code: a run of backticks up to the next run of the same length.
			return line.replace(/(`+)(?:(?!\1)[\s\S])*?\1(?!`)/g, (span) => ' '.repeat(span.length));
		})
		.join('\n');
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
