import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withProject, withServer } from './mcp-test-helper.mjs';

const MEMBERS = [
	{ name: 'ivy', type: 'ai' },
	{ name: 'van', type: 'human' },
];

test('the message tools offer the marks', () =>
	withProject(
		(dir) =>
			withServer(dir, async ({ call }) => {
				const { result } = await call('tools/list', {});
				const byName = Object.fromEntries(result.tools.map((t) => [t.name, t]));
				for (const tool of ['send_message', 'supersede_message']) {
					const props = byName[tool].inputSchema.properties;
					assert.equal(props.fyi.type, 'boolean', tool);
					assert.equal(props.expectsReply.type, 'boolean', tool);
					assert.match(props.expectsReply.description, /not a choice/, tool);
				}
			}, 'ivy'),
		MEMBERS,
	));

test('an agent marks a message over the real MCP server; both marks are refused; list_inbox carries the mark', () =>
	withProject(
		(dir) =>
			withServer(dir, async ({ tool }) => {
				const info = await tool('send_message', { to: ['van'], subject: 'Done', body: 'The render finished.', fyi: true });
				assert.equal(info.isError, false, info.text);
				const ask = await tool('send_message', { to: ['van'], subject: 'Wording', body: 'Please write two sentences.', expectsReply: true });
				assert.equal(ask.isError, false, ask.text);
				const both = await tool('send_message', { to: ['van'], subject: 'Both', body: 'x', fyi: true, expectsReply: true });
				assert.equal(both.isError, true);
				assert.match(both.text, /cannot both be true/);

				// the sender sees the marks on its own sent list; a replacement can carry a mark too
				const sent = await tool('list_sent', {});
				const by = Object.fromEntries(sent.json.map((m) => [m.subject, m]));
				assert.equal(by.Done.fyi, true);
				assert.equal(by.Wording.expectsReply, true);
				assert.equal(sent.json.length, 2, 'the refused message was not sent');
				const next = await tool('supersede_message', { supersedes: [info.json.id], to: ['van'], body: 'Finished, and uploaded.', expectsReply: true });
				assert.equal(next.isError, false, next.text);
				assert.equal((await tool('read_message', { id: next.json.id })).json.expectsReply, true);
				assert.equal((await tool('read_message', { id: info.json.id })).json.fyi, true, 'the old one keeps its mark');
			}, 'ivy'),
		MEMBERS,
	));
