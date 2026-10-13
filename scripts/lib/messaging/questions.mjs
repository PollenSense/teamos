/**
 * Questions with options on messages ("question cards") and who is waiting on whom.
 *
 * A message can carry `questions`: a few decisions the sender needs, each with two to four options, one marked
 * as recommended. The reader answers by replying with `answers` entries (a card tap in the dashboard, or a
 * message from an agent). Nothing is stored about the state of a question: it is folded from the asking message
 * and the messages that answer it, so the master store stays the only truth and a copy of it (Drive, a clone)
 * is complete. Everything in this file is pure: no files, no clock.
 *
 * Shapes (one line of JSON each in the message frontmatter; see docs/messages.md):
 *
 *   questions: [{ id, text, options: [{ label, description? }], recommend, waitingOn: [names] }]
 *   answers:   [{ ask, q, option: N } | { ask, q, other: "text" } | { ask, q, dismissed: true } | { ask, q, reopen: "why" }]
 *              plus, when the asker records someone else's text reply: { by, via }
 */

export const MAX_QUESTIONS = 5;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_TEXT = 300;
export const MAX_LABEL = 60;
export const MAX_DESCRIPTION = 160;
export const MAX_OTHER = 500;
export const MAX_REASON = 200;

function bad(message) {
	return Object.assign(new Error(message), { status: 400 });
}

function text(value, where, max, { required = true } = {}) {
	if (value == null || value === '') {
		if (required) throw bad(`${where} is required`);
		return undefined;
	}
	if (typeof value !== 'string') throw bad(`${where} must be text`);
	const trimmed = value.trim();
	if (!trimmed && required) throw bad(`${where} is required`);
	if (trimmed.length > max) throw bad(`${where} is ${trimmed.length} characters; the limit is ${max}`);
	return trimmed || undefined;
}

// ─── Validating what a sender provides ───────────────────────────────────────

/**
 * The `questions` a sender gives, checked and completed: ids `q1`, `q2`, ... in order, `waitingOn` defaulting to
 * the message's To list and limited to people on the message, and a recommendation that must name one of the
 * options. Throws an error with `status: 400` and a sentence that says what to change.
 */
export function validateQuestions(input, { to = [], cc = [] } = {}) {
	if (input == null) return undefined;
	if (!Array.isArray(input) || input.length === 0) throw bad('questions must be a non-empty list');
	if (input.length > MAX_QUESTIONS) {
		throw bad(`At most ${MAX_QUESTIONS} questions per message (three or four is better); got ${input.length}`);
	}
	const onMessage = new Set([...to, ...cc]);
	return input.map((raw, index) => {
		const where = `question ${index + 1}`;
		if (!raw || typeof raw !== 'object') throw bad(`${where} must be an object with text and options`);
		const questionText = text(raw.text, `${where}: text`, MAX_TEXT);
		if (!Array.isArray(raw.options) || raw.options.length < MIN_OPTIONS || raw.options.length > MAX_OPTIONS) {
			throw bad(`${where}: give ${MIN_OPTIONS} to ${MAX_OPTIONS} options (an "Other" box is always added)`);
		}
		const options = raw.options.map((option, i) => {
			const spot = `${where}, option ${i + 1}`;
			const entry = typeof option === 'string' ? { label: option } : option;
			if (!entry || typeof entry !== 'object') throw bad(`${spot} must be a label or { label, description }`);
			const label = text(entry.label, `${spot}: label`, MAX_LABEL);
			const description = text(entry.description, `${spot}: description`, MAX_DESCRIPTION, { required: false });
			return description ? { label, description } : { label };
		});
		if (!Number.isInteger(raw.recommend) || raw.recommend < 1 || raw.recommend > options.length) {
			throw bad(`${where}: recommend is required and must be the number (1 to ${options.length}) of the option you recommend`);
		}
		let waitingOn = [...to];
		if (raw.waitingOn != null) {
			if (!Array.isArray(raw.waitingOn) || raw.waitingOn.length === 0 || raw.waitingOn.some((n) => typeof n !== 'string')) {
				throw bad(`${where}: waitingOn must be a list of names`);
			}
			waitingOn = [...new Set(raw.waitingOn)];
			const stranger = waitingOn.find((name) => !onMessage.has(name));
			if (stranger) throw bad(`${where}: cannot wait on ${stranger}, who is not on this message (To or Cc)`);
		}
		return { id: `q${index + 1}`, text: questionText, options, recommend: raw.recommend, waitingOn };
	});
}

/**
 * The body, with a numbered "Questions" block added when any question's text is missing from it, so a reader of
 * the bare file never loses one. Returns `{ body, appended }`.
 */
export function ensureQuestionsInBody(body, questions) {
	const squash = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
	const haystack = squash(body);
	if (questions.every((q) => haystack.includes(squash(q.text)))) return { body, appended: false };
	const lines = ['**Questions**', ''];
	questions.forEach((q, i) => {
		lines.push(`${i + 1}. ${q.text}`);
		q.options.forEach((option, k) => {
			const detail = option.description ? `: ${option.description}` : '';
			lines.push(`   - Option ${k + 1}: ${option.label}${detail}${k + 1 === q.recommend ? ' (recommended)' : ''}`);
		});
	});
	return { body: `${String(body ?? '').trimEnd()}\n\n${lines.join('\n')}`, appended: true };
}

/**
 * The `answers` a sender gives, checked for shape only (who may send which entry depends on the thread; see
 * `checkAnswers`). Each entry says which ask and question and exactly one thing: an option number, other text,
 * dismissed, or reopen with a reason; `by` and `via` ride along when the asker records someone else's reply.
 */
export function parseAnswers(input) {
	if (input == null) return undefined;
	if (!Array.isArray(input) || input.length === 0) throw bad('answers must be a non-empty list');
	return input.map((raw, index) => {
		const where = `answer ${index + 1}`;
		if (!raw || typeof raw !== 'object') throw bad(`${where} must be an object`);
		const ask = text(raw.ask, `${where}: ask`, 200);
		const q = text(raw.q, `${where}: q`, 20);
		if (!/^q\d+$/.test(q)) throw bad(`${where}: q must look like q1, q2, ...`);
		const kinds = ['option', 'other', 'dismissed', 'reopen'].filter((k) => raw[k] != null && raw[k] !== false);
		if (kinds.length !== 1) throw bad(`${where}: give exactly one of option, other, dismissed, reopen`);
		const entry = { ask, q };
		const kind = kinds[0];
		if (kind === 'option') {
			if (!Number.isInteger(raw.option) || raw.option < 1) throw bad(`${where}: option must be a number, 1 for the first`);
			entry.option = raw.option;
		} else if (kind === 'other') {
			entry.other = text(raw.other, `${where}: other`, MAX_OTHER);
		} else if (kind === 'dismissed') {
			if (raw.dismissed !== true) throw bad(`${where}: dismissed must be true`);
			entry.dismissed = true;
		} else {
			entry.reopen = text(raw.reopen, `${where}: reopen (the reason)`, MAX_REASON);
		}
		if (raw.by != null || raw.via != null) {
			if (kind !== 'option' && kind !== 'other') throw bad(`${where}: by and via only go with an answer`);
			entry.by = text(raw.by, `${where}: by`, 100, { required: false });
			entry.via = text(raw.via, `${where}: via`, 200, { required: false });
			if (!entry.by || !entry.via) throw bad(`${where}: by and via go together`);
		}
		return entry;
	});
}

// ─── The state of a question, folded from the thread ─────────────────────────

const bySentAt = (a, b) => (a.sentAt || '').localeCompare(b.sentAt || '') || (a.id || '').localeCompare(b.id || '');

function sameAnswer(a, b) {
	return a.kind === b.kind && a.option === b.option && (a.other ?? '') === (b.other ?? '');
}

/**
 * Who may send an answers entry, and what it means. Used twice with the same code: when a reply is sent (the
 * adapter refuses a bad one with `reason`) and when the state is folded (a hand-edited file cannot change the
 * views). Returns `{ ok: true, by, recordedBy, via }` for an answer, `{ ok: true }` for dismiss and reopen, or
 * `{ ok: false, reason }`.
 *
 * `ctx.lookup(id)` finds a message `{ from, sentAt }` (for `via`); `ctx.isHuman(name)` says whether a member is a
 * person (omitted: everyone counts). `state` is the question as folded so far.
 */
export function checkEntry(entry, { ask, sender, state, ctx = {} }) {
	const onThread = new Set([...(ask.to ?? []), ...(ask.cc ?? [])]);
	if (entry.reopen != null) {
		if (sender !== ask.from) return no('only the person who asked can reopen a question');
		if (!entry.reopen.trim()) return no('a reopen needs a reason');
		if (state.status === 'open') return no(`${entry.q} is still open`);
		if (state.reopens >= 1) return no(`${entry.q} was already reopened once; ask again in a new message`);
		return { ok: true };
	}
	if (entry.dismissed) {
		if (sender === ask.from) return no('the asker cannot dismiss their own question; send a message without it (supersede) instead');
		if (!onThread.has(sender)) return no('only someone on the message can dismiss a question');
		if (ctx.isHuman && !ctx.isHuman(sender)) return no('only a person can dismiss a question');
		return { ok: true };
	}
	if ('option' in entry && !(Number.isInteger(entry.option) && entry.option >= 1 && entry.option <= state.options.length)) {
		return no(`${entry.q} has ${state.options.length} options; option ${entry.option} does not exist`);
	}
	if (entry.by) {
		if (sender !== ask.from) return no('only the asker can record someone else\'s reply (by, via)');
		if (!onThread.has(entry.by) || entry.by === ask.from) return no(`${entry.by} is not one of the people asked`);
		const via = ctx.lookup ? ctx.lookup(entry.via) : null;
		if (!via) return no(`via ${entry.via} is not a message I can find`);
		if (via.from !== entry.by) return no(`via ${entry.via} was not sent by ${entry.by}`);
		if ((via.sentAt || '') <= (ask.sentAt || '')) return no(`via ${entry.via} was sent before the question`);
		return { ok: true, by: entry.by, recordedBy: sender, via: entry.via };
	}
	if (sender === ask.from) return no('the asker cannot answer their own question; to record someone\'s reply, add by and via');
	if (!onThread.has(sender)) return no('only someone the message was sent to (To or Cc) can answer');
	return { ok: true, by: sender };
}

function no(reason) {
	return { ok: false, reason };
}

/**
 * The state of every question of one asking message.
 *
 * `ask` is the asking message (`id, from, to, cc, subject, sentAt, questions, supersededBy`); `replies` are the
 * messages whose `answers` may name it (any others are skipped). First answer wins; a later answer or dismissal
 * is kept in `also` (never hidden) and `conflict` says when it differs; a reopen by the asker (once, with a
 * reason) returns a closed question to open and moves what was there into `earlier`. A superseded ask is marked
 * `superseded`: its successor carries the questions now.
 */
export function foldAsk(ask, replies, ctx = {}) {
	const states = (ask.questions ?? []).map((q) => ({
		...q,
		status: 'open',
		answer: null,
		also: [],
		earlier: [],
		reopens: 0,
		reopenReason: null,
		reopenedAt: null,
		conflict: false,
	}));
	const byId = new Map(states.map((s) => [s.id, s]));
	for (const reply of [...(replies ?? [])].sort(bySentAt)) {
		for (const entry of reply.answers ?? []) {
			if (entry.ask !== ask.id) continue;
			const state = byId.get(entry.q);
			if (!state) continue;
			const verdict = checkEntry(entry, { ask, sender: reply.from, state, ctx });
			if (!verdict.ok) continue;
			const at = reply.sentAt;
			if (entry.reopen != null) {
				state.earlier.push(state.answer, ...state.also);
				state.status = 'open';
				state.answer = null;
				state.also = [];
				state.reopens += 1;
				state.reopenReason = entry.reopen;
				state.reopenedAt = at;
				state.conflict = false;
				continue;
			}
			const made = entry.dismissed
				? { kind: 'dismissed', by: reply.from, at, messageId: reply.id }
				: {
						kind: 'option' in entry ? 'option' : 'other',
						...('option' in entry ? { option: entry.option } : { other: entry.other }),
						by: verdict.by,
						...(verdict.recordedBy ? { recordedBy: verdict.recordedBy, via: verdict.via } : {}),
						at,
						messageId: reply.id,
					};
			if (state.status === 'open') {
				state.status = entry.dismissed ? 'dismissed' : 'answered';
				state.answer = made;
			} else {
				state.also.push(made);
				if (!sameAnswer(made, state.answer)) state.conflict = true;
			}
		}
	}
	return {
		askId: ask.id,
		asker: ask.from,
		subject: ask.subject ?? '',
		sentAt: ask.sentAt,
		superseded: Boolean(ask.supersededBy),
		questions: states,
	};
}

export function countQuestions(folded) {
	const open = folded.questions.filter((q) => q.status === 'open').length;
	return { open, total: folded.questions.length };
}

/**
 * Every open question that waits on `member`, oldest first. Derived from the asks, so it does not depend on the
 * message being in anyone's inbox, and it never changes a mailbox.
 */
export function waitingOn(member, foldedAsks) {
	const out = [];
	for (const folded of foldedAsks) {
		if (folded.superseded) continue;
		for (const q of folded.questions) {
			if (q.status !== 'open' || !q.waitingOn.includes(member)) continue;
			out.push({
				askId: folded.askId,
				q: q.id,
				text: q.text,
				asker: folded.asker,
				subject: folded.subject,
				since: q.reopenedAt || folded.sentAt,
				reopened: q.reopens > 0 ? q.reopenReason : undefined,
				options: q.options,
				recommend: q.recommend,
			});
		}
	}
	return out.sort((a, b) => (a.since || '').localeCompare(b.since || '') || a.askId.localeCompare(b.askId));
}

/** How many open questions wait on each member: `{ [name]: n }`, members with none are absent. */
export function waitingCounts(foldedAsks) {
	const counts = {};
	for (const folded of foldedAsks) {
		if (folded.superseded) continue;
		for (const q of folded.questions) {
			if (q.status !== 'open') continue;
			for (const name of q.waitingOn) counts[name] = (counts[name] ?? 0) + 1;
		}
	}
	return counts;
}

/**
 * The open questions `member` asked, with who each waits on, since when, and the plain replies (no `answers`)
 * that arrived since: those are the ones the asker still has to record.
 */
export function askedBy(member, foldedAsks, textReplies = []) {
	const out = [];
	for (const folded of foldedAsks) {
		if (folded.superseded || folded.asker !== member) continue;
		for (const q of folded.questions) {
			if (q.status !== 'open') continue;
			const since = q.reopenedAt || folded.sentAt;
			out.push({
				askId: folded.askId,
				q: q.id,
				text: q.text,
				subject: folded.subject,
				waitingOn: q.waitingOn,
				since,
				textReplies: textReplies
					.filter((r) => r.askId === folded.askId && (r.sentAt || '') > since && q.waitingOn.includes(r.from))
					.map((r) => ({ id: r.id, from: r.from, sentAt: r.sentAt })),
			});
		}
	}
	return out.sort((a, b) => (a.since || '').localeCompare(b.since || '') || a.askId.localeCompare(b.askId));
}

/** One line for a person: "q1 answered by van: option 2 (Sky)". For prompts and plain-words bodies. */
export function describeAnswer(answer, question) {
	if (!answer) return 'open';
	if (answer.kind === 'dismissed') return `dismissed by ${answer.by}`;
	const said = answer.kind === 'option' ? `option ${answer.option} (${question.options[answer.option - 1]?.label ?? '?'})` : `other: ${answer.other}`;
	const via = answer.recordedBy ? ` (recorded by ${answer.recordedBy} from ${answer.via})` : '';
	return `answered by ${answer.by}: ${said}${via}`;
}
