import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	MAX_QUESTIONS,
	askedBy,
	checkEntry,
	countQuestions,
	describeAnswer,
	ensureQuestionsInBody,
	foldAsk,
	parseAnswers,
	validateQuestions,
	waitingOn,
} from './questions.mjs';

const opts = (...labels) => labels.map((label) => ({ label }));
const one = (extra = {}) => ({ text: 'Which palette?', options: opts('Meadow', 'Sky'), recommend: 1, ...extra });
const msg = { to: ['kris', 'van'], cc: ['ivy'] };

// ─── validateQuestions ───────────────────────────────────────────────────────

test('validateQuestions assigns ids, defaults waitingOn to the To list, accepts string options', () => {
	const [q] = validateQuestions([{ text: ' Which palette? ', options: ['Meadow', { label: 'Sky', description: 'Blue, clinical' }], recommend: 2 }], msg);
	assert.deepEqual(q, {
		id: 'q1',
		text: 'Which palette?',
		options: [{ label: 'Meadow' }, { label: 'Sky', description: 'Blue, clinical' }],
		recommend: 2,
		waitingOn: ['kris', 'van'],
	});
	const two = validateQuestions([one(), one({ waitingOn: ['ivy', 'ivy', 'kris'] })], msg);
	assert.deepEqual(two.map((x) => x.id), ['q1', 'q2']);
	assert.deepEqual(two[1].waitingOn, ['ivy', 'kris']);
	assert.equal(validateQuestions(undefined, msg), undefined);
});

test('validateQuestions says what to change', () => {
	const fails = (input, pattern) => assert.throws(() => validateQuestions(input, msg), (e) => e.status === 400 && pattern.test(e.message), pattern.source);
	fails([], /non-empty list/);
	fails('q', /non-empty list/);
	fails(Array.from({ length: MAX_QUESTIONS + 1 }, () => one()), /At most 5 questions/);
	fails([null], /question 1 must be an object/);
	fails([one({ text: '' })], /question 1: text is required/);
	fails([one({ text: 'x'.repeat(301) })], /301 characters; the limit is 300/);
	fails([one({ options: opts('only one') })], /2 to 4 options/);
	fails([one({ options: opts('a', 'b', 'c', 'd', 'e') })], /2 to 4 options/);
	fails([one({ options: [{ label: '' }, { label: 'b' }] })], /option 1: label is required/);
	fails([one({ options: [{ label: 'a'.repeat(61) }, { label: 'b' }] })], /option 1: label is 61 characters/);
	fails([one({ options: [{ label: 'a', description: 'd'.repeat(161) }, { label: 'b' }] })], /description is 161 characters/);
	fails([one({ recommend: undefined })], /recommend is required/);
	fails([one({ recommend: 3 })], /recommend is required and must be the number \(1 to 2\)/);
	fails([one({ recommend: '1' })], /recommend is required/);
	fails([one({ waitingOn: [] })], /waitingOn must be a list of names/);
	fails([one({ waitingOn: ['nate'] })], /cannot wait on nate, who is not on this message/);
});

test('ensureQuestionsInBody leaves a body that has the questions and appends a block when one is missing', () => {
	const qs = validateQuestions(
		[one(), { text: 'Ship Friday?', options: [{ label: 'Yes', description: 'We lose a day of review' }, { label: 'No' }], recommend: 2 }],
		msg,
	);
	const whole = 'Two things.\n\n1. Which   palette?\n2. ship friday?\n';
	assert.deepEqual(ensureQuestionsInBody(whole, qs), { body: whole, appended: false });

	const partial = ensureQuestionsInBody('Only the first: which palette?', qs);
	assert.equal(partial.appended, true);
	assert.equal(
		partial.body,
		[
			'Only the first: which palette?',
			'',
			'**Questions**',
			'',
			'1. Which palette?',
			'   - Option 1: Meadow (recommended)',
			'   - Option 2: Sky',
			'2. Ship Friday?',
			'   - Option 1: Yes: We lose a day of review',
			'   - Option 2: No (recommended)',
		].join('\n'),
	);
});

// ─── parseAnswers ────────────────────────────────────────────────────────────

test('parseAnswers accepts the four kinds and rejects mixtures and bad shapes', () => {
	assert.deepEqual(
		parseAnswers([
			{ ask: 'A', q: 'q1', option: 2 },
			{ ask: 'A', q: 'q2', other: ' something else ' },
			{ ask: 'A', q: 'q3', dismissed: true },
			{ ask: 'A', q: 'q4', reopen: 'still need the date' },
			{ ask: 'A', q: 'q1', option: 1, by: 'alton', via: 'M9' },
		]),
		[
			{ ask: 'A', q: 'q1', option: 2 },
			{ ask: 'A', q: 'q2', other: 'something else' },
			{ ask: 'A', q: 'q3', dismissed: true },
			{ ask: 'A', q: 'q4', reopen: 'still need the date' },
			{ ask: 'A', q: 'q1', option: 1, by: 'alton', via: 'M9' },
		],
	);
	const fails = (input, pattern) => assert.throws(() => parseAnswers(input), (e) => e.status === 400 && pattern.test(e.message), pattern.source);
	fails([], /non-empty list/);
	fails([{ ask: 'A', q: 'q1' }], /exactly one of/);
	fails([{ ask: 'A', q: 'q1', option: 1, other: 'x' }], /exactly one of/);
	fails([{ ask: 'A', q: 'one', option: 1 }], /q must look like q1/);
	fails([{ ask: 'A', q: 'q1', option: 0 }], /option must be a number/);
	fails([{ ask: 'A', q: 'q1', option: '2' }], /option must be a number/);
	fails([{ ask: 'A', q: 'q1', dismissed: 'yes' }], /dismissed must be true/);
	fails([{ ask: 'A', q: 'q1', reopen: '  ' }], /exactly one of|is required/);
	fails([{ ask: 'A', q: 'q1', dismissed: true, by: 'x', via: 'y' }], /by and via only go with an answer/);
	fails([{ ask: 'A', q: 'q1', option: 1, by: 'x' }], /by and via go together/);
	fails([{ q: 'q1', option: 1 }], /ask is required/);
	assert.equal(parseAnswers(undefined), undefined);
});

// ─── foldAsk and checkEntry ──────────────────────────────────────────────────

const ask = (extra = {}) => ({
	id: 'A1',
	from: 'ivy',
	to: ['kris', 'van'],
	cc: ['alton'],
	subject: 'Palette',
	sentAt: '2026-10-13T10:00:00.000Z',
	questions: validateQuestions([one(), { text: 'Ship Friday?', options: opts('Yes', 'No'), recommend: 2 }], { to: ['kris', 'van'], cc: ['alton'] }),
	...extra,
});
let n = 0;
const reply = (from, answers, minute = 1, id = `R${++n}`) => ({
	id,
	from,
	sentAt: `2026-10-13T10:${String(minute).padStart(2, '0')}:00.000Z`,
	answers: answers.map((a) => ({ ask: 'A1', ...a })),
});
const states = (folded) => Object.fromEntries(folded.questions.map((q) => [q.id, q.status]));

test('a question is open until someone on the message answers; first answer wins', () => {
	assert.deepEqual(states(foldAsk(ask(), [])), { q1: 'open', q2: 'open' });
	const folded = foldAsk(ask(), [reply('kris', [{ q: 'q1', option: 2 }], 5)]);
	assert.deepEqual(states(folded), { q1: 'answered', q2: 'open' });
	assert.deepEqual(folded.questions[0].answer, { kind: 'option', option: 2, by: 'kris', at: '2026-10-13T10:05:00.000Z', messageId: folded.questions[0].answer.messageId });
	assert.deepEqual(countQuestions(folded), { open: 1, total: 2 });
});

test('anyone on To or Cc may answer, whoever the question waits on', () => {
	const folded = foldAsk(ask(), [reply('alton', [{ q: 'q1', other: 'Neither, try green' }])]);
	assert.equal(folded.questions[0].status, 'answered');
	assert.equal(folded.questions[0].answer.other, 'Neither, try green');
});

test('a later different answer is shown beside the first, never hidden', () => {
	const folded = foldAsk(ask(), [
		reply('van', [{ q: 'q1', option: 1 }], 9),
		reply('kris', [{ q: 'q1', option: 2 }], 5),
		reply('alton', [{ q: 'q1', option: 2 }], 11),
	]);
	const q1 = folded.questions[0];
	assert.equal(q1.answer.by, 'kris', 'the earliest by sentAt, whatever the order of the list');
	assert.deepEqual(q1.also.map((a) => [a.by, a.option]), [['van', 1], ['alton', 2]]);
	assert.equal(q1.conflict, true);
	const agree = foldAsk(ask(), [reply('kris', [{ q: 'q1', option: 2 }], 5), reply('van', [{ q: 'q1', option: 2 }], 6)]);
	assert.equal(agree.questions[0].conflict, false);
	assert.equal(agree.questions[0].also.length, 1);
});

test('entries that are not allowed are ignored by the fold', () => {
	const folded = foldAsk(ask(), [
		reply('nate', [{ q: 'q1', option: 1 }], 2), // not on the message
		reply('ivy', [{ q: 'q1', option: 1 }], 3), // the asker cannot answer their own question
		reply('kris', [{ q: 'q1', option: 9 }], 4), // no such option
		reply('kris', [{ q: 'q9', option: 1 }], 5), // no such question
		{ id: 'X', from: 'kris', sentAt: '2026-10-13T10:06:00.000Z', answers: [{ ask: 'OTHER', q: 'q1', option: 1 }] },
	]);
	assert.deepEqual(states(folded), { q1: 'open', q2: 'open' });
});

test('dismissed: a person on the message, not the asker; behaves like answered', () => {
	const ctx = { isHuman: (name) => name !== 'alton' };
	const folded = foldAsk(
		ask(),
		[reply('alton', [{ q: 'q1', dismissed: true }], 2), reply('ivy', [{ q: 'q1', dismissed: true }], 3), reply('van', [{ q: 'q1', dismissed: true }], 4)],
		ctx,
	);
	assert.equal(folded.questions[0].status, 'dismissed');
	assert.equal(folded.questions[0].answer.by, 'van');
	assert.deepEqual(waitingOn('van', [folded]).map((w) => w.q), ['q2']);
});

test('reopen: only the asker, with a reason, once, and only after it was closed', () => {
	const closed = reply('kris', [{ q: 'q1', option: 1 }], 2);
	const reopen = (minute, from = 'ivy', reason = 'still need the date') => reply(from, [{ q: 'q1', reopen: reason }], minute);

	let folded = foldAsk(ask(), [reopen(1)]); // not closed yet: ignored
	assert.equal(folded.questions[0].reopens, 0);

	folded = foldAsk(ask(), [closed, reopen(3, 'kris')]); // not the asker
	assert.equal(folded.questions[0].status, 'answered');

	folded = foldAsk(ask(), [closed, reopen(3)]);
	const q1 = folded.questions[0];
	assert.equal(q1.status, 'open');
	assert.equal(q1.reopens, 1);
	assert.equal(q1.reopenReason, 'still need the date');
	assert.equal(q1.earlier.length, 1);
	assert.equal(q1.earlier[0].by, 'kris');
	assert.equal(q1.answer, null);

	// answered again, then a second reopen is refused
	folded = foldAsk(ask(), [closed, reopen(3), reply('van', [{ q: 'q1', option: 2 }], 4), reopen(5, 'ivy', 'again')]);
	assert.equal(folded.questions[0].status, 'answered');
	assert.equal(folded.questions[0].answer.by, 'van');
	assert.equal(folded.questions[0].reopens, 1);
});

test('the asker records a text reply with by and via; each condition is checked', () => {
	const lookup = (id) => ({ M1: { from: 'alton', sentAt: '2026-10-13T10:03:00.000Z' }, EARLY: { from: 'alton', sentAt: '2026-10-13T09:00:00.000Z' }, VAN: { from: 'van', sentAt: '2026-10-13T10:03:00.000Z' } })[id] ?? null;
	const record = (extra, from = 'ivy') => reply(from, [{ q: 'q1', option: 1, by: 'alton', via: 'M1', ...extra }], 8);
	const status = (r) => foldAsk(ask(), [r], { lookup }).questions[0];

	const ok = status(record({}));
	assert.equal(ok.status, 'answered');
	assert.deepEqual([ok.answer.by, ok.answer.recordedBy, ok.answer.via], ['alton', 'ivy', 'M1']);

	assert.equal(status(record({}, 'kris')).status, 'open', 'only the asker may record');
	assert.equal(status(record({ via: 'NOPE' })).status, 'open', 'via must be a real message');
	assert.equal(status(record({ via: 'VAN' })).status, 'open', 'via must be from by');
	assert.equal(status(record({ via: 'EARLY' })).status, 'open', 'via must be after the question');
	assert.equal(status(record({ by: 'nate' })).status, 'open', 'by must be someone asked');
	assert.equal(status(record({ by: 'ivy', via: 'M1' })).status, 'open', 'the asker is not a by');
	assert.equal(foldAsk(ask(), [record({})]).questions[0].status, 'open', 'no lookup, no record');
});

test('a superseded ask is flagged and drops out of every list', () => {
	const folded = foldAsk(ask({ supersededBy: 'A2' }), []);
	assert.equal(folded.superseded, true);
	assert.deepEqual(waitingOn('kris', [folded]), []);
	assert.deepEqual(askedBy('ivy', [folded]), []);
});

test('checkEntry gives the reason the adapter sends back', () => {
	const state = foldAsk(ask(), []).questions[0];
	const run = (entry, sender, ctx = {}) => checkEntry({ q: 'q1', ...entry }, { ask: ask(), sender, state, ctx });
	assert.deepEqual(run({ option: 1 }, 'kris'), { ok: true, by: 'kris' });
	assert.match(run({ option: 1 }, 'ivy').reason, /asker cannot answer their own question/);
	assert.match(run({ option: 1 }, 'nate').reason, /only someone the message was sent to/);
	assert.match(run({ option: 7 }, 'kris').reason, /q1 has 2 options; option 7 does not exist/);
	assert.match(run({ reopen: 'why' }, 'ivy').reason, /q1 is still open/);
	assert.match(run({ reopen: 'why' }, 'kris').reason, /only the person who asked/);
	assert.match(run({ dismissed: true }, 'ivy').reason, /cannot dismiss their own question/);
	assert.match(run({ dismissed: true }, 'nate').reason, /only someone on the message/);
	assert.match(run({ dismissed: true }, 'alton', { isHuman: () => false }).reason, /only a person/);
	assert.match(run({ option: 1, by: 'alton', via: 'M1' }, 'kris').reason, /only the asker can record/);
});

// ─── waitingOn and askedBy ───────────────────────────────────────────────────

test('waitingOn lists open questions for a member, oldest first, from the asks alone', () => {
	const old = ask({ id: 'A0', sentAt: '2026-10-12T08:00:00.000Z', subject: 'Older', questions: validateQuestions([one()], { to: ['kris'] }) });
	const recent = ask();
	const answered = foldAsk(recent, [reply('van', [{ q: 'q2', option: 2 }])]);
	const list = waitingOn('kris', [answered, foldAsk(old, [])]);
	assert.deepEqual(list.map((w) => [w.askId, w.q, w.asker, w.subject]), [['A0', 'q1', 'ivy', 'Older'], ['A1', 'q1', 'ivy', 'Palette']]);
	assert.deepEqual(waitingOn('alton', [answered]), [], 'Cc only: default waitingOn is the To list');
	assert.equal(waitingOn('kris', [answered])[0].recommend, 1);
	// a reopened question is dated from the reopening and says why
	const reopened = foldAsk(old, [reply('kris', [{ ask: 'A0', q: 'q1', option: 1 }], 2), { id: 'RO', from: 'ivy', sentAt: '2026-10-13T11:00:00.000Z', answers: [{ ask: 'A0', q: 'q1', reopen: 'date missing' }] }]);
	const [w] = waitingOn('kris', [reopened]);
	assert.equal(w.since, '2026-10-13T11:00:00.000Z');
	assert.equal(w.reopened, 'date missing');
});

test('askedBy lists the asker\'s open questions with the text replies still to be recorded', () => {
	const folded = foldAsk(ask(), [reply('van', [{ q: 'q2', option: 1 }], 2)]);
	const textReplies = [
		{ id: 'T1', askId: 'A1', from: 'alton', sentAt: '2026-10-13T10:20:00.000Z' },
		{ id: 'T2', askId: 'A1', from: 'kris', sentAt: '2026-10-13T10:30:00.000Z' },
		{ id: 'T3', askId: 'A1', from: 'ivy', sentAt: '2026-10-13T10:40:00.000Z' },
		{ id: 'T4', askId: 'OTHER', from: 'kris', sentAt: '2026-10-13T10:40:00.000Z' },
		{ id: 'T0', askId: 'A1', from: 'kris', sentAt: '2026-10-13T09:00:00.000Z' },
	];
	const list = askedBy('ivy', [folded], textReplies);
	assert.equal(list.length, 1);
	assert.equal(list[0].q, 'q1');
	assert.deepEqual(list[0].waitingOn, ['kris', 'van']);
	assert.deepEqual(list[0].textReplies.map((r) => r.id), ['T2'], 'only people it waits on, only after the ask');
	assert.deepEqual(askedBy('kris', [folded]), []);
});

test('describeAnswer reads as a sentence', () => {
	const q = ask().questions[0];
	assert.equal(describeAnswer(null, q), 'open');
	assert.equal(describeAnswer({ kind: 'option', option: 2, by: 'kris' }, q), 'answered by kris: option 2 (Sky)');
	assert.equal(describeAnswer({ kind: 'other', other: 'green', by: 'van' }, q), 'answered by van: other: green');
	assert.equal(describeAnswer({ kind: 'dismissed', by: 'van' }, q), 'dismissed by van');
	assert.equal(
		describeAnswer({ kind: 'option', option: 1, by: 'alton', recordedBy: 'ivy', via: 'M1' }, q),
		'answered by alton: option 1 (Meadow) (recorded by ivy from M1)',
	);
});
