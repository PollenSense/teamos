<script lang="ts">
import { api } from '../lib/api.js';
import {
	type Choice,
	type QuestionState,
	answeredLine,
	answerText,
	buildAnswers,
	mayAnswer,
	sendsOnTap,
	shortWhen,
} from '../lib/questions.js';
import type { Message } from '../lib/types.js';

/**
 * The cards of a message that asks questions: the question, its options as large tap targets (the
 * recommended one tagged), an "Other" box, and where it stands. A viewer who was sent the message (and did not
 * ask it) can answer; everyone else sees the state read-only. When only one question is still open a tap
 * sends at once; with several, taps select and one "Send N answers" button sends them as one reply to the asker.
 */
const {
	message,
	me,
	onchanged,
}: {
	message: Pick<Message, 'id' | 'from' | 'to' | 'cc' | 'questions' | 'questionState'>;
	me: string | null | undefined;
	onchanged?: () => void;
} = $props();

/** The states from the server, or every question open when the server sent none (then nobody can answer). */
const states = $derived<QuestionState[]>(
	message.questionState ??
		(message.questions ?? []).map((q) => ({
			...q,
			status: 'open' as const,
			answer: null,
			also: [],
			earlier: [],
			reopens: 0,
			reopenReason: null,
			reopenedAt: null,
			conflict: false,
		})),
);
const canAnswer = $derived(!!message.questionState && mayAnswer(message, me));
const isAsker = $derived(!!me && me === message.from);
const tapSends = $derived(sendsOnTap(states));

let choices = $state<Record<string, Choice | undefined>>({});
let otherText = $state<Record<string, string>>({});
let busy = $state(false);
let error = $state<string | null>(null);

const pending = $derived(buildAnswers(states, choices));

async function send(entries: ReturnType<typeof buildAnswers>) {
	if (!me || entries.length === 0 || busy) return;
	busy = true;
	error = null;
	try {
		await api.answerQuestions(message.id, entries, me);
		choices = {};
		otherText = {};
		onchanged?.();
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	} finally {
		busy = false;
	}
}

function tap(q: QuestionState, option: number) {
	if (!canAnswer || q.status !== 'open' || busy) return;
	if (tapSends) {
		void send([{ q: q.id, option }]);
		return;
	}
	const now = choices[q.id];
	choices = { ...choices, [q.id]: now?.kind === 'option' && now.option === option ? undefined : { kind: 'option', option } };
}

function typeOther(q: QuestionState, value: string) {
	otherText = { ...otherText, [q.id]: value };
	choices = { ...choices, [q.id]: value.trim() ? { kind: 'other', other: value } : undefined };
}

function sendOther(q: QuestionState) {
	const text = (otherText[q.id] ?? '').trim();
	if (text) void send([{ q: q.id, other: text }]);
}

function dismiss(q: QuestionState) {
	if (!canAnswer || q.status !== 'open' || busy) return;
	void send([{ q: q.id, dismissed: true }]);
}

function chosenOption(q: QuestionState): number | null {
	return q.answer?.kind === 'option' ? (q.answer.option ?? null) : null;
}
</script>

<div class="cards" role="group" aria-label="Questions">
	{#each states as q, i (q.id)}
		<section class="card" class:answered={q.status === 'answered'} class:dismissed={q.status === 'dismissed'} data-q={q.id}>
			<h3 class="q-text"><span class="q-num">{i + 1}.</span> {q.text}</h3>
			{#if q.reopenReason && q.status === 'open'}
				<p class="note reopened">{message.from} re-opened this: {q.reopenReason}</p>
			{/if}
			<div class="options">
				{#each q.options as option, k}
					{@const n = k + 1}
					{@const picked = choices[q.id]?.kind === 'option' && (choices[q.id] as { option: number }).option === n}
					<button
						type="button"
						class="option"
						class:picked
						class:chosen={chosenOption(q) === n}
						class:closed={q.status !== 'open'}
						aria-pressed={q.status === 'open' ? picked : chosenOption(q) === n}
						disabled={!canAnswer || q.status !== 'open' || busy}
						onclick={() => tap(q, n)}
					>
						<span class="opt-top">
							<span class="opt-label">{option.label}</span>
							{#if q.recommend === n}<span class="tag">Recommended</span>{/if}
						</span>
						{#if option.description}<span class="opt-desc">{option.description}</span>{/if}
					</button>
				{/each}
			</div>

			{#if q.status === 'open'}
				{#if canAnswer}
					<div class="other">
						<input
							type="text"
							class="other-input"
							placeholder="Other: your own words"
							aria-label={`Other answer to question ${i + 1}`}
							value={otherText[q.id] ?? ''}
							disabled={busy}
							oninput={(e) => typeOther(q, e.currentTarget.value)}
							onkeydown={(e) => {
								if (e.key === 'Enter' && tapSends) sendOther(q);
							}}
						/>
						{#if tapSends}
							<button type="button" class="send-other" disabled={busy || !(otherText[q.id] ?? '').trim()} onclick={() => sendOther(q)}>Send</button>
						{/if}
					</div>
					<div class="foot">
						<span class="waiting">Waiting on {q.waitingOn.join(', ')}</span>
						<button type="button" class="dismiss" disabled={busy} onclick={() => dismiss(q)}>Not needed</button>
					</div>
				{:else}
					<p class="note">
						{isAsker ? 'You asked this. ' : ''}Waiting on {q.waitingOn.join(', ')}{message.questionState ? '' : ' (state unavailable)'}
					</p>
				{/if}
			{:else if q.answer}
				<p class="note state">
					{answeredLine(q.answer, q)}
					<span class="when">{shortWhen(q.answer.at)}</span>
				</p>
				{#each q.also as other}
					<p class="note also" class:differs={q.conflict}>
						Also {answeredLine(other, q).replace(/^Answered by /, 'answered by ').replace(/^Dismissed by /, 'dismissed by ')}{q.conflict ? ' (differs)' : ''}
						<span class="when">{shortWhen(other.at)}</span>
					</p>
				{/each}
				{#if q.earlier.length > 0}
					<p class="note earlier">Before it was re-opened: {q.earlier.map((a) => `${a.by}: ${answerText(a, q)}`).join('; ')}</p>
				{/if}
			{/if}
		</section>
	{/each}

	{#if canAnswer && !tapSends && states.some((q) => q.status === 'open')}
		<div class="send-all">
			<button type="button" class="btn-send" disabled={busy || pending.length === 0} onclick={() => send(pending)}>
				{busy ? 'Sending...' : pending.length === 0 ? 'Choose an answer' : `Send ${pending.length} answer${pending.length === 1 ? '' : 's'}`}
			</button>
			<span class="send-hint">Goes to {message.from}.</span>
		</div>
	{/if}
	{#if error}
		<div class="error" role="alert">{error}</div>
	{/if}
</div>

<style>
	.cards { display: flex; flex-direction: column; gap: 0.75rem; margin: 0.5rem 0 0.25rem; }
	.card {
		border: 1px solid var(--border);
		border-left: 3px solid var(--warn, #d97706);
		border-radius: var(--radius);
		background: var(--surface);
		padding: 0.75rem 0.875rem;
	}
	.card.answered { border-left-color: var(--success, #16a34a); }
	.card.dismissed { border-left-color: var(--text-muted); opacity: 0.85; }
	.q-text { font-size: 0.95rem; font-weight: 600; line-height: 1.4; margin: 0 0 0.6rem; }
	.q-num { color: var(--text-muted); font-weight: 500; }
	.options { display: flex; flex-direction: column; gap: 0.4rem; }
	.option {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.15rem;
		width: 100%;
		min-height: 44px;
		padding: 0.55rem 0.75rem;
		text-align: left;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg);
		color: var(--text);
		transition: all var(--transition);
	}
	.option:hover:not(:disabled) { border-color: var(--primary); }
	.option.picked { border-color: var(--primary); background: var(--primary-subtle); box-shadow: inset 0 0 0 1px var(--primary); }
	.option.chosen { border-color: var(--success, #16a34a); background: var(--success-subtle, rgba(22, 163, 74, 0.1)); }
	.option:disabled { cursor: default; }
	.option.closed:not(.chosen) { opacity: 0.55; }
	.opt-top { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
	.opt-label { font-weight: 600; font-size: 0.9rem; }
	.opt-desc { font-size: 0.8rem; color: var(--text-muted); line-height: 1.4; white-space: normal; }
	.tag {
		font-size: 0.65rem;
		font-weight: 700;
		letter-spacing: 0.03em;
		text-transform: uppercase;
		padding: 0.05rem 0.4rem;
		border-radius: 99px;
		background: var(--primary-subtle);
		color: var(--primary);
	}
	.other { display: flex; gap: 0.4rem; margin-top: 0.5rem; }
	.other-input { flex: 1; min-width: 0; min-height: 44px; }
	.send-other, .btn-send {
		min-height: 44px;
		padding: 0.5rem 1rem;
		border-radius: var(--radius);
		font-weight: 600;
		font-size: 0.85rem;
		background: var(--primary);
		color: var(--on-primary);
	}
	.send-other:disabled, .btn-send:disabled { opacity: 0.5; cursor: not-allowed; }
	.foot { display: flex; justify-content: space-between; align-items: center; margin-top: 0.4rem; gap: 0.75rem; flex-wrap: wrap; }
	.waiting { font-size: 0.75rem; color: var(--text-muted); }
	.dismiss { font-size: 0.75rem; color: var(--text-muted); text-decoration: underline; padding: 0.4rem 0.25rem; min-height: 32px; }
	.note { font-size: 0.8rem; color: var(--text-muted); margin: 0.5rem 0 0; }
	.note.state { color: var(--text); font-weight: 600; }
	.note.also.differs { color: var(--warn, #d97706); }
	.note.reopened { color: var(--warn, #d97706); margin: 0 0 0.5rem; }
	.when { font-weight: 400; color: var(--text-muted); margin-left: 0.4rem; }
	.send-all { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
	.send-hint { font-size: 0.75rem; color: var(--text-muted); }
	.error {
		padding: 0.6rem 0.8rem;
		border-radius: var(--radius);
		border: 1px solid var(--danger, #dc2626);
		background: var(--danger-subtle, rgba(220, 38, 38, 0.1));
		color: var(--danger, #dc2626);
		font-size: 0.85rem;
		word-break: break-word;
	}
</style>
