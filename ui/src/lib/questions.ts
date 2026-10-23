/**
 * Question cards, browser side.
 *
 * A message can ask questions (`questions` in its frontmatter; the rules and the state fold live in
 * `scripts/lib/messaging/questions.mjs`). The server sends each one with its state (`questionState`); a
 * card shows the question and its options, and a tap becomes an answers reply to the asker. Everything here is
 * pure so it can be tested without a browser; the card itself is `components/QuestionCards.svelte`.
 */

export interface Question {
	id: string;
	text: string;
	options: { label: string; description?: string }[];
	recommend: number;
	waitingOn: string[];
}

export interface QuestionAnswer {
	kind: 'option' | 'other' | 'dismissed';
	option?: number;
	other?: string;
	by: string;
	recordedBy?: string;
	via?: string;
	at: string;
	messageId: string;
}

export interface QuestionState extends Question {
	status: 'open' | 'answered' | 'dismissed';
	answer: QuestionAnswer | null;
	also: QuestionAnswer[];
	earlier: QuestionAnswer[];
	reopens: number;
	reopenReason: string | null;
	reopenedAt: string | null;
	conflict: boolean;
}

export interface WaitingItem {
	askId: string;
	q: string;
	text: string;
	asker: string;
	subject: string;
	since: string;
	reopened?: string;
	options: { label: string; description?: string }[];
	recommend: number;
}

/** One entry of an answers request; the server adds the ask id and the sender. */
export type AnswerInput = { q: string; option: number } | { q: string; other: string } | { q: string; dismissed: true };

/** What the viewer has picked on a card but not sent yet. */
export type Choice = { kind: 'option'; option: number } | { kind: 'other'; other: string };

/** The people a message was sent to (To and Cc): the only ones who may answer, and the asker may not. */
export function mayAnswer(message: { from: string; to: string[]; cc?: string[] }, me: string | null | undefined): boolean {
	if (!me || me === message.from) return false;
	return message.to.includes(me) || (message.cc ?? []).includes(me);
}

/** "option 2, Sky" or "other: text" or "dismissed", for a line under a card. */
export function answerText(answer: QuestionAnswer, question: Question): string {
	if (answer.kind === 'dismissed') return 'dismissed';
	if (answer.kind === 'other') return `other: ${answer.other ?? ''}`;
	const label = question.options[(answer.option ?? 0) - 1]?.label;
	return `option ${answer.option}${label ? `, ${label}` : ''}`;
}

/** "Answered by Van: option 2, Sky" (and "recorded by Ivy" when the asker wrote it down). */
export function answeredLine(answer: QuestionAnswer, question: Question): string {
	const verb = answer.kind === 'dismissed' ? 'Dismissed by' : 'Answered by';
	const what = answer.kind === 'dismissed' ? '' : `: ${answerText(answer, question)}`;
	const recorded = answer.recordedBy ? ` (recorded by ${answer.recordedBy} from their reply)` : '';
	return `${verb} ${answer.by}${what}${recorded}`;
}

/** The entries to send: every open question the viewer picked something for, in question order. */
export function buildAnswers(states: QuestionState[], picks: Record<string, Choice | undefined>): AnswerInput[] {
	const out: AnswerInput[] = [];
	for (const q of states) {
		const pick = picks[q.id];
		if (q.status !== 'open' || !pick) continue;
		if (pick.kind === 'option') out.push({ q: q.id, option: pick.option });
		else if (pick.other.trim()) out.push({ q: q.id, other: pick.other.trim() });
	}
	return out;
}

/** A tap sends at once when it is the only question still open; otherwise taps select and one button sends them all. */
export function sendsOnTap(states: QuestionState[]): boolean {
	return states.filter((q) => q.status === 'open').length === 1;
}

export type ChipTone = 'waiting' | 'mine' | 'done';

/**
 * The chip on a thread row: "2 waiting on kris" (amber), "waiting on you" (stronger amber, `mine`) when the viewer
 * is one of those waited on, "answered" (green) when every question has an answer, or nothing.
 */
export function threadChip(
	questions: { open: number; total: number; waitingOn: string[] } | undefined,
	viewer: string | null | undefined,
): { label: string; tone: ChipTone } | null {
	if (!questions || questions.total === 0) return null;
	if (questions.open === 0) return { label: 'answered', tone: 'done' };
	const mine = !!viewer && questions.waitingOn.includes(viewer);
	const who = mine ? 'you' : questions.waitingOn.slice(0, 2).join(', ') + (questions.waitingOn.length > 2 ? ` +${questions.waitingOn.length - 2}` : '');
	const count = questions.open === 1 ? '' : `${questions.open} `;
	const answered = questions.total - questions.open;
	const partial = answered > 0 ? ` (${answered} of ${questions.total} answered)` : '';
	return { label: `${count}waiting on ${who}${partial}`, tone: mine ? 'mine' : 'waiting' };
}

/** Title of the pinned strip: "Waiting on you (3)" for the viewer's own mailbox, "Waiting on kris (3)" for another's. */
export function waitingTitle(member: string, viewer: string | null | undefined, n: number): string {
	return `Waiting on ${member === viewer ? 'you' : member} (${n})`;
}

/** Day and time for a card line: "Tue 14:05". */
export function shortWhen(iso: string, now = new Date()): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return '';
	const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
	const sameDay = d.toDateString() === now.toDateString();
	return sameDay ? time : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}
