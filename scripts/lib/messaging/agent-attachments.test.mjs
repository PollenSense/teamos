import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { buildInboxSection } from '../cycle.mjs';
import { FileMessagingAdapter } from './file.mjs';
import { PNG, withProject, withServer } from './mcp-test-helper.mjs';

test('the message tools offer `attachments`, and read_message says what it returns', () =>
	withProject((dir) =>
		withServer(dir, async ({ call }) => {
			const { result } = await call('tools/list', {});
			const byName = Object.fromEntries(result.tools.map((t) => [t.name, t]));
			for (const name of ['send_message', 'supersede_message']) {
				const prop = byName[name].inputSchema.properties.attachments;
				assert.equal(prop.type, 'array', name);
				assert.equal(prop.items.type, 'string', name);
				assert.match(prop.description, /attachment:1/);
			}
			assert.match(byName.read_message.description, /attachmentPaths/);
		}),
	));

test('send_message attaches an image by path, places it, and read_message gives the agent an absolute path', () =>
	withProject((dir) =>
		withServer(dir, async ({ tool }) => {
			const sent = await tool('send_message', {
				to: ['bob'],
				subject: 'A screenshot',
				body: 'See ![the page](attachment:1) for the error.',
				attachments: ['pics/shot.png'],
			});
			assert.equal(sent.isError, false, sent.text);
			const id = sent.json.id;

			const read = await tool('read_message', { id });
			assert.deepEqual(read.json.attachments, ['shot.png']);
			assert.equal(read.json.body, `See ![the page](attachments/${id}/shot.png) for the error.`);
			assert.equal(read.json.attachmentPaths.length, 1);
			const [path] = read.json.attachmentPaths;
			assert.ok(isAbsolute(path), path);
			assert.ok(path.endsWith(join('team', 'messages', 'attachments', id, 'shot.png')), path);
			assert.deepEqual(await readFile(path), PNG);
		}),
	));

test('a file that is not an image is refused and nothing is sent', () =>
	withProject((dir) =>
		withServer(dir, async ({ tool }) => {
			const sent = await tool('send_message', {
				to: ['bob'],
				subject: 's',
				body: 'x',
				attachments: ['pics/shot.png', 'pics/notes.txt'],
			});
			assert.equal(sent.isError, true);
			assert.match(sent.text, /notes\.txt.*not a png, jpg, gif or webp image/);
			const inbox = await tool('list_inbox', { member: 'bob' });
			assert.deepEqual(inbox.json, []);
			await assert.rejects(stat(join(dir, 'team', 'messages')));

			const missing = await tool('send_message', { to: ['bob'], subject: 's', body: 'x', attachments: ['pics/nope.png'] });
			assert.equal(missing.isError, true);
			assert.match(missing.text, /cannot be read/);

			const badShape = await tool('send_message', { to: ['bob'], subject: 's', body: 'x', attachments: 'pics/shot.png' });
			assert.equal(badShape.error.code, -32602);
		}),
	));

test('supersede_message can carry images too', () =>
	withProject((dir) =>
		withServer(dir, async ({ tool }) => {
			const first = await tool('send_message', { to: ['bob'], subject: 's', body: 'v1' });
			const second = await tool('supersede_message', {
				supersedes: [first.json.id],
				to: ['bob'],
				body: 'v2',
				attachments: [join(dir, 'pics', 'shot.png')],
			});
			assert.equal(second.isError, false, second.text);
			const read = await tool('read_message', { id: second.json.id });
			assert.deepEqual(read.json.attachments, ['shot.png']);
			assert.match(read.json.body, new RegExp(`^v2\\n\\n!\\[shot\\]\\(attachments/${second.json.id}/shot\\.png\\)$`));
		}),
	));

test('readMessage adds attachmentPaths only when asked, for the message and its parent', () =>
	withProject(async (dir) => {
		const adapter = new FileMessagingAdapter(join(dir, 'team'));
		const parent = await adapter.sendMessage({
			from: 'alice',
			to: ['bob'],
			subject: 's',
			body: 'p',
			attachments: [{ path: join(dir, 'pics', 'shot.png') }],
		});
		const reply = await adapter.sendMessage({ from: 'bob', to: ['alice'], body: 'r', replyTo: parent.id });
		const plain = await adapter.readMessage(reply.id);
		assert.equal(plain.parent.attachmentPaths, undefined);
		assert.deepEqual(plain.parent.attachments, ['shot.png']);
		const withPaths = await adapter.readMessage(reply.id, { withPaths: true });
		assert.equal(withPaths.attachmentPaths, undefined);
		assert.equal(withPaths.parent.attachmentPaths.length, 1);
		assert.ok(isAbsolute(withPaths.parent.attachmentPaths[0]));
	}));

test('the cycle prompt lists attached images by absolute path', () =>
	withProject(async (dir) => {
		const adapter = new FileMessagingAdapter(join(dir, 'team'));
		const { id } = await adapter.sendMessage({
			from: 'alice',
			to: ['bob'],
			subject: 'Look',
			body: 'Here: ![a](attachment:1)',
			attachments: [{ path: join(dir, 'pics', 'shot.png'), ref: '1' }],
		});
		const text = (await buildInboxSection('bob', adapter)).join('\n');
		assert.match(text, /\*\*Attached images\*\* \(open one with your Read tool to see it\):/);
		assert.ok(text.includes(`- ${join(dir, 'team', 'messages', 'attachments', id, 'shot.png')}`), text);
		assert.ok(text.includes(`![a](attachments/${id}/shot.png)`));

		// no images, no section
		await adapter.sendMessage({ from: 'alice', to: ['bob'], subject: 'Plain', body: 'text only' });
		const plain = (await buildInboxSection('bob', adapter)).join('\n');
		assert.equal(plain.split('Attached images').length - 1, 1);
	}));
