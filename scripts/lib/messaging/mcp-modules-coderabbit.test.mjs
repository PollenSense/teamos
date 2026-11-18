import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { callToolModule, loadToolModules } from './mcp-modules.mjs';
import { withProject, withServer } from './mcp-test-helper.mjs';

// Regression tests for the CodeRabbit findings on PR #18 (2026-11-17).

const GOOD = (name) => `export const tools = [{ name: '${name}', description: 'Fine.', inputSchema: { type: 'object' }, handler: () => 'ok' }];\n`;

async function withModules(files, fn) {
	const dir = await mkdtemp(join(tmpdir(), 'teamos-mcpcr-'));
	try {
		for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text, 'utf-8');
		const load = async (modulePaths) => {
			const lines = [];
			const result = await loadToolModules({ modulePaths, repoRoot: dir, context: { teamDir: join(dir, 'team'), repoRoot: dir, config: {} }, log: (line) => lines.push(line), timeoutMs: 2000 });
			return { ...result, lines };
		};
		await fn(load);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const names = (out) => out.tools.map((t) => t.definition.name);

// --- finding 1: describe() must not throw inside the catch blocks that isolate module code ---

test('a module that throws something with no toString, or an error whose message getter throws, is skipped; the sibling loads', () =>
	withModules(
		{
			'null-proto.mjs': 'export function registerTools() { throw Object.create(null); }\n',
			'bad-getter.mjs': "export function registerTools() { throw { get message() { throw new Error('inner'); } }; }\n",
			'plain.mjs': "export function registerTools() { throw new Error('ordinary failure'); }\n",
			'good.mjs': GOOD('good_tool'),
		},
		async (load) => {
			const out = await load(['null-proto.mjs', 'bad-getter.mjs', 'plain.mjs', 'good.mjs']);
			assert.deepEqual(names(out), ['good_tool']);
			assert.equal(out.problems.length, 3);
			assert.ok(out.problems.every((line) => line.startsWith('tool module ') && line.includes('not loaded:')));
			assert.ok(out.problems.some((line) => line.endsWith('ordinary failure')), 'an ordinary Error keeps its message');
		},
	));

test('a tool whose definition throws something with no toString is skipped, its siblings stay', () =>
	withModules(
		{
			'hostile.mjs': `export const tools = [
	{ get name() { throw Object.create(null); }, description: 'd', inputSchema: { type: 'object' }, handler() {} },
	{ name: 'sibling_tool', description: 'Fine.', inputSchema: { type: 'object' }, handler: () => 'ok' },
];\n`,
		},
		async (load) => {
			const out = await load(['hostile.mjs']);
			assert.deepEqual(names(out), ['sibling_tool']);
			assert.equal(out.problems.length, 1);
		},
	));

// --- finding 2: the definition check runs on the copy that is served ---

test('a schema whose toJSON answers something else is checked as served: skipped, siblings stay, the name is not taken', () =>
	withModules(
		{
			'tojson.mjs': `export const tools = [
	{ name: 'null_schema', description: 'd', inputSchema: { type: 'object', toJSON() { return null; } }, handler() {} },
	{ name: 'string_schema', description: 'd', inputSchema: { type: 'object', toJSON() { return { type: 'string' }; } }, handler() {} },
	{ name: 'sibling_tool', description: 'Fine.', inputSchema: { type: 'object' }, handler: () => 'ok' },
];\n`,
			'later.mjs': "export const tools = [{ name: 'null_schema', description: 'Valid later.', inputSchema: { type: 'object' }, handler: () => 'later' }];\n",
		},
		async (load) => {
			const out = await load(['tojson.mjs', 'later.mjs']);
			assert.deepEqual(names(out), ['sibling_tool', 'null_schema']);
			assert.equal(out.tools[1].definition.description, 'Valid later.', 'the skipped tool did not take the name');
			assert.equal(out.problems.length, 2);
			assert.ok(out.problems.every((line) => /inputSchema/.test(line)), out.problems.join('\n'));
		},
	));

// --- finding 3: the result is serialised once, the way the reply is, and the snapshot is returned ---

test('a result whose toJSON answers by key: the snapshot is what the reply carries, an invalid one is an error result', async () => {
	const tool = (handler) => ({ definition: { name: 't' }, handler });
	const byKey = {
		content: [{ type: 'text', text: 'root' }],
		toJSON(key) {
			return { content: [{ type: 'text', text: `key:${key}` }] };
		},
	};
	const ok = await callToolModule(tool(() => byKey), {}, {});
	assert.equal(ok.isError, undefined);
	assert.equal(ok.content[0].text, 'key:result', 'serialised under the key the reply uses');
	assert.equal(typeof ok.toJSON, 'undefined', 'the snapshot is plain data');
	assert.equal(JSON.stringify(ok), JSON.stringify(ok));

	const breaksUnderResult = { content: [{ type: 'text', text: 'fine at the root' }], toJSON: (key) => (key === 'result' ? 5 : { content: [] }) };
	const bad = await callToolModule(tool(() => breaksUnderResult), {}, {});
	assert.equal(bad.isError, true);
	assert.match(bad.content[0].text, /not an MCP result/);

	const gone = await callToolModule(tool(() => ({ content: [{ type: 'text', text: 'x' }], toJSON: () => undefined })), {}, {});
	assert.equal(gone.isError, true);
});

// --- findings 2-5 through the real server ---

async function configure(dir, modules, files = {}) {
	for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text, 'utf-8');
	await writeFile(join(dir, 'teamos.config.json'), JSON.stringify({ mcp: { modules } }), 'utf-8');
}

test('a toJSON schema does not stop the server from starting; the tool list keeps its sibling', { timeout: 20000 }, () =>
	withProject(async (dir) => {
		await configure(dir, ['m.mjs'], {
			'm.mjs': `export const tools = [
	{ name: 'null_schema', description: 'd', inputSchema: { type: 'object', toJSON() { return null; } }, handler() {} },
	{ name: 'sibling_tool', description: 'Fine.', inputSchema: { type: 'object' }, handler: () => ({ ok: true }) },
];\n`,
		});
		await withServer(dir, async ({ call, tool }) => {
			const listed = (await call('tools/list', {})).result.tools.map((t) => t.name);
			assert.ok(listed.includes('sibling_tool'));
			assert.ok(!listed.includes('null_schema'));
			assert.equal((await tool('sibling_tool', {})).json.ok, true);
		});
	}));

test('a result that changes under the key "result" gives an error result over the wire, and the server keeps answering', { timeout: 20000 }, () =>
	withProject(async (dir) => {
		await configure(dir, ['m.mjs'], {
			'm.mjs': `export const tools = [{ name: 'shifty_tool', description: 'd', inputSchema: { type: 'object' },
	handler: () => ({ content: [{ type: 'text', text: 'fine at the root' }], toJSON: (key) => (key === 'result' ? 5 : { content: [] }) }) }];\n`,
		});
		await withServer(dir, async ({ tool }) => {
			const out = await tool('shifty_tool', {});
			assert.equal(out.isError, true);
			assert.equal((await tool('list_inbox', { member: 'alice' })).json.length, 0);
		});
	}));

test('a timer that throws, or a rejection, started while a module is still registering does not kill the server', { timeout: 20000 }, () =>
	withProject(async (dir) => {
		await configure(dir, ['early.mjs'], {
			'early.mjs': `export async function registerTools() {
	setTimeout(() => { throw new Error('early throw'); }, 10);
	Promise.reject(new Error('early rejection'));
	await new Promise((resolve) => setTimeout(resolve, 150)); // still loading when both fire
	return [{ name: 'early_tool', description: 'Fine.', inputSchema: { type: 'object' }, handler: () => ({ ok: true }) }];
}\n`,
		});
		const seen = [];
		await withServer(
			dir,
			async ({ tool }) => {
				assert.equal((await tool('early_tool', {})).json.ok, true);
				assert.equal((await tool('list_inbox', { member: 'alice' })).json.length, 0);
			},
			'alice',
			{ onStderr: (text) => seen.push(text) },
		);
		const log = seen.join('');
		assert.match(log, /uncaught exception \(module code\?\): early throw/);
		assert.match(log, /unhandled rejection \(module code\?\): early rejection/);
	}));

test('console.log, info and debug go to stderr: stdout carries the protocol only (the test helper fails on any other line)', { timeout: 20000 }, () =>
	withProject(async (dir) => {
		await configure(dir, ['chatty.mjs'], {
			'chatty.mjs': `console.log('module top level');
export function registerTools() {
	console.info('registering');
	return [{ name: 'chatty_tool', description: 'Prints.', inputSchema: { type: 'object' },
		handler: () => { console.log('in the handler'); console.debug('debug line'); return { ok: true }; } }];
}\n`,
		});
		const seen = [];
		await withServer(
			dir,
			async ({ tool }) => {
				assert.equal((await tool('chatty_tool', {})).json.ok, true);
			},
			'alice',
			{ onStderr: (text) => seen.push(text) },
		);
		const log = seen.join('');
		for (const expected of ['[runner] Loaded config from', 'module top level', 'registering', 'in the handler', 'debug line']) assert.ok(log.includes(expected), `stderr has "${expected}"`);
	}));
