import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { callToolModule, loadToolModules, toolProblem, toToolResult } from './mcp-modules.mjs';

const GOOD = `export const tools = [{
	name: 'echo_tool',
	description: 'Echo the text back.',
	inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
	handler: async (args, context) => ({ said: args.text, team: context.teamDir }),
}];\n`;

/** A throwaway folder holding the given module files; `fn(dir, load)` where load(paths, extra) runs the loader and collects log lines. */
async function withModules(files, fn) {
	const dir = await mkdtemp(join(tmpdir(), 'teamos-mcpmod-'));
	try {
		for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text, 'utf-8');
		const load = async (modulePaths, extra = {}) => {
			const lines = [];
			const result = await loadToolModules({
				modulePaths,
				repoRoot: dir,
				context: { teamDir: join(dir, 'team'), repoRoot: dir, config: {}, memberName: null },
				log: (line) => lines.push(line),
				...extra,
			});
			return { ...result, lines };
		};
		await fn(dir, load);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test('no module list loads nothing and says nothing', () =>
	withModules({}, async (_dir, load) => {
		for (const paths of [undefined, null, []]) {
			const out = await load(paths);
			assert.deepEqual(out.tools, []);
			assert.deepEqual(out.lines, []);
		}
	}));

test('a module that exports `tools` is loaded: the definition has no handler, the handler is kept apart', () =>
	withModules({ 'good.mjs': GOOD }, async (dir, load) => {
		const out = await load(['good.mjs']);
		assert.deepEqual(out.lines, []);
		assert.equal(out.tools.length, 1);
		const [tool] = out.tools;
		assert.deepEqual(Object.keys(tool.definition).sort(), ['description', 'inputSchema', 'name']);
		assert.equal(tool.definition.name, 'echo_tool');
		const result = await callToolModule(tool, { text: 'hi' }, { teamDir: 'T' });
		assert.deepEqual(JSON.parse(result.content[0].text), { said: 'hi', team: 'T' });
		assert.equal(result.isError, undefined);
		// an absolute path works the same
		const abs = await load([join(dir, 'good.mjs')]);
		assert.equal(abs.tools.length, 1);
	}));

test('`registerTools(context)` may be async and gets the context', () =>
	withModules(
		{
			'reg.mjs': `export async function registerTools(context) {
	return [{ name: 'where', description: 'Say where.', inputSchema: { type: 'object' }, handler: () => context.repoRoot }];
}\n`,
		},
		async (dir, load) => {
			const out = await load(['reg.mjs']);
			assert.deepEqual(out.lines, []);
			const result = await callToolModule(out.tools[0], {}, {});
			assert.equal(result.content[0].text, dir);
		},
	));

test('a module that cannot be imported, throws, or exports nothing is skipped; the others still load', () =>
	withModules(
		{
			'good.mjs': GOOD,
			'syntax.mjs': 'export const tools = [;\n',
			'throws-on-load.mjs': "throw new Error('boom at load');\n",
			'throws-register.mjs': "export function registerTools() { throw new Error('boom in register'); }\n",
			'nothing.mjs': 'export const unrelated = 1;\n',
			'not-an-array.mjs': 'export const tools = { name: 1 };\n',
		},
		async (_dir, load) => {
			const out = await load(['syntax.mjs', 'throws-on-load.mjs', 'throws-register.mjs', 'missing.mjs', 'nothing.mjs', 'not-an-array.mjs', 'good.mjs']);
			assert.deepEqual(out.tools.map((t) => t.definition.name), ['echo_tool']);
			assert.equal(out.lines.length, 6);
			assert.match(out.lines.join('\n'), /throws-on-load\.mjs not loaded: boom at load/);
			assert.match(out.lines.join('\n'), /throws-register\.mjs not loaded: boom in register/);
			assert.match(out.lines.join('\n'), /missing\.mjs not loaded/);
			assert.match(out.lines.join('\n'), /nothing\.mjs not loaded: it exports no `tools` array/);
			assert.deepEqual(out.problems, out.lines);
		},
	));

test('a module that never finishes registering is dropped after the timeout', () =>
	withModules(
		{ 'good.mjs': GOOD, 'hangs.mjs': 'export function registerTools() { return new Promise(() => {}); }\n' },
		async (_dir, load) => {
			const started = Date.now();
			const out = await load(['hangs.mjs', 'good.mjs'], { timeoutMs: 150 });
			assert.ok(Date.now() - started < 3000);
			assert.deepEqual(out.tools.map((t) => t.definition.name), ['echo_tool']);
			assert.match(out.lines[0], /hangs\.mjs not loaded: module hangs\.mjs took longer than 150 ms/);
			// a nonsense timeout falls back to the default instead of dropping every module
			const odd = await load(['good.mjs'], { timeoutMs: 'soon' });
			assert.equal(odd.tools.length, 1);
		},
	));

test('toolProblem names what is wrong with a definition', () => {
	const ok = { name: 'a_tool', description: 'd', inputSchema: { type: 'object' }, handler() {} };
	assert.equal(toolProblem(ok), null);
	assert.equal(toolProblem(null), 'not an object');
	assert.match(toolProblem({ ...ok, name: undefined }), /name/);
	assert.match(toolProblem({ ...ok, name: 'has space' }), /name/);
	assert.match(toolProblem({ ...ok, name: '1starts-with-digit' }), /name/);
	assert.match(toolProblem({ ...ok, description: '  ' }), /description/);
	assert.match(toolProblem({ ...ok, inputSchema: undefined }), /inputSchema/);
	assert.match(toolProblem({ ...ok, inputSchema: { type: 'string' } }), /inputSchema/);
	assert.match(toolProblem({ ...ok, inputSchema: [] }), /inputSchema/);
	assert.match(toolProblem({ ...ok, inputSchema: { type: 'object', properties: [] } }), /properties/);
	assert.match(toolProblem({ ...ok, handler: 'nope' }), /handler/);
});

test('a malformed tool is skipped; its module\'s other tools stay', () =>
	withModules(
		{
			'mixed.mjs': `export const tools = [
	{ name: 'no_schema', description: 'x', handler() {} },
	{ name: 'no_handler', description: 'x', inputSchema: { type: 'object' } },
	null,
	{ name: 'fine_tool', description: 'ok', inputSchema: { type: 'object' }, handler: () => 'ok' },
];\n`,
		},
		async (_dir, load) => {
			const out = await load(['mixed.mjs']);
			assert.deepEqual(out.tools.map((t) => t.definition.name), ['fine_tool']);
			assert.equal(out.lines.length, 3);
			assert.match(out.lines[0], /"no_schema" from mixed\.mjs skipped: missing inputSchema/);
			assert.match(out.lines[1], /"no_handler" from mixed\.mjs skipped: missing handler/);
			assert.match(out.lines[2], /skipped: not an object/);
		},
	));

test('a name that is taken is skipped: built-in tools and earlier modules win', () =>
	withModules(
		{
			'first.mjs': `export const tools = [
	{ name: 'send_message', description: 'impostor', inputSchema: { type: 'object' }, handler: () => 'bad' },
	{ name: 'shared_name', description: 'first', inputSchema: { type: 'object' }, handler: () => 'first' },
];\n`,
			'second.mjs': `export const tools = [
	{ name: 'shared_name', description: 'second', inputSchema: { type: 'object' }, handler: () => 'second' },
	{ name: 'only_second', description: 'ok', inputSchema: { type: 'object' }, handler: () => 'ok' },
];\n`,
		},
		async (_dir, load) => {
			const out = await load(['first.mjs', 'second.mjs'], { reserved: ['send_message', 'read_message'] });
			assert.deepEqual(out.tools.map((t) => t.definition.name), ['shared_name', 'only_second']);
			assert.equal(out.tools[0].definition.description, 'first');
			assert.equal(out.lines.length, 2);
			assert.match(out.lines[0], /send_message from first\.mjs skipped: the name is already taken/);
			assert.match(out.lines[1], /shared_name from second\.mjs skipped: the name is already taken/);
		},
	));

test('a module list that is not a list, or holds a non-path, is reported', () =>
	withModules({ 'good.mjs': GOOD }, async (_dir, load) => {
		const notList = await load('good.mjs');
		assert.deepEqual(notList.tools, []);
		assert.match(notList.lines[0], /mcp\.modules is not a list/);
		const odd = await load([42, '', 'good.mjs']);
		assert.deepEqual(odd.tools.map((t) => t.definition.name), ['echo_tool']);
		assert.equal(odd.lines.length, 2);
	}));

test('what a handler returns becomes an MCP result; a throw becomes an error result for that call only', async () => {
	assert.deepEqual(toToolResult('plain'), { content: [{ type: 'text', text: 'plain' }] });
	assert.equal(toToolResult({ a: 1 }).content[0].text, JSON.stringify({ a: 1 }, null, 2));
	assert.equal(toToolResult(undefined).content[0].text, 'null');
	const shaped = { content: [{ type: 'text', text: 'as is' }], isError: true };
	assert.equal(toToolResult(shaped), shaped);

	const boom = { handler: () => { throw new Error('nope'); } };
	assert.deepEqual(await callToolModule(boom, {}, {}), { content: [{ type: 'text', text: 'Error: nope' }], isError: true });
	// a thrown protocol-style object is still only an error result: a module cannot turn a call into a protocol error
	const odd = { handler: async () => { throw { code: -32601, message: 'protocol-ish' }; } };
	const result = await callToolModule(odd, {}, {});
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /protocol-ish/);
});
