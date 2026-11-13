import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
