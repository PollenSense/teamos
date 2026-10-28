import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildInboxSection } from '../cycle.mjs';
import { memberHasWork } from '../work-detection.mjs';
import { FileMessagingAdapter } from './file.mjs';
import { withProject, withServer } from './mcp-test-helper.mjs';

const MEMBERS = [
	{ name: 'ivy', type: 'ai', active: true },
	{ name: 'cy', type: 'ai', active: true },
	{ name: 'van', type: 'human', active: true },
	{ name: 'nate', type: 'human', active: true },
	{ name: 'old', type: 'human', active: false },
];

async function withAdapter(fn, members = MEMBERS) {
	const dir = await mkdtemp(join(tmpdir(), 'teamos-mentions-'));
	try {
		if (members) await writeFile(join(dir, 'members.json'), JSON.stringify({ members }), 'utf-8');
		await fn(new FileMessagingAdapter(dir), dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const send = (adapter, extra) => adapter.sendMessage({ from: 'ivy', to: ['van'], subject: 'S', body: 'plain text', ...extra });
const tick = () => new Promise((r) => setTimeout(r, 3));

test('a tag adds the member to Cc, is stored once, and shows in the result, the file and the listings', () =>
	withAdapter(async (adapter, dir) => {
		const sent = await send(adapter, { body: 'Please look, @nate.' });
		assert.deepEqual(sent.mentioned, ['nate']);
		assert.deepEqual(sent.addedToCc, ['nate']);
		const raw = await readFile(join(dir, 'messages', `${sent.id}.md`), 'utf-8');
		assert.match(raw, /\ncc: \[nate\]\n/);
		assert.match(raw, /\nmentions: \[nate\]\n/);
		const msg = await adapter.readMessage(sent.id);
		assert.deepEqual(msg.cc, ['nate']);
		assert.deepEqual(msg.mentions, ['nate']);
		assert.deepEqual((await adapter.listInbox('nate')).map((m) => [m.id, m.mentions]), [[sent.id, ['nate']]]);
		assert.deepEqual((await adapter.listSent('ivy'))[0].mentions, ['nate']);
	}));

test('plain mail carries no tag keys at all, and a tag of someone already in To or Cc adds nothing', () =>
	withAdapter(async (adapter, dir) => {
		const plain = await send(adapter, {});
		assert.deepEqual(Object.keys(plain).sort(), ['id', 'sentAt']);
		assert.ok(!/mentions/.test(await readFile(join(dir, 'messages', `${plain.id}.md`), 'utf-8')));
		assert.ok(!('mentions' in (await adapter.listInbox('van'))[0]));

		const inTo = await send(adapter, { body: 'Over to you @van' });
		assert.deepEqual(inTo.mentioned, ['van']);
		assert.equal(inTo.addedToCc, undefined);
		assert.deepEqual((await adapter.readMessage(inTo.id)).cc, []);

		const inCc = await send(adapter, { cc: ['nate'], body: '@nate and @van' });
		assert.deepEqual(inCc.mentioned, ['nate', 'van']);
		assert.equal(inCc.addedToCc, undefined);
	}));

test('what is not a tag adds nobody: code, quotes, email, inactive members, the sender, strangers', () =>
	withAdapter(async (adapter) => {
		const body = 'Run `echo @nate` or\n```\n@nate\n```\n> @nate said\nmail nate@pollensense.com, @old left, I am @ivy, @all and @nobody';
		const sent = await send(adapter, { body });
		assert.equal(sent.mentioned, undefined);
		assert.deepEqual((await adapter.readMessage(sent.id)).cc, []);
		assert.deepEqual(await adapter.listInbox('nate'), []);
	}));

test('fyi plus a tag is refused with nothing written; fyi without a tag and a tag without fyi are fine', () =>
	withAdapter(async (adapter) => {
		await assert.rejects(send(adapter, { fyi: true, body: 'FYI @nate' }), /fyi cannot be combined with an @tag \(@nate\)/);
		assert.deepEqual(await adapter.listSent('ivy'), []);
		assert.deepEqual(await adapter.listInbox('nate'), []);
		const note = await send(adapter, { fyi: true, body: 'Nate said this is fine' });
		assert.equal(note.mentioned, undefined);
		const ask = await send(adapter, { body: 'Nate, @nate, please decide', expectsReply: true });
		assert.deepEqual(ask.mentioned, ['nate']);
	}));

test('tags: false says the body is a record: nothing in it tags, not even with fyi', () =>
	withAdapter(async (adapter) => {
		const sent = await send(adapter, { body: 'transcript: @nate said hi', tags: false, fyi: true });
		assert.deepEqual(Object.keys(sent).sort(), ['id', 'sentAt']);
		assert.deepEqual((await adapter.readMessage(sent.id)).cc, []);
		assert.deepEqual(await adapter.listInbox('nate'), []);
	}));

test('a reply that tags someone brings them into the thread', () =>
	withAdapter(async (adapter) => {
		const first = await send(adapter, { subject: 'Topic' });
		await tick();
		const reply = await adapter.sendMessage({ from: 'van', to: ['ivy'], replyTo: first.id, body: 'Adding @nate and @cy' });
		assert.deepEqual(reply.addedToCc, ['nate', 'cy']);
		assert.deepEqual((await adapter.readMessage(reply.id)).cc, ['nate', 'cy']);
		assert.equal((await adapter.listInbox('nate')).length, 1);
	}));

test('supersede tags the same way, and a replacement without the tag stops tagging', () =>
	withAdapter(async (adapter) => {
		const first = await send(adapter, { subject: 'Plan' });
		await tick();
		const second = await adapter.supersedeMessage({ from: 'ivy', supersedes: [first.id], to: ['van'], body: 'Plan v2, @nate please check' });
		assert.deepEqual(second.mentioned, ['nate']);
		assert.deepEqual(second.addedToCc, ['nate']);
		assert.deepEqual((await adapter.readMessage(second.id)).mentions, ['nate']);
		await tick();
		// the third drops the tag; the tagged person stays on the recipients of the chain (cc must cover) but is no longer tagged
		const third = await adapter.supersedeMessage({ from: 'ivy', supersedes: [second.id], to: ['van'], cc: ['nate'], body: 'Plan v3' });
		assert.equal(third.mentioned, undefined);
		assert.equal((await adapter.readMessage(third.id)).mentions, undefined);
		assert.equal((await adapter.readMessage(second.id)).supersededBy, third.id);
		assert.deepEqual((await adapter.readMessage(second.id)).mentions, ['nate'], 'the old one keeps what it said');
		await assert.rejects(
			adapter.supersedeMessage({ from: 'ivy', supersedes: [third.id], to: ['van'], fyi: true, body: 'x @nate' }),
			/fyi cannot be combined/,
		);
	}));

test('Needs you: a tagged person has the reason `mention` until they reply anywhere below it', () =>
	withAdapter(async (adapter) => {
		const tagged = await send(adapter, { subject: 'Look', body: 'Hello @nate' });
		await send(adapter, { subject: 'Other', body: 'plain' });
		await tick();
		let s = await adapter.inboxSections('nate');
		assert.deepEqual(s.needs, { [tagged.id]: ['mention'] });
		assert.equal(s.needsCount, 1);
		assert.equal(s.inbox.length, 1);
		assert.deepEqual((await adapter.inboxSections('van')).needs, {}, 'the To recipient is not asked, only the tagged');
		assert.deepEqual((await adapter.inboxSections('ivy')).needs, {}, 'not the sender');

		// van replying does not answer for nate
		const vanReply = await adapter.sendMessage({ from: 'van', to: ['ivy'], replyTo: tagged.id, body: 'my view' });
		await tick();
		assert.deepEqual((await adapter.inboxSections('nate')).needs, { [tagged.id]: ['mention'] });
		// nate replies to van's reply: that answers the tag above it
		await adapter.sendMessage({ from: 'nate', to: ['van'], replyTo: vanReply.id, body: 'agreed' });
		assert.deepEqual((await adapter.inboxSections('nate')).needs, {});
	}));

test('Needs you: a tag stacks with a pin and with an ask, and leaves with archive', () =>
	withAdapter(async (adapter) => {
		const m = await send(adapter, { to: ['nate'], cc: ['van'], body: '@nate please decide', expectsReply: true });
		await adapter.pinMessage('nate', m.id);
		const s = await adapter.inboxSections('nate');
		assert.deepEqual(s.needs, { [m.id]: ['reply', 'mention', 'pin'] });
		assert.equal(s.needsCount, 1, 'one message, one count');
		await adapter.archiveMessage('nate', m.id);
		assert.deepEqual((await adapter.inboxSections('nate')).needs, {});
	}));

test('the tag log has one line per tag with no text', () =>
	withAdapter(async (adapter, dir) => {
		const m = await send(adapter, { body: 'secret words @nate and @cy' });
		await send(adapter, { body: 'no tags here' });
		const log = (await readFile(join(dir, '.logs', 'mentions.log'), 'utf-8')).trim().split('\n');
		assert.equal(log.length, 2);
		assert.match(log[0], new RegExp(`from=ivy tagged=nate id=${m.id} addedToCc=true$`));
		assert.match(log[1], /tagged=cy/);
		assert.ok(!log.join('\n').includes('secret'));
	}));

test('without a roster nothing is tagged and sending still works', () =>
	withAdapter(async (adapter) => {
		const sent = await adapter.sendMessage({ from: 'a', to: ['b'], subject: 'S', body: '@b look' });
		assert.deepEqual(Object.keys(sent).sort(), ['id', 'sentAt']);
	}, null));

test('an agent Cc-tagged is woken at pressing, plain Cc is not, and the prompt says so', async () => {
	await withAdapter(async (adapter, dir) => {
		await send(adapter, { subject: 'Plain copy', cc: ['cy'] });
		assert.equal(await memberHasWork('cy', 'pressing', dir, { messaging: adapter }), false);
		await tick();
		await send(adapter, { subject: 'Tagged copy', cc: ['cy'], body: 'Need your view, @cy' });
		assert.equal(await memberHasWork('cy', 'pressing', dir, { messaging: adapter }), true);
		const text = (await buildInboxSection('cy', adapter)).join('\n');
		const tagged = text.indexOf('### Tagged copy');
		const ccHeading = text.indexOf("Cc'd to you (1)");
		const plain = text.indexOf('### Plain copy');
		assert.ok(tagged >= 0 && ccHeading > tagged && plain > ccHeading, text);
		assert.match(text, /\*\*You are tagged:\*\* ivy wrote @cy\./);
		assert.equal(text.match(/You are tagged/g).length, 1, 'only the tagged message says it');
	});
});

test('an agent tags and is told what happened over the real MCP server; fyi plus a tag is an error', () =>
	withProject(
		(dir) =>
			withServer(dir, async ({ tool, call }) => {
				const { result } = await call('tools/list', {});
				const send = result.tools.find((t) => t.name === 'send_message');
				assert.match(send.inputSchema.properties.body.description, /@name/);
				assert.match(send.inputSchema.properties.fyi.description, /@tag/);

				const ok = await tool('send_message', { to: ['van'], subject: 'Ask', body: 'Question for @nate', expectsReply: true });
				assert.equal(ok.isError, false, ok.text);
				assert.deepEqual(ok.json.mentioned, ['nate']);
				assert.deepEqual(ok.json.addedToCc, ['nate']);
				assert.deepEqual(ok.json.cc, ['nate']);
				const bad = await tool('send_message', { to: ['van'], subject: 'Done', body: 'Done, thanks @nate', fyi: true });
				assert.equal(bad.isError, true);
				assert.match(bad.text, /fyi cannot be combined with an @tag/);
				const plain = await tool('send_message', { to: ['van'], subject: 'Plain', body: 'Nate said ok', fyi: true });
				assert.equal(plain.isError, false, plain.text);
				assert.deepEqual(plain.json.cc, []);
				assert.equal(plain.json.mentioned, undefined);
				assert.deepEqual((await tool('read_message', { id: ok.json.id })).json.mentions, ['nate']);
			}, 'ivy'),
		[
			{ name: 'ivy', type: 'ai' },
			{ name: 'van', type: 'human' },
			{ name: 'nate', type: 'human' },
		],
	));
