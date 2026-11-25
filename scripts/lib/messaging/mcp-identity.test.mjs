import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withProject, withServer } from './mcp-test-helper.mjs';

// The identity check (upstream bacdefa): a server run as a member answers only as that member; the clerk may work
// on other members' lists but not their mailboxes; nobody sends as a human member.
const MEMBERS = [{ name: 'alice' }, { name: 'bob' }, { name: 'clerk' }, { name: 'kris', type: 'human' }];

test('a server run as alice refuses a `member` naming bob, on lists and on mailboxes', () =>
	withProject(
		(dir) =>
			withServer(dir, async ({ tool }) => {
				for (const [name, args] of [['list_inbox', { member: 'bob' }], ['list_todos', { member: 'bob' }], ['archive_message', { member: 'bob', id: 'x' }]]) {
					const res = await tool(name, args);
					assert.equal(res.error?.code, -32602, name);
					assert.match(res.error?.message ?? '', /You are alice/, name);
				}
				const own = await tool('list_inbox', { member: 'alice' });
				assert.equal(own.isError, false, 'naming yourself is fine');
				assert.equal((await tool('list_inbox', {})).isError, false, 'omitting it is fine');
			}, 'alice'),
		MEMBERS,
	));

test('the clerk may work on another member\'s lists, never on their mailbox', () =>
	withProject(
		(dir) =>
			withServer(dir, async ({ tool }) => {
				const todos = await tool('list_todos', { member: 'bob' });
				assert.equal(todos.isError, false, todos.text);
				for (const [name, args] of [['archive_message', { member: 'bob', id: 'x' }], ['send_message', { member: 'bob', to: ['alice'], subject: 's', body: 'x' }]]) {
					const res = await tool(name, args);
					assert.equal(res.error?.code, -32602, name);
					assert.match(res.error?.message ?? '', /You are clerk/, name);
				}
			}, 'clerk'),
		MEMBERS,
	));

test('nobody sends as a human member, with or without a runner-set identity', () =>
	withProject(
		async (dir) => {
			await withServer(dir, async ({ tool }) => {
				const res = await tool('send_message', { member: 'kris', to: ['alice'], subject: 's', body: 'x' });
				assert.equal(res.error?.code, -32602);
				assert.match(res.error?.message ?? '', /human member/);
			}, 'alice', { anyMember: true });
			await withServer(dir, async ({ tool }) => {
				const res = await tool('send_message', { to: ['alice'], subject: 's', body: 'x' });
				assert.equal(res.error?.code, -32602);
				assert.match(res.error?.message ?? '', /human member/);
			}, 'kris');
		},
		MEMBERS,
	));
