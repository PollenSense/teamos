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
			assert.match(out.lines[0], /"send_message" from first\.mjs skipped: the name is already taken/);
			assert.match(out.lines[1], /"shared_name" from second\.mjs skipped: the name is already taken/);
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

// ─── Fixes from the independent review (each case below crashed the server or hid every tool before) ───

test('a tool whose definition cannot be read or copied as plain JSON is skipped, never a crash', () =>
	withModules(
		{
			'good.mjs': GOOD,
			'odd.mjs': `const circular = { type: 'object', properties: {} };
circular.properties.self = circular;
export const tools = [
	{ name: 10n, description: 'd', inputSchema: { type: 'object' }, handler() {} },
	{ name: 'circular_schema', description: 'd', inputSchema: circular, handler() {} },
	{ name: 'bigint_default', description: 'd', inputSchema: { type: 'object', properties: { n: { type: 'integer', default: 10n } } }, handler() {} },
	{ get name() { return 'getter_throws'; }, description: 'd', get inputSchema() { throw new Error('getter exploded'); }, handler() {} },
	'a string, not a tool',
	() => 'a function, not a tool',
	{ name: 'fine_after_all', description: 'ok', inputSchema: { type: 'object' }, handler: () => 'ok' },
];\n`,
		},
		async (_dir, load) => {
			const out = await load(['odd.mjs', 'good.mjs']);
			assert.deepEqual(out.tools.map((t) => t.definition.name), ['fine_after_all', 'echo_tool']);
			assert.equal(out.lines.length, 6, out.lines.join('\n'));
			assert.match(out.lines.join('\n'), /getter exploded/);
		},
	));

test('a class-based tool with getters works; the handler gets the tool as `this`', () =>
	withModules(
		{
			'class.mjs': `class Greeter {
	constructor() { this.greeting = 'hello'; }
	get name() { return 'greet_tool'; }
	get description() { return 'Greets.'; }
	get inputSchema() { return { type: 'object', properties: { who: { type: 'string' } } }; }
	handler(args) { return this.greeting + ' ' + args.who; }
}
export const tools = [new Greeter()];\n`,
		},
		async (_dir, load) => {
			const out = await load(['class.mjs']);
			assert.deepEqual(out.lines, []);
			assert.equal(out.tools[0].definition.name, 'greet_tool');
			assert.deepEqual(out.tools[0].definition.inputSchema.properties, { who: { type: 'string' } });
			assert.equal((await callToolModule(out.tools[0], { who: 'you' }, {})).content[0].text, 'hello you');
		},
	));

test('a definition is a snapshot: changing the module\'s object later changes nothing', () =>
	withModules(
		{
			'live.mjs': `export const tools = [{ name: 'live_tool', description: 'before', inputSchema: { type: 'object' }, handler: () => 'ok' }];
export function mutate() { tools[0].description = 'after'; tools[0].inputSchema.properties = 5; }\n`,
		},
		async (dir, load) => {
			const out = await load(['live.mjs']);
			(await import(join(dir, 'live.mjs'))).mutate();
			assert.equal(out.tools[0].definition.description, 'before');
			assert.equal(out.tools[0].definition.inputSchema.properties, undefined);
		},
	));

test('schemas an MCP client would reject are refused here', () => {
	const ok = { name: 'a_tool', description: 'd', inputSchema: { type: 'object' }, handler() {} };
	const withSchema = (inputSchema) => toolProblem({ ...ok, inputSchema });
	assert.match(withSchema({ type: 'object', required: 'text' }), /required/);
	assert.match(withSchema({ type: 'object', required: [1] }), /required/);
	assert.equal(withSchema({ type: 'object', required: ['text'], properties: { text: { type: 'string' } } }), null);
	assert.match(withSchema({ type: 'object', properties: { x: true } }), /property that is not an object/);
	assert.match(withSchema({ type: 'object', properties: { x: null } }), /property that is not an object/);
	assert.match(toolProblem(() => 'function'), /not an object/);
});

test('modules load in parallel: three slow ones cost one timeout, not three', () =>
	withModules(
		{
			'good.mjs': GOOD,
			'hang1.mjs': 'export function registerTools() { return new Promise(() => {}); }\n',
			'hang2.mjs': 'export function registerTools() { return new Promise(() => {}); }\n',
			'hang3.mjs': 'export function registerTools() { return new Promise(() => {}); }\n',
		},
		async (_dir, load) => {
			const started = Date.now();
			const out = await load(['hang1.mjs', 'hang2.mjs', 'hang3.mjs', 'good.mjs'], { timeoutMs: 400 });
			const took = Date.now() - started;
			assert.ok(took < 1000, `took ${took} ms`);
			assert.deepEqual(out.tools.map((t) => t.definition.name), ['echo_tool']);
			assert.equal(out.lines.length, 3);
			// list order still decides who wins a name, whichever module finished first
			const clash = await load(['good.mjs', 'good.mjs']);
			assert.equal(clash.tools.length, 1);
			assert.match(clash.lines[0], /already taken/);
		},
	));

test('a timeout above the timer limit is clamped, not turned into 1 ms', () =>
	withModules({ 'good.mjs': GOOD }, async (_dir, load) => {
		const out = await load(['good.mjs'], { timeoutMs: 3_000_000_000 });
		assert.equal(out.tools.length, 1);
		assert.deepEqual(out.lines, []);
	}));

test('a handler result that is not a valid MCP result or cannot be serialised is handled', async () => {
	assert.equal(toToolResult({ content: ['l1', 'l2'], count: 2 }).content[0].type, 'text', 'strings are not content items');
	assert.deepEqual(JSON.parse(toToolResult({ content: ['l1'], count: 1 }).content[0].text), { content: ['l1'], count: 1 });
	const circular = {};
	circular.self = circular;
	const bad = { handler: () => circular };
	const failed = await callToolModule(bad, {}, {});
	assert.equal(failed.isError, true);
	const badShaped = { handler: () => ({ content: [{ type: 'text', text: 'x', extra: 10n }] }) };
	assert.equal((await callToolModule(badShaped, {}, {})).isError, true);
});
