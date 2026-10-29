/**
 * Inbox sections, browser side.
 *
 * A member's mail is cut into **Needs you** (an open question for them, a reply the sender asked for, an @tag, or a pin),
 * **FYI** (the rest of the inbox), **Done** (the archive) and **Sent**. The server decides what needs the member
 * (`needs` on a message, `needsCount` on a thread; rules in `scripts/lib/messaging/inbox-rules.mjs`); this file
 * only sorts threads into the four lists and words the labels. Everything here is pure so it can be tested
 * without a browser; the lists are drawn by `components/Mailbox.svelte`.
 */
import type { NeedsReason, Thread } from './types.js';

export type Section = 'needs' | 'fyi' | 'done' | 'sent';

export const SECTIONS: readonly Section[] = ['needs', 'fyi', 'done', 'sent'];

export const SECTION_LABEL: Record<Section, string> = { needs: 'Needs you', fyi: 'FYI', done: 'Done', sent: 'Sent' };

type Counted = Pick<Thread, 'inboxCount' | 'sentCount' | 'archiveCount' | 'needsCount'>;

/**
 * Is the thread listed in `section`? A thread with something that needs the member is in Needs you and not in FYI,
 * so it is never listed twice among the two inbox sections; Done and Sent list a thread that has any archived or
 * sent message, as the old Archived and Sent filters did.
 */
export function inSection(t: Counted, section: Section): boolean {
	switch (section) {
		case 'needs':
			return t.needsCount > 0;
		case 'fyi':
			return t.needsCount === 0 && t.inboxCount > 0;
		case 'done':
			return t.archiveCount > 0;
		case 'sent':
			return t.sentCount > 0;
	}
}

/** The first section that lists the thread (the tag on a row when a search spans all of them); null for none. */
export function sectionOf(t: Counted): Section | null {
	return SECTIONS.find((s) => inSection(t, s)) ?? null;
}

export interface SectionCounts {
	/** Messages that need the member: the one number on the Needs you segment, the member card and the Messages tab. */
	needs: number;
	/** Conversations, like the other lists (one row each). */
	fyi: number;
	done: number;
	sent: number;
	needsMessages: number;
}

/**
 * Needs you counts messages, so its number is the same on the segment, the member card and the Messages tab (a row
 * that holds three of them says "3 need you"); FYI, Done and Sent count conversations, one row each.
 */
export function sectionCounts(threads: Counted[]): SectionCounts {
	return {
		needs: threads.reduce((n, t) => n + t.needsCount, 0),
		fyi: threads.filter((t) => inSection(t, 'fyi')).length,
		done: threads.filter((t) => inSection(t, 'done')).length,
		sent: threads.filter((t) => inSection(t, 'sent')).length,
		needsMessages: threads.reduce((n, t) => n + t.needsCount, 0),
	};
}

/**
 * The section to land on when the member has not picked one: Needs you, or the first one with something in it,
 * so a first look never ends on an empty list while there is mail to read.
 */
export function defaultSection(threads: Counted[]): Section {
	return SECTIONS.find((s) => threads.some((t) => inSection(t, s))) ?? 'needs';
}

/**
 * A section name read back from storage. The old filters map to their nearest section (`inbox` -> Needs you,
 * `archives` -> Done); `all` and anything unknown mean "no pick".
 */
export function storedSection(value: string | null | undefined): Section | null {
	if (value === 'inbox') return 'needs';
	if (value === 'archives') return 'done';
	return SECTIONS.find((s) => s === value) ?? null;
}

/** The text a search is run against on the thread itself; archived message text is searched by the server. */
export function matchesSearch(t: Pick<Thread, 'subject' | 'preview' | 'participants' | 'projectCodes' | 'messages'>, q: string, archiveHits: ReadonlySet<string>): boolean {
	const needle = q.trim().toLowerCase();
	if (!needle) return true;
	return (
		t.subject.toLowerCase().includes(needle) ||
		t.preview.toLowerCase().includes(needle) ||
		t.participants.some((p) => p.toLowerCase().includes(needle)) ||
		t.projectCodes.some((p) => p.toLowerCase().includes(needle)) ||
		t.messages.some((m) => archiveHits.has(m.id))
	);
}

/** "2 need you" on the member card; "1 needs van" on someone else's. */
export function needsLabel(member: string, viewer: string | null | undefined, n: number): string {
	return `${n} ${n === 1 ? 'needs' : 'need'} ${member === viewer ? 'you' : member}`;
}

const REASON_WORDS: Record<NeedsReason, string> = { card: 'open question', reply: 'reply wanted', mention: 'tagged you', pin: 'pinned' };

/** "open question, pinned": why a message needs the member, for a badge title. */
export function reasonsText(reasons: readonly NeedsReason[] | undefined): string {
	return (reasons ?? []).map((r) => REASON_WORDS[r] ?? r).join(', ');
}

/**
 * The reasons shown on a thread row, one badge each: why the thread is in Needs you when the question chip does not
 * already say so (`card` is the chip's job). In the order wanted reply, tagged, pin.
 */
export function rowReasons(t: Pick<Thread, 'messages'>): NeedsReason[] {
	const all = new Set(t.messages.flatMap((m) => m.needs ?? []));
	return (['reply', 'mention', 'pin'] as const).filter((r) => all.has(r));
}

/** The words for one reason badge ("reply wanted", "pinned", "open question"). */
export function reasonWord(r: NeedsReason): string {
	return REASON_WORDS[r] ?? r;
}

/** The badge a message shows for the sender's mark, or null for none. */
export function markBadge(m: { fyi?: boolean; expectsReply?: boolean }): { label: string; title: string } | null {
	if (m.expectsReply) return { label: 'reply wanted', title: 'The sender asked for a written reply' };
	if (m.fyi) return { label: 'FYI', title: 'The sender says nothing is needed from you' };
	return null;
}
