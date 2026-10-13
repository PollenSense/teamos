import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildInboxSection, buildQuestionsSection } from '../cycle.mjs';
import { FileMessagingAdapter } from './file.mjs';
import { withProject, withServer } from './mcp-test-helper.mjs';

const MEMBERS = [
	{ name: 'ivy', type: 'ai' },
	{ name: 'kris', type: 'human' },
	{ name: 'van', type: 'human' },
];

const palette = {
	text: 'Which palette for the landing page?',
	options: [{ label: 'Meadow', description: 'Green and cream' }, { label: 'Sky', description: 'Blue and white' }],
	recommend: 1,
	waitingOn: ['kris'],
};

test('the message tools offer questions and answers, plus list_questions', () =>
	withProject(
		(dir) =>
			withServer(dir, async ({ call }) => {
				const { result } = await call('tools/list', {});
				const byName = Object.fromEntries(result.tools.map((t) => [t.name, t]));
				const send = byName.send_message.inputSchema.properties;
				assert.equal(send.questions.type, 'array');
				assert.deepEqual(send.questions.items.required, ['text', 'options', 'recommend']);
				assert.match(send.questions.description, /recommend.*REQUIRED/);
				assert.equal(send.answers.type, 'array');
				assert.match(send.answers.description, /by.*via/);
				const sup = byName.supersede_message.inputSchema.properties;
				assert.equal(sup.questions.type, 'array');
				assert.equal(sup.answers, undefined, 'a supersede does not answer');
				assert.ok(byName.list_questions);
				assert.match(byName.read_message.description, /questionState/);
			}, 'ivy'),
		MEMBERS,
	));

test('ask, answer and list over the real MCP server', () =>
	withProject(
		(dir) =>
			withServer(dir, async ({ tool }) => {
				// ivy asks (the body lacks the question, so a block is appended and the reply says so)
				const asked = await tool('send_message', { to: ['kris', 'van'], subject: 'Palette', body: 'Please decide.', questions: [palette] });
				assert.equal(asked.isError, false, asked.text);
				assert.match(asked.json.note, /Questions" block was appended/);
				const id = asked.json.id;

				const bad = await tool('send_message', { to: ['kris'], subject: 's', body: 'x', questions: [{ ...palette, recommend: undefined }] });
				assert.equal(bad.isError, true);
				assert.match(bad.text, /recommend is required/);

				const read = await tool('read_message', { id });
				assert.equal(read.json.questions[0].id, 'q1');
				assert.equal(read.json.questionState[0].status, 'open');

				// kris answers, acting as kris through the `member` argument
				const answered = await tool('send_message', {
					member: 'kris',
					to: ['ivy'],
					replyTo: id,
					body: 'Meadow.',
					answers: [{ ask: id, q: 'q1', option: 1 }],
				});
				assert.equal(answered.isError, false, answered.text);
				const after = await tool('read_message', { id });
				assert.deepEqual([after.json.questionState[0].status, after.json.questionState[0].answer.by], ['answered', 'kris']);

				const refused = await tool('send_message', { member: 'ivy', to: ['kris'], replyTo: id, body: 'me too', answers: [{ ask: id, q: 'q1', option: 2 }] });
				assert.equal(refused.isError, true);
				assert.match(refused.text, /asker cannot answer their own question/);

				const lists = await tool('list_questions', { member: 'kris' });
				assert.deepEqual(lists.json.waitingOnMe, []);
				const mine = await tool('list_questions', {});
				assert.deepEqual(mine.json, { waitingOnMe: [], asked: [] }, 'nothing open for ivy');

				const sent = await tool('list_sent', {});
				assert.deepEqual(sent.json.find((m) => m.id === id).questions, { open: 0, total: 1 });
			}, 'ivy'),
		MEMBERS,
	));

async function withAdapter(fn) {
	const dir = await mkdtemp(join(tmpdir(), 'teamos-qprompt-'));
	try {
		await writeFile(join(dir, 'members.json'), JSON.stringify({ members: MEMBERS }), 'utf-8');
		await fn(new FileMessagingAdapter(dir));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test('the cycle prompt shows questions with their state, and answers in one line', () =>
	withAdapter(async (adapter) => {
		const { id } = await adapter.sendMessage({
			from: 'ivy',
			to: ['kris', 'van'],
			subject: 'Palette',
			body: `1. ${palette.text}`,
			questions: [{ ...palette, waitingOn: undefined }],
		});
		let text = (await buildInboxSection('kris', adapter)).join('\n');
		assert.match(text, /\*\*Questions\*\* \(an "Other" answer is always possible\):/);
		assert.match(text, /- `q1` Which palette for the landing page\? — \*\*open\*\*, waiting on kris, van/);
		assert.match(text, /    1\. Meadow: Green and cream \(recommended\)/);
		assert.match(text, /    2\. Sky: Blue and white\n/);

		await adapter.sendMessage({ from: 'kris', to: ['ivy'], replyTo: id, body: 'Sky.', answers: [{ ask: id, q: 'q1', option: 2 }] });
		await adapter.sendMessage({ from: 'van', to: ['ivy'], replyTo: id, body: 'Meadow.', answers: [{ ask: id, q: 'q1', option: 1 }] });
		text = (await buildInboxSection('ivy', adapter)).join('\n');
		assert.match(text, /\*\*Answers to [^*]+:\*\* q1 option 2/);
		assert.match(text, /\*\*Answers to [^*]+:\*\* q1 option 1/);
		// the ask itself, read as its parent in a reply, carries the folded state
		const sentText = (await buildInboxSection('van', adapter)).join('\n');
		assert.match(sentText, /\*\*answered by kris: option 2 \(Sky\)\*\*/);
		assert.match(sentText, /also: answered by van: option 1 \(Meadow\) \(differs\)/);
	}));

test('the Questions section lists what waits on a member and what they are waiting for, and is empty otherwise', () =>
	withAdapter(async (adapter) => {
		assert.deepEqual(await buildQuestionsSection('kris', adapter), []);
		const { id } = await adapter.sendMessage({ from: 'ivy', to: ['kris'], subject: 'Palette', body: palette.text, questions: [palette] });
		const reply = await adapter.sendMessage({ from: 'kris', to: ['ivy'], replyTo: id, body: 'meadow, I think' });

		const kris = (await buildQuestionsSection('kris', adapter)).join('\n');
		assert.match(kris, /## Questions/);
		assert.match(kris, /\*\*Waiting on you \(1\)\.\*\* Answer with `send_message/);
		assert.match(kris, new RegExp(`- \`q1\` of \`${id}\` from ivy \\(Palette\\), since \\d{4}-\\d{2}-\\d{2}: Which palette`));
		assert.doesNotMatch(kris, /You are waiting for/);

		const ivy = (await buildQuestionsSection('ivy', adapter)).join('\n');
		assert.match(ivy, /\*\*You are waiting for \(1\)\.\*\* A plain-text reply to one of these is an answer/);
		assert.match(ivy, new RegExp(`waits on kris since .*; plain replies since: kris \\(\`${reply.id}\`\\)`));
		assert.doesNotMatch(ivy, /Waiting on you/);

		await adapter.sendMessage({
			from: 'ivy',
			to: ['kris'],
			replyTo: id,
			body: 'Thanks.',
			answers: [{ ask: id, q: 'q1', option: 1, by: 'kris', via: reply.id }],
		});
		assert.deepEqual(await buildQuestionsSection('kris', adapter), []);
		assert.deepEqual(await buildQuestionsSection('ivy', adapter), []);
	}));

test('an adapter without listQuestions leaves the prompt as it was', async () => {
	assert.deepEqual(await buildQuestionsSection('kris', {}), []);
	assert.deepEqual(await buildQuestionsSection('kris', { listQuestions: async () => { throw new Error('boom'); } }), []);
});
