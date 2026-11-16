import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './cli.mjs';
import { inventedWorkspace, makeFakeLinear } from './fake-linear.mjs';
import { FETCH_TYPES } from './index.mjs';
import { readExport } from '../board-export/index.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'board-fetch-linear.mjs');
// No key and no network in these tests: the environment is built from scratch, never from process.env.
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8', timeout: 30_000 });

function sandbox(filterText) {
	const root = mkdtempSync(join(tmpdir(), 'linear-cli-'));
	const workspace = join(root, 'pollen-bot');
	mkdirSync(join(workspace, 'scripts'), { recursive: true });
	writeFileSync(join(workspace, 'scripts', 'rclone-filter.txt'), filterText);
	return { root, workspace, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('usage errors exit 2 and name the problem', () => {
	assert.equal(run([]).status, 2);
	assert.match(run([]).stderr, /--workspace and --out are required/);
	assert.equal(run(['--bogus']).status, 2);
	const s = sandbox('');
	try {
		const r = run(['--workspace', s.workspace, '--out', join(s.root, 'out'), '--types', 'issues,secrets']);
		assert.equal(r.status, 2);
		assert.match(r.stderr, /"secrets" is not a type/);
		const missing = run(['--workspace', join(s.root, 'nowhere'), '--out', join(s.root, 'out')]);
		assert.equal(missing.status, 2);
		assert.match(missing.stderr, /cannot read the filter file/);
	} finally {
		s.cleanup();
	}
});

test('an export folder inside the synced workspace that the filter does not keep local fails before any request', () => {
	const s = sandbox('- /team/.logs/**\n');
	try {
		const out = join(s.workspace, 'team', 'board', 'raw', 'export');
		const r = run(['--workspace', s.workspace, '--out', out, '--dry-run']);
		assert.equal(r.status, 1, r.stderr);
		assert.match(r.stderr, /does not keep it local/);
		assert.ok(!/LINEAR_API_KEY/.test(r.stderr), 'the guard ran before the key was looked for');
		assert.equal(existsSync(out), false);
	} finally {
		s.cleanup();
	}
});

test('with the folder allowed and no key set, the run stops with a clear message and writes nothing', () => {
	const s = sandbox('- /team/board/raw/**\n');
	try {
		const out = join(s.root, 'export');
		const r = run(['--workspace', s.workspace, '--out', out]);
		assert.equal(r.status, 1);
		assert.match(r.stderr, /LINEAR_API_KEY is not set/);
		assert.equal(r.stdout, '');
		assert.equal(existsSync(out), false);
	} finally {
		s.cleanup();
	}
});

// ---- the command line against a scripted Linear (no network, no real key) ----

const KEY = 'lin_api_TESTKEYinvented0123456789';

/** Run the CLI function with a fake Linear. Returns { code, out, err, fake }. */
async function cli(args, { data = inventedWorkspace(), fakeOpts = {}, env = { LINEAR_API_KEY: KEY } } = {}) {
	const fake = makeFakeLinear(data, fakeOpts);
	let out = '';
	let err = '';
	const code = await runCli(args, { env, fetchImpl: fake.fetchImpl, sleep: async () => {}, paceMs: 0, stdout: (t) => { out += t; }, stderr: (t) => { err += t; } });
	return { code, out, err, fake };
}

test('cli: a full run writes every type, marked complete, and prints counts only', async () => {
	const s = sandbox('- /team/board/raw/**\n');
	try {
		const out = join(s.root, 'export');
		const r = await cli(['--workspace', s.workspace, '--out', out]);
		assert.equal(r.code, 0, r.err);
		const { manifest, entities } = await readExport(out, { require: FETCH_TYPES });
		assert.equal(manifest.complete, true);
		assert.equal(entities.teams.length, 2);
		assert.match(r.out, /written to .*export; \d+ requests/);
		assert.match(r.out, /teams: 2/);
		assert.ok(!/Invented|Test Engineering|example\.invalid/.test(r.out + r.err), 'no title or address in the output');
		assert.ok(!(r.out + r.err).includes(KEY));
	} finally {
		s.cleanup();
	}
});

test('cli: --dry-run reads and checks everything and writes nothing; a record the format refuses fails even then', async () => {
	const s = sandbox('- /team/board/raw/**\n');
	try {
		const out = join(s.root, 'export');
		const ok = await cli(['--workspace', s.workspace, '--out', out, '--dry-run']);
		assert.equal(ok.code, 0, ok.err);
		assert.match(ok.out, /^dry run, nothing written/);
		assert.equal(existsSync(out), false);
		const bad = inventedWorkspace();
		bad['issues:t-1'][0].identifier = 'not a key';
		const r = await cli(['--workspace', s.workspace, '--out', out, '--dry-run'], { data: bad });
		assert.equal(r.code, 1, r.out);
		assert.equal(existsSync(out), false);
	} finally {
		s.cleanup();
	}
});

test('cli: --types reads only those types and marks the export incomplete; it never replaces an export that is there', async () => {
	const s = sandbox('- /team/board/raw/**\n');
	try {
		const partial = join(s.root, 'partial');
		const a = await cli(['--workspace', s.workspace, '--out', partial, '--types', 'teams']);
		assert.equal(a.code, 0, a.err);
		assert.deepEqual(readdirSync(partial).sort(), ['export.json', 'teams.json']);
		assert.equal(JSON.parse(readFileSync(join(partial, 'export.json'), 'utf8')).complete, false);
		await assert.rejects(readExport(partial, { require: ['teams'] }), (e) => e.code === 'export-incomplete');
		assert.ok(a.fake.requests.every((q) => q.name === 'teams'), 'only the teams document was sent');

		const full = join(s.root, 'full');
		assert.equal((await cli(['--workspace', s.workspace, '--out', full])).code, 0);
		const before = readdirSync(full).sort();
		const b = await cli(['--workspace', s.workspace, '--out', full, '--types', 'teams']);
		assert.equal(b.code, 2);
		assert.match(b.err, /partial one/);
		assert.equal(b.fake.requests.length, 0, 'refused before the first request');
		assert.deepEqual(readdirSync(full).sort(), before);
		assert.equal(JSON.parse(readFileSync(join(full, 'export.json'), 'utf8')).complete, true);

		// naming every type is a full export
		const all = join(s.root, 'all');
		assert.equal((await cli(['--workspace', s.workspace, '--out', all, '--types', FETCH_TYPES.join(',')])).code, 0);
		assert.equal(JSON.parse(readFileSync(join(all, 'export.json'), 'utf8')).complete, true);
	} finally {
		s.cleanup();
	}
});

test('cli: an empty --types list is a usage error', async () => {
	const s = sandbox('');
	try {
		const r = await cli(['--workspace', s.workspace, '--out', join(s.root, 'x'), '--types', ',']);
		assert.equal(r.code, 2);
		assert.match(r.err, /at least one type/);
		assert.equal(r.fake.requests.length, 0);
	} finally {
		s.cleanup();
	}
});

test('cli: a budget stop exits 3 and writes nothing', async () => {
	const s = sandbox('- /team/board/raw/**\n');
	try {
		const out = join(s.root, 'export');
		const r = await cli(['--workspace', s.workspace, '--out', out], { fakeOpts: { headers: () => ({ 'X-RateLimit-Requests-Remaining': '10' }) } });
		assert.equal(r.code, 3, r.err);
		assert.match(r.err, /only 10 Linear requests left/);
		assert.equal(existsSync(out), false);
	} finally {
		s.cleanup();
	}
});

test('cli: the read-only key variable alone is enough, and no key at all stops before any request', async () => {
	const s = sandbox('- /team/board/raw/**\n');
	try {
		const ro = await cli(['--workspace', s.workspace, '--out', join(s.root, 'e1'), '--dry-run'], { env: { LINEAR_API_KEY_RO: KEY } });
		assert.equal(ro.code, 0, ro.err);
		const none = await cli(['--workspace', s.workspace, '--out', join(s.root, 'e2'), '--dry-run'], { env: {} });
		assert.equal(none.code, 1);
		assert.equal(none.fake.requests.length, 0);
	} finally {
		s.cleanup();
	}
});
