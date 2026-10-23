import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileMessagingAdapter } from './file.mjs';

const MEMBERS = [
	{ name: 'ivy', type: 'ai' },
	{ name: 'cy', type: 'ai' },
	{ name: 'kris', type: 'human' },
	{ name: 'van', type: 'human' },
	{ name: 'alton', type: 'human' },
	{ name: 'nate', type: 'human' },
];

async function withAdapter(fn) {
	const dir = await mkdtemp(join(tmpdir(), 'teamos-q-'));
	try {
		await writeFile(join(dir, 'members.json'), JSON.stringify({ members: MEMBERS }), 'utf-8');
		await fn(new FileMessagingAdapter(dir), dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const palette = {
	text: 'Which palette: "Meadow" or Sky? (ünïcode ✓)',
	options: [{ label: 'Meadow', description: 'Green and cream: calm' }, { label: 'Sky', description: 'Blue and white\nclinical --- bold' }],
	recommend: 1,
};
const ship = { text: 'Ship Friday?', options: ['Yes', 'No'], recommend: 2 };

async function ask(adapter, extra = {}) {
	return adapter.sendMessage({
		from: 'ivy',
		to: ['kris', 'van'],
		cc: ['alton'],
		subject: 'Palette',
		body: `1. ${palette.text}\n2. ${ship.text}`,
		questions: [palette, ship],
		...extra,
	});
}

const answer = (adapter, from, askId, entries, extra = {}) =>
	adapter.sendMessage({ from, to: ['ivy'], replyTo: askId, body: 'answer', answers: entries.map((e) => ({ ask: askId, ...e })), ...extra });

const statesOf = async (adapter, id) => Object.fromEntries((await adapter.readMessage(id, { withState: true })).questionState.map((q) => [q.id, q.status]));

test('questions survive the file as one JSON line, and old fields parse as before', () =>
	withAdapter(async (adapter, dir) => {
		const { id } = await ask(adapter, { subject: '[OS] {not json}' });
		const raw = await readFile(join(dir, 'messages', `${id}.md`), 'utf-8');
		const lines = raw.split('\n').filter((l) => l.startsWith('questions:'));
		assert.equal(lines.length, 1);
		assert.ok(!raw.split('\n---\n')[0].includes('\nclinical'), 'the newline inside a description is escaped on the one line');

		const msg = await adapter.readMessage(id);
		assert.equal(msg.subject, '[OS] {not json}');
		assert.deepEqual(msg.cc, ['alton']);
		assert.equal(msg.questions.length, 2);
		assert.deepEqual(msg.questions[0], {
			id: 'q1',
			text: palette.text,
			options: palette.options,
			recommend: 1,
			waitingOn: ['kris', 'van'],
		});
		assert.deepEqual(msg.questions[1].options, [{ label: 'Yes' }, { label: 'No' }]);
		assert.equal(msg.questions[1].recommend, 2);

		// a message with neither field has neither key in its file
		const plain = await adapter.sendMessage({ from: 'ivy', to: ['kris'], subject: 'p', body: 'b' });
		const rawPlain = await readFile(join(dir, 'messages', `${plain.id}.md`), 'utf-8');
		assert.doesNotMatch(rawPlain, /^(questions|answers):/m);
		assert.equal((await adapter.readMessage(plain.id)).questions, undefined);
	}));

test('a bad question is refused with a sentence and nothing is sent', () =>
	withAdapter(async (adapter) => {
		await assert.rejects(ask(adapter, { questions: [{ ...ship, recommend: undefined }] }), (e) => e.status === 400 && /recommend is required/.test(e.message));
		await assert.rejects(ask(adapter, { questions: [{ ...ship, waitingOn: ['nate'] }] }), /cannot wait on nate/);
		await assert.rejects(ask(adapter, { questions: Array.from({ length: 6 }, () => ship) }), /At most 5 questions/);
		assert.deepEqual(await adapter.listInbox('kris'), []);
	}));

test('a body that lacks a question gets a numbered block, and the reply says so', () =>
	withAdapter(async (adapter) => {
		const sent = await ask(adapter, { body: 'Please decide.' });
		assert.equal(sent.questionsAppended, true);
		const msg = await adapter.readMessage(sent.id);
		assert.match(msg.body, /^Please decide\.\n\n\*\*Questions\*\*\n\n1\. Which palette/);
		assert.match(msg.body, /   - Option 1: Meadow: Green and cream: calm \(recommended\)/);
		const whole = await ask(adapter);
		assert.equal(whole.questionsAppended, undefined);
	}));

test('answering: the first answer from anyone on the message closes the question for everyone', () =>
	withAdapter(async (adapter) => {
		const { id } = await ask(adapter);
		assert.deepEqual(await statesOf(adapter, id), { q1: 'open', q2: 'open' });
		assert.deepEqual((await adapter.listQuestions('kris')).waitingOnMe.map((w) => w.q), ['q1', 'q2']);
		assert.deepEqual((await adapter.listQuestions('alton')).waitingOnMe, [], 'Cc is not asked unless named');

		await answer(adapter, 'alton', id, [{ q: 'q1', option: 2 }]); // a Cc'd person answers
		assert.deepEqual(await statesOf(adapter, id), { q1: 'answered', q2: 'open' });
		assert.deepEqual((await adapter.listQuestions('kris')).waitingOnMe.map((w) => w.q), ['q2']);

		await answer(adapter, 'kris', id, [{ q: 'q1', option: 1 }, { q: 'q2', other: 'Monday, the team is out' }]);
		const state = (await adapter.readMessage(id, { withState: true })).questionState;
		assert.equal(state[0].answer.by, 'alton');
		assert.equal(state[0].also[0].by, 'kris');
		assert.equal(state[0].conflict, true);
		assert.equal(state[1].answer.other, 'Monday, the team is out');
		assert.deepEqual((await adapter.listQuestions('van')).waitingOnMe, []);

		// the asker's sent list carries the count, and the answers are mail To the asker
		const sent = await adapter.listSent('ivy');
		assert.deepEqual(sent.find((s) => s.id === id).questions, { open: 0, total: 2 });
		const inbox = await adapter.listInbox('ivy');
		assert.equal(inbox.length, 2);
		assert.equal(inbox[0].questions, undefined, 'a plain answer has no questions of its own');
	}));

test('answering is refused with the reason, nothing is sent', () =>
	withAdapter(async (adapter) => {
		const { id } = await ask(adapter);
		const other = await ask(adapter, { subject: 'Another' });
		const refuse = (from, entries, pattern, extra) =>
			assert.rejects(answer(adapter, from, id, entries, extra), (e) => e.status === 400 && pattern.test(e.message), pattern.source);

		await refuse('ivy', [{ q: 'q1', option: 1 }], /asker cannot answer their own question/);
		await refuse('nate', [{ q: 'q1', option: 1 }], /only someone the message was sent to/);
		await refuse('kris', [{ q: 'q1', option: 3 }], /q1 has 2 options; option 3 does not exist/);
		await refuse('kris', [{ q: 'q7', option: 1 }], /has no question q7/);
		await refuse('kris', [{ q: 'q1', option: 1 }, { q: 'q1', option: 2 }], /answer q1 once per message/);
		await refuse('kris', [{ q: 'q1', option: 1 }], /replyTo/, { replyTo: undefined, subject: 'x' });
		await refuse('kris', [{ q: 'q1', option: 1, ask: other.id }], /must reply to the message that asked/);
		await refuse('kris', [{ q: 'q1', dismissed: true }, { q: 'q2', reopen: 'x' }], /only the person who asked can reopen/);
		await refuse('cy', [{ q: 'q1', dismissed: true }], /only someone on the message/);
		await assert.rejects(adapter.sendMessage({ from: 'kris', to: ['ivy'], replyTo: id, body: 'x', answers: [] }), /non-empty list/);

		const plain = await adapter.sendMessage({ from: 'ivy', to: ['kris'], subject: 'plain', body: 'no questions here' });
		await assert.rejects(answer(adapter, 'kris', plain.id, [{ q: 'q1', option: 1 }]), /asked no questions/);

		const inbox = await adapter.listInbox('ivy');
		assert.deepEqual(inbox, [], 'nothing reached the asker');
	}));

test('an AI member cannot dismiss; a person on the message can; dismissed counts as closed', () =>
	withAdapter(async (adapter) => {
		const { id } = await adapter.sendMessage({
			from: 'ivy',
			to: ['kris', 'cy'],
			subject: 'q',
			body: 'Which palette: "Meadow" or Sky? (ünïcode ✓)',
			questions: [palette],
		});
		await assert.rejects(answer(adapter, 'cy', id, [{ q: 'q1', dismissed: true }]), /only a person can dismiss/);
		await answer(adapter, 'kris', id, [{ q: 'q1', dismissed: true }]);
		assert.deepEqual(await statesOf(adapter, id), { q1: 'dismissed' });
		assert.deepEqual((await adapter.listQuestions('kris')).waitingOnMe, []);
	}));

test('the asker records a text reply with by and via; a wrong via is refused', () =>
	withAdapter(async (adapter) => {
		const { id } = await ask(adapter);
		const text = await adapter.sendMessage({ from: 'alton', to: ['ivy'], replyTo: id, body: 'yeah the second one, and no to Friday' });
		const early = await adapter.sendMessage({ from: 'van', to: ['ivy'], subject: 'unrelated', body: 'hi' });
		assert.deepEqual((await adapter.listQuestions('ivy')).asked.find((a) => a.q === 'q1').textReplies.map((r) => r.id), [], 'alton is not waited on by default (Cc)');

		const record = (via, by = 'alton', from = 'ivy') => answer(adapter, from, id, [{ q: 'q1', option: 2, by, via }]);
		await assert.rejects(record('nope'), /via nope is not a message I can find/);
		await assert.rejects(record(early.id), /was not sent by alton/);
		await assert.rejects(record(text.id, 'alton', 'kris'), /only the asker can record/);
		await assert.rejects(record(text.id, 'nate'), /nate is not one of the people asked/);
		await record(text.id);
		const q1 = (await adapter.readMessage(id, { withState: true })).questionState[0];
		assert.deepEqual([q1.status, q1.answer.by, q1.answer.recordedBy, q1.answer.via], ['answered', 'alton', 'ivy', text.id]);
	}));

test('text replies since the question are listed for the asker to record', () =>
	withAdapter(async (adapter) => {
		const { id } = await adapter.sendMessage({ from: 'ivy', to: ['kris'], subject: 'q', body: 'Which palette: "Meadow" or Sky? (ünïcode ✓)', questions: [palette] });
		const reply = await adapter.sendMessage({ from: 'kris', to: ['ivy'], replyTo: id, body: 'meadow please' });
		const { asked } = await adapter.listQuestions('ivy');
		assert.equal(asked.length, 1);
		assert.deepEqual(asked[0].waitingOn, ['kris']);
		assert.deepEqual(asked[0].textReplies.map((r) => r.id), [reply.id]);
	}));

test('reopen: the asker, once, with a reason; the question waits again and says why', () =>
	withAdapter(async (adapter) => {
		const { id } = await ask(adapter);
		await assert.rejects(answer(adapter, 'ivy', id, [{ q: 'q1', reopen: 'x' }]), /q1 is still open/);
		await answer(adapter, 'kris', id, [{ q: 'q1', option: 1 }]);
		await assert.rejects(answer(adapter, 'kris', id, [{ q: 'q1', reopen: 'no' }]), /only the person who asked/);
		await answer(adapter, 'ivy', id, [{ q: 'q1', reopen: 'I need the hex values too' }], { to: ['kris', 'van'] });
		assert.deepEqual(await statesOf(adapter, id), { q1: 'open', q2: 'open' });
		const w = (await adapter.listQuestions('kris')).waitingOnMe.find((x) => x.q === 'q1');
		assert.equal(w.reopened, 'I need the hex values too');
		await answer(adapter, 'van', id, [{ q: 'q1', option: 2 }]);
		await assert.rejects(answer(adapter, 'ivy', id, [{ q: 'q1', reopen: 'again' }], { to: ['van'] }), /already reopened once/);
	}));

test('supersede keeps the predecessor\'s questions, and is refused once a question was answered', () =>
	withAdapter(async (adapter, dir) => {
		const first = await ask(adapter);
		const second = await adapter.supersedeMessage({
			from: 'ivy',
			supersedes: [first.id],
			to: ['kris', 'van'],
			cc: ['alton'],
			body: `Updated: ${palette.text}`,
			questions: [palette],
		});
		const prev = await adapter.readMessage(first.id);
		assert.equal(prev.supersededBy, second.id);
		assert.equal(prev.questions.length, 2, 'the rewrite of the predecessor keeps its questions');
		assert.match(await readFile(join(dir, 'messages', `${first.id}.md`), 'utf-8'), /^questions: \[/m);

		const waiting = (await adapter.listQuestions('kris')).waitingOnMe;
		assert.deepEqual(waiting.map((w) => w.askId), [second.id], 'the replaced ask no longer waits');

		await answer(adapter, 'kris', second.id, [{ q: 'q1', option: 1 }]);
		await assert.rejects(
			adapter.supersedeMessage({ from: 'ivy', supersedes: [second.id], to: ['kris', 'van'], cc: ['alton'], body: 'again' }),
			(e) => e.status === 400 && /answers do not carry across.*follow-up/.test(e.message),
		);
		await assert.rejects(answer(adapter, 'van', first.id, [{ q: 'q2', option: 1 }]), /was replaced by/);
	}));

test('questions and answers together: answer one ask and ask the next thing in the same reply', () =>
	withAdapter(async (adapter) => {
		const { id } = await adapter.sendMessage({ from: 'ivy', to: ['kris'], subject: 'q', body: palette.text, questions: [palette] });
		const reply = await adapter.sendMessage({
			from: 'kris',
			to: ['ivy'],
			replyTo: id,
			body: `Meadow. And ${ship.text}`,
			answers: [{ ask: id, q: 'q1', option: 1 }],
			questions: [{ ...ship, waitingOn: ['ivy'] }],
		});
		assert.deepEqual(await statesOf(adapter, id), { q1: 'answered' });
		assert.deepEqual((await adapter.listQuestions('ivy')).waitingOnMe.map((w) => [w.askId, w.q, w.asker]), [[reply.id, 'q1', 'kris']]);
	}));

test('the index follows changes: a message edited after the first pass is read again', () =>
	withAdapter(async (adapter, dir) => {
		const { id } = await ask(adapter);
		assert.equal((await adapter.listQuestions('kris')).waitingOnMe.length, 2); // warms the cache
		const path = join(dir, 'messages', `${id}.md`);
		const raw = await readFile(path, 'utf-8');
		await new Promise((resolve) => setTimeout(resolve, 20));
		await writeFile(path, raw.replace(/^questions: .*$/m, 'questions: [{"id":"q1","text":"Only one now","options":[{"label":"a"},{"label":"b"}],"recommend":1,"waitingOn":["kris"]}]'), 'utf-8');
		assert.deepEqual((await adapter.listQuestions('kris')).waitingOnMe.map((w) => w.text), ['Only one now']);
	}));

test('the cache file is a plain optimization: a new process reuses it, garbage in it is ignored, deleted messages vanish', () =>
	withAdapter(async (adapter, dir) => {
		const { id } = await ask(adapter);
		assert.equal((await adapter.listQuestions('kris')).waitingOnMe.length, 2);
		const cachePath = join(dir, '.logs', 'questions-index.json');
		const cache = JSON.parse(await readFile(cachePath, 'utf-8'));
		assert.equal(cache.version, 1);
		assert.ok(cache.files[id]);

		const fresh = new FileMessagingAdapter(dir);
		assert.equal((await fresh.listQuestions('kris')).waitingOnMe.length, 2);

		await writeFile(cachePath, '{ this is not json', 'utf-8');
		const afterGarbage = new FileMessagingAdapter(dir);
		assert.equal((await afterGarbage.listQuestions('kris')).waitingOnMe.length, 2);
		assert.equal(JSON.parse(await readFile(cachePath, 'utf-8')).version, 1, 'rewritten after a rebuild');

		await rm(join(dir, 'messages', `${id}.md`));
		assert.deepEqual((await new FileMessagingAdapter(dir).listQuestions('kris')).waitingOnMe, []);
	}));

test('a message file edited by hand with malformed questions or answers never breaks a listing', () =>
	withAdapter(async (adapter, dir) => {
		const { id: goodId } = await adapter.sendMessage({ from: 'ivy', to: ['kris'], subject: 'ok', body: 'Ship Friday?', questions: [ship] });
		const head = (id, minute, extra) =>
			`---\nid: ${id}\nfrom: ivy\nto: [kris]\nsubject: Hand edited\nsentAt: 2026-10-23T10:${minute}:00.000Z\n${extra}\n---\nbody\n`;
		const missing = '2026-10-23T10-01-00.000Z-bad1';
		const reopen = '2026-10-23T10-02-00.000Z-bad2';
		await writeFile(join(dir, 'messages', `${missing}.md`), head(missing, '01', 'questions: [{"id":"q1","text":"x"}]'));
		await writeFile(join(dir, 'messages', `${reopen}.md`), head(reopen, '02', `replyTo: ${goodId}\nanswers: [{"ask":"${goodId}","q":"q1","reopen":5}]`));
		await writeFile(join(dir, 'members', 'kris', 'inbox.json'), JSON.stringify({ items: [goodId, missing, reopen] }));

		assert.equal((await adapter.listInbox('kris')).length, 3);
		const lists = await adapter.listQuestions('kris');
		assert.deepEqual(lists.waitingOnMe.map((w) => w.askId), [goodId], 'only the well-formed question is listed');
		assert.equal((await adapter.readMessage(missing, { withState: true })).questionState, undefined, 'a message whose only question is malformed has none');
		assert.equal((await adapter.listQuestions('ivy')).asked.length, 1);
	}));

test('an agent on Cc cannot close a question that waits on a person', () =>
	withAdapter(async (adapter) => {
		const { id } = await adapter.sendMessage({ from: 'ivy', to: ['kris'], cc: ['cy'], subject: 'q', body: 'Ship Friday?', questions: [ship] });
		await assert.rejects(answer(adapter, 'cy', id, [{ q: 'q1', option: 1 }]), /an agent can answer only a question that waits on it/);
		assert.equal((await statesOf(adapter, id)).q1, 'open');
		await assert.rejects(
			adapter.sendMessage({ from: 'ivy', to: ['kris'], cc: ['ivy'], subject: 'q2', body: 'Ship Friday?', questions: [{ ...ship, waitingOn: ['ivy'] }] }),
			/cannot wait on yourself/,
		);
		await answer(adapter, 'kris', id, [{ q: 'q1', option: 1 }]);
		assert.equal((await statesOf(adapter, id)).q1, 'answered');
	}));

test('a plain reply to a follow-up still shows up for the asker as a reply to the question', () =>
	withAdapter(async (adapter) => {
		const { id } = await adapter.sendMessage({ from: 'ivy', to: ['kris'], subject: 'q', body: 'Which palette: "Meadow" or Sky? (ünïcode ✓)', questions: [palette] });
		const followUp = await adapter.sendMessage({ from: 'ivy', to: ['kris'], replyTo: id, body: 'any thoughts?' });
		const reply = await adapter.sendMessage({ from: 'kris', to: ['ivy'], replyTo: followUp.id, body: 'meadow please' });
		const { asked } = await adapter.listQuestions('ivy');
		assert.deepEqual(asked[0].textReplies.map((r) => r.id), [reply.id]);
	}));
