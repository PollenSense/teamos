import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileMessagingAdapter } from './file.mjs';
import { inboxStatePath } from './inbox-state.mjs';

const MEMBERS = [
	{ name: 'ivy', type: 'ai' },
	{ name: 'cy', type: 'ai' },
	{ name: 'van', type: 'human' },
	{ name: 'nate', type: 'human' },
];

async function withAdapter(fn) {
	const dir = await mkdtemp(join(tmpdir(), 'teamos-sections-'));
	try {
		await writeFile(join(dir, 'members.json'), JSON.stringify({ members: MEMBERS }), 'utf-8');
		await fn(new FileMessagingAdapter(dir), dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const send = (adapter, extra) => adapter.sendMessage({ from: 'ivy', to: ['van'], subject: 'S', body: 'b', ...extra });
const tick = () => new Promise((r) => setTimeout(r, 3)); // message ids and times need to differ

test('marks survive the file, show in listings, and old mail has none', () =>
	withAdapter(async (adapter, dir) => {
		const plain = await send(adapter, { subject: 'plain' });
		const info = await send(adapter, { subject: 'info', fyi: true });
		const askMsg = await send(adapter, { subject: 'ask', expectsReply: true });
		const raw = await readFile(join(dir, 'messages', `${askMsg.id}.md`), 'utf-8');
		assert.match(raw, /\nexpectsReply: true\n/);
		assert.ok(!/\nfyi:/.test(raw));
		const inbox = await adapter.listInbox('van');
		const by = Object.fromEntries(inbox.map((m) => [m.subject, m]));
		assert.equal(by.plain.fyi, undefined);
		assert.equal(by.plain.expectsReply, undefined);
		assert.ok(!('fyi' in by.plain) && !('expectsReply' in by.plain), 'plain mail carries no extra keys');
		assert.equal(by.info.fyi, true);
		assert.equal(by.ask.expectsReply, true);
		assert.equal((await adapter.readMessage(info.id)).fyi, true);
		assert.ok(plain.id);
	}));

test('both marks, or a non-boolean, refuse the send and write nothing', () =>
	withAdapter(async (adapter) => {
		await assert.rejects(send(adapter, { fyi: true, expectsReply: true }), /cannot both be true/);
		await assert.rejects(send(adapter, { fyi: 'true' }), /must be true or false/);
		assert.deepEqual(await adapter.listInbox('van'), []);
		assert.deepEqual(await adapter.listSent('ivy'), []);
	}));

test('a superseded message keeps its marks, and the replacement can carry its own', () =>
	withAdapter(async (adapter) => {
		const first = await send(adapter, { subject: 'ask', expectsReply: true });
		await tick();
		const second = await adapter.supersedeMessage({ from: 'ivy', supersedes: [first.id], to: ['van'], body: 'better', fyi: true });
		assert.equal((await adapter.readMessage(first.id)).expectsReply, true, 'predecessor rewrite keeps its mark');
		assert.equal((await adapter.readMessage(first.id)).supersededBy, second.id);
		const inbox = await adapter.listInbox('van');
		assert.equal(inbox.length, 1);
		assert.equal(inbox[0].fyi, true);
	}));

test('sections: expectsReply needs the To recipient until they reply in the thread', () =>
	withAdapter(async (adapter) => {
		const ask = await send(adapter, { subject: 'ask', expectsReply: true, cc: ['nate'] });
		await send(adapter, { subject: 'plain' });
		await tick();
		let s = await adapter.inboxSections('van');
		assert.deepEqual(s.needs, { [ask.id]: ['reply'] });
		assert.equal(s.needsCount, 1);
		assert.equal(s.inbox.length, 2);
		assert.deepEqual((await adapter.inboxSections('nate')).needs, {}, 'a Cc is not asked to reply');

		// a reply to a reply further down the thread answers the ask above it
		const r1 = await adapter.sendMessage({ from: 'nate', to: ['van'], replyTo: ask.id, body: 'my view' });
		await tick();
		s = await adapter.inboxSections('van');
		assert.deepEqual(s.needs, { [ask.id]: ['reply'] }, 'someone else replying does not answer for van');
		const mine = await adapter.sendMessage({ from: 'van', to: ['ivy'], replyTo: r1.id, body: 'ok' });
		s = await adapter.inboxSections('van');
		assert.deepEqual(s.needs, {}, 'van replied below the ask');
		assert.ok(mine.id);
		// archive and move back: the reply is still on record
		await adapter.archiveMessage('van', ask.id);
		await adapter.unarchiveMessage('van', ask.id);
		assert.deepEqual((await adapter.inboxSections('van')).needs, {});
	}));

test('sections: an open card counts for the member it waits on, also after they archive the message', () =>
	withAdapter(async (adapter) => {
		const card = await send(adapter, {
			subject: 'pick',
			body: '1. Which?',
			questions: [{ text: 'Which?', options: ['A', 'B'], recommend: 1 }],
			cc: ['nate'],
		});
		await send(adapter, { subject: 'other' });
		let s = await adapter.inboxSections('van');
		assert.deepEqual(s.needs, { [card.id]: ['card'] });
		await adapter.archiveMessage('van', card.id);
		s = await adapter.inboxSections('van');
		assert.deepEqual(s.needs, { [card.id]: ['card'] }, 'the asker is still waiting');
		assert.equal(s.needsCount, 1);
		assert.equal(s.inbox.length, 1);
		await adapter.sendMessage({
			from: 'van',
			to: ['ivy'],
			replyTo: card.id,
			body: 'A',
			answers: [{ ask: card.id, q: 'q1', option: 1 }],
		});
		assert.deepEqual((await adapter.inboxSections('van')).needs, {}, 'answered');
	}));

test('pins: stored per member, shown as a reason, cleared by archive and delete, refused outside the inbox', () =>
	withAdapter(async (adapter, dir) => {
		const a = await send(adapter, { subject: 'a' });
		const b = await send(adapter, { subject: 'b', fyi: true });
		await adapter.pinMessage('van', b.id);
		await adapter.pinMessage('van', b.id); // twice is the same
		const state = JSON.parse(await readFile(inboxStatePath(dir, 'van'), 'utf-8'));
		assert.deepEqual(Object.keys(state.pinned), [b.id]);
		assert.deepEqual((await adapter.inboxSections('van')).needs, { [b.id]: ['pin'] });
		assert.deepEqual((await adapter.inboxSections('nate')).needs, {}, 'the pin is van\'s');

		await adapter.unpinMessage('van', b.id);
		assert.deepEqual((await adapter.inboxSections('van')).needs, {});
		await adapter.pinMessage('van', a.id);
		await adapter.archiveMessage('van', a.id);
		assert.deepEqual(JSON.parse(await readFile(inboxStatePath(dir, 'van'), 'utf-8')).pinned, {}, 'archiving clears the pin');
		await adapter.unarchiveMessage('van', a.id);
		assert.deepEqual((await adapter.inboxSections('van')).needs, {}, 'moved back unpinned');

		await adapter.pinMessage('van', a.id);
		await adapter.deleteInboxMessage('van', a.id);
		assert.deepEqual(JSON.parse(await readFile(inboxStatePath(dir, 'van'), 'utf-8')).pinned, {});
		await assert.rejects(adapter.pinMessage('van', a.id), (e) => e.status === 404 && /not in van's inbox/.test(e.message));
		await assert.rejects(adapter.pinMessage('nobody', b.id), /not in members\.json/);
		await adapter.unpinMessage('van', 'never-pinned'); // no error, no file churn
	}));

test('a damaged or odd inbox-state.json reads as no pins instead of throwing', () =>
	withAdapter(async (adapter, dir) => {
		const m = await send(adapter, { subject: 'a' });
		const path = inboxStatePath(dir, 'van');
		for (const content of ['{not json', '[]', '{"pinned": [1,2]}', '{"pinned": {"x": 5}}', 'null']) {
			await writeFile(path, content, 'utf-8');
			assert.deepEqual((await adapter.inboxSections('van')).needs, {}, content);
		}
		await writeFile(path, JSON.stringify({ pinned: { gone: '2026-01-01T00:00:00Z' }, other: 1 }), 'utf-8');
		await adapter.pinMessage('van', m.id);
		const written = JSON.parse(await readFile(path, 'utf-8'));
		assert.equal(written.other, 1, 'keys it does not know are kept');
		assert.ok(written.pinned[m.id]);
	}));

test('sections of an empty mailbox, and of a member with no files at all', () =>
	withAdapter(async (adapter) => {
		assert.deepEqual(await adapter.inboxSections('cy'), { inbox: [], needs: {}, needsCount: 0 });
	}));

// ─── review findings (2026-10-26) ───────────────────────────────────────────

test('a pinned or card-bearing ask the member already answered does not still say "reply"', () =>
	withAdapter(async (adapter) => {
		const ask = await send(adapter, { subject: 'ask', expectsReply: true });
		const card = await send(adapter, {
			subject: 'ask with card',
			expectsReply: true,
			body: '1. Which?',
			questions: [{ text: 'Which?', options: ['A', 'B'], recommend: 1 }],
		});
		await tick();
		await adapter.pinMessage('van', ask.id);
		await adapter.sendMessage({ from: 'van', to: ['ivy'], replyTo: ask.id, body: 'done' });
		await adapter.sendMessage({ from: 'van', to: ['ivy'], replyTo: card.id, body: 'in words' });
		const { needs } = await adapter.inboxSections('van');
		assert.deepEqual(needs[ask.id], ['pin'], 'answered and pinned: only the pin');
		assert.deepEqual(needs[card.id], ['card'], 'a text reply ends the reply reason even with an open card');
	}));

test('an open question still counts after the message was deleted, and the dashboard can show it', () =>
	withAdapter(async (adapter) => {
		const card = await send(adapter, { subject: 'pick', body: '1. Which?', questions: [{ text: 'Which?', options: ['A', 'B'], recommend: 1 }] });
		await adapter.deleteInboxMessage('van', card.id);
		const s = await adapter.inboxSections('van');
		assert.deepEqual(s.needs, { [card.id]: ['card'] }, 'the asker is still waiting');
		assert.equal(s.needsCount, 1);
		assert.equal((await adapter.listQuestions('van')).waitingOnMe.length, 1);
	}));

test('inboxSections takes folded questions from the caller, so many members cost one fold', () =>
	withAdapter(async (adapter) => {
		const card = await send(adapter, { subject: 'pick', body: '1. Which?', questions: [{ text: 'Which?', options: ['A', 'B'], recommend: 1 }] });
		const folded = await adapter.questionStates();
		let asked = 0;
		const original = adapter.listQuestions.bind(adapter);
		adapter.listQuestions = async (...args) => (asked++, original(...args));
		const s = await adapter.inboxSections('van', { folded });
		assert.deepEqual(s.needs, { [card.id]: ['card'] });
		assert.equal(asked, 0, 'no per-member question snapshot');
		assert.deepEqual((await adapter.inboxSections('nate', { folded })).needs, {});
	}));

test('an unreadable inbox-state.json is kept as .bad when the next pin replaces it', () =>
	withAdapter(async (adapter, dir) => {
		const m = await send(adapter, { subject: 'a' });
		const path = inboxStatePath(dir, 'van');
		await writeFile(path, '{"pinned": {"x": "2026-01-01T00:00:00Z"', 'utf-8'); // truncated
		assert.deepEqual((await adapter.inboxSections('van')).needs, {}, 'reads as no pins');
		await adapter.pinMessage('van', m.id);
		assert.equal(await readFile(`${path}.bad`, 'utf-8'), '{"pinned": {"x": "2026-01-01T00:00:00Z"', 'the damaged file is still there to recover from');
		assert.deepEqual(Object.keys(JSON.parse(await readFile(path, 'utf-8')).pinned), [m.id]);
	}));

test('superseding a pinned message clears the pin with it', () =>
	withAdapter(async (adapter, dir) => {
		const first = await send(adapter, { subject: 'a' });
		await adapter.pinMessage('van', first.id);
		await tick();
		await adapter.supersedeMessage({ from: 'ivy', supersedes: [first.id], to: ['van'], body: 'better' });
		assert.deepEqual(JSON.parse(await readFile(inboxStatePath(dir, 'van'), 'utf-8')).pinned, {});
	}));
