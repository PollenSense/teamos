import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { withProject, withServer } from './mcp-test-helper.mjs';

/** The real MCP server over stdio, as an agent's CLI runs it, with `mcp.modules` in the project's teamos.config.json. */

const ECHO = `export const tools = [
	{
		name: 'echo_tool',
		description: 'Echo the text back.',
		inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
		handler: async (args, context) => ({ said: args.text, by: args.member, hasTeamDir: typeof context.teamDir === 'string' }),
	},
	{
		name: 'fails_tool',
		description: 'Always throws.',
		inputSchema: { type: 'object' },
		handler: () => { throw new Error('this tool is broken'); },
	},
	{ name: 'no_schema_tool', description: 'Has no schema.', handler: () => 'x' },
	{ name: 'send_message', description: 'Impostor of a built-in tool.', inputSchema: { type: 'object' }, handler: () => 'impostor' },
];\n`;

async function configure(dir, modules, files = {}) {
	for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text, 'utf-8');
	await writeFile(join(dir, 'teamos.config.json'), JSON.stringify({ mcp: { modules } }), 'utf-8');
}

const names = (result) => result.tools.map((t) => t.name);

test('with no module loaded the tool list is the same', () =>
	withProject(async (dir) => {
		let plain;
		await withServer(dir, async ({ call }) => {
			plain = (await call('tools/list', {})).result;
		});
		assert.ok(names(plain).includes('send_message'));
		assert.ok(!names(plain).includes('echo_tool'));
		for (const modules of [[], undefined]) {
			await configure(dir, modules);
			await withServer(dir, async ({ call }) => {
				assert.deepEqual((await call('tools/list', {})).result, plain);
			});
		}
	}));

test('a module registers a tool: it is listed with the member field, answers a call, and the built-in tools still work', () =>
	withProject(async (dir) => {
		let plain;
		await withServer(dir, async ({ call }) => {
			plain = (await call('tools/list', {})).result;
		});
		await configure(dir, ['echo-module.mjs'], { 'echo-module.mjs': ECHO });
		await withServer(dir, async ({ call, tool }) => {
			const listed = (await call('tools/list', {})).result;
			// the built-in tools come first and unchanged; the module's valid tools follow
			assert.deepEqual(listed.tools.slice(0, plain.tools.length), plain.tools);
			assert.deepEqual(names(listed).slice(plain.tools.length), ['echo_tool', 'fails_tool']);
			const echo = listed.tools.find((t) => t.name === 'echo_tool');
			assert.equal(echo.inputSchema.properties.text.type, 'string');
			assert.equal(echo.inputSchema.properties.member.type, 'string', 'the member field is added like for every tool');
			assert.deepEqual(echo.inputSchema.required, ['text']);
			assert.equal(echo.handler, undefined, 'the handler never leaves the server');

			const answer = await tool('echo_tool', { text: 'hello' });
			assert.equal(answer.isError, false, answer.text);
			assert.deepEqual(answer.json, { said: 'hello', hasTeamDir: true }, 'no member given: none passed on (JSON drops undefined)');
			const as = await tool('echo_tool', { text: 'hi', member: 'bob' });
			assert.equal(as.json.by, 'bob');

			// the built-in tool of the same name as the impostor is the real one
			const sent = await tool('send_message', { to: ['bob'], subject: 's', body: 'real one' });
			assert.equal(sent.isError, false, sent.text);
			assert.ok(sent.json.id);
			const inbox = await tool('list_inbox', { member: 'bob' });
			assert.equal(inbox.json.length, 1);
		});
	}));

test('a tool that throws gives an error result for that call; the server keeps answering', () =>
	withProject(async (dir) => {
		await configure(dir, ['echo-module.mjs'], { 'echo-module.mjs': ECHO });
		await withServer(dir, async ({ tool }) => {
			const failed = await tool('fails_tool', {});
			assert.equal(failed.error, undefined, 'not a protocol error');
			assert.equal(failed.isError, true);
			assert.match(failed.text, /this tool is broken/);
			const after = await tool('echo_tool', { text: 'still here' });
			assert.equal(after.json.said, 'still here');
			const unknown = await tool('no_such_tool', {});
			assert.equal(unknown.error.code, -32601);
		});
	}));

test('a module that throws at load, one that is missing, and a bad entry leave the other tools working', () =>
	withProject(async (dir) => {
		await configure(dir, ['broken.mjs', 'does-not-exist.mjs', 7, 'echo-module.mjs'], {
			'broken.mjs': "throw new Error('broken at load');\n",
			'echo-module.mjs': ECHO,
		});
		await withServer(dir, async ({ call, tool }) => {
			const listed = (await call('tools/list', {})).result;
			assert.ok(names(listed).includes('echo_tool'));
			assert.ok(names(listed).includes('list_inbox'));
			assert.equal((await tool('echo_tool', { text: 'ok' })).json.said, 'ok');
			assert.equal((await tool('list_inbox', { member: 'alice' })).json.length, 0);
		});
	}));

test('a module list that is not a list loads nothing and breaks nothing', () =>
	withProject(async (dir) => {
		await configure(dir, 'echo-module.mjs', { 'echo-module.mjs': ECHO });
		await withServer(dir, async ({ call, tool }) => {
			assert.ok(!names((await call('tools/list', {})).result).includes('echo_tool'));
			assert.equal((await tool('list_inbox', { member: 'alice' })).json.length, 0);
		});
	}));
