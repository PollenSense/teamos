/**
 * Inbox sections: which of a member's inbox messages need them and which are for information.
 *
 * Everything here is pure (no files), so the rules can be tested on their own; the adapter feeds it what it
 * read. The sections are a view over the inbox, nothing moves on disk because of them.
 *
 * A message from the inbox is in **Needs you** (`needsReasons` is not empty) when
 *   - `card`:  an open question on it waits on the member (the cards' `waitingOn`), or
 *   - `reply`: the sender marked it `expectsReply`, the member is one of its To recipients (a Cc is not asked to
 *              reply) and has not replied in the thread since, or
 *   - `mention`: the sender tagged the member with `@name` (stored as `mentions`, see mentions.mjs), in To or Cc, and
 *              the member has not replied in the thread since (the same test as `reply`), or
 *   - `pin`:   the member pinned it ("Needs me").
 * Everything else is **FYI**. A message the sender marked `fyi: true` says so; one with neither mark is
 * unmarked (an FYI that ages out more slowly once automatic archiving exists).
 */

export const NEEDS_REASONS = ['card', 'reply', 'mention', 'pin'];

/**
 * The marks of a message about to be sent: `{ fyi?: true, expectsReply?: true }`.
 * Both set is a mistake (a message cannot be "nothing needed" and "reply please"); a non-boolean is refused
 * rather than guessed at.
 */
export function validateMarks({ fyi, expectsReply } = {}) {
	const bad = (message) => Object.assign(new Error(message), { status: 400 });
	for (const [name, value] of [['fyi', fyi], ['expectsReply', expectsReply]]) {
		if (value !== undefined && value !== null && typeof value !== 'boolean') throw bad(`${name} must be true or false`);
	}
	if (fyi === true && expectsReply === true) throw bad('fyi and expectsReply cannot both be true: a message either needs nothing or asks for a reply');
	return { ...(fyi === true ? { fyi: true } : {}), ...(expectsReply === true ? { expectsReply: true } : {}) };
}

/** Marks as stored in a frontmatter line (`fyi: true`); anything but the word `true` is no mark. */
export function readMarks(metadata) {
	const on = (v) => v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');
	const fyi = on(metadata?.fyi);
	const expectsReply = on(metadata?.expectsReply);
	// A hand-edited file with both marks: the stricter one wins, so an ask is never read as "nothing needed".
	return expectsReply ? { expectsReply: true } : fyi ? { fyi: true } : {};
}

/**
 * Why `msg` is in Needs you for `member`: a list of reasons from NEEDS_REASONS, empty when it is FYI.
 *
 * @param {{ id: string, from: string, to?: string[], expectsReply?: boolean, mentions?: string[] }} msg a message in the member's inbox
 * @param {string} member
 * @param {{ cards?: Set<string>, replied?: Set<string>, pinned?: Set<string> }} facts
 *   `cards`: ids of messages with an open question waiting on `member`; `replied`: ids of messages the member has
 *   replied to (or to a message below them); `pinned`: ids the member pinned.
 */
export function needsReasons(msg, member, { cards = new Set(), replied = new Set(), pinned = new Set() } = {}) {
	const reasons = [];
	if (cards.has(msg.id)) reasons.push('card');
	if (msg.expectsReply && msg.from !== member && msg.to?.includes(member) && !replied.has(msg.id)) reasons.push('reply');
	if (msg.mentions?.includes(member) && msg.from !== member && !replied.has(msg.id)) reasons.push('mention');
	if (pinned.has(msg.id)) reasons.push('pin');
	return reasons;
}

/**
 * The ids a member has replied to: every ancestor, through `replyTo`, of each message they sent. A reply to a
 * reply counts for the whole chain above it ("I answered in the thread").
 *
 * @param {{ id: string, replyTo?: string }[]} sent the member's sent messages
 * @param {(id: string) => string | undefined | Promise<string | undefined>} parentOf the `replyTo` of any message in the store (undefined when none)
 */
export async function repliedIds(sent, parentOf) {
	const replied = new Set();
	for (const msg of sent) {
		let cur = msg.replyTo;
		const seen = new Set([msg.id]);
		// Stops at a message already known: its ancestors were added when it was. `seen` guards a hand-edited loop.
		while (cur && !replied.has(cur) && !seen.has(cur)) {
			replied.add(cur);
			seen.add(cur);
			cur = await parentOf(cur);
		}
	}
	return replied;
}

/**
 * Sections for a whole inbox: `Map(id -> reasons)` for every message in it (empty reasons = FYI).
 * Messages the sender superseded are not in the inbox listing, so they never reach here.
 */
export function classifyInbox(entries, member, facts) {
	return new Map(entries.map((msg) => [msg.id, needsReasons(msg, member, facts)]));
}

/** How many of the classified messages need the member. */
export function countNeeds(classified) {
	let n = 0;
	for (const reasons of classified.values()) if (reasons.length > 0) n++;
	return n;
}

/**
 * Does a message match the text a person typed in the Done search? Case-insensitive, over subject, body, people
 * and project code. Short needles (under 2 characters) match nothing, so one keystroke does not read every
 * archived message.
 */
export function textMatches(msg, needle) {
	const q = (needle ?? '').trim().toLowerCase();
	if (q.length < 2) return false;
	const hay = [msg.subject, msg.body, msg.from, ...(msg.to ?? []), ...(msg.cc ?? []), msg.projectCode];
	return hay.some((part) => typeof part === 'string' && part.toLowerCase().includes(q));
}
