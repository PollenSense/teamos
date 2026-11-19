import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'board-export-check.mjs');

function run(filterText, extra = []) {
	const ws = mkdtempSync(join(tmpdir(), 'board-check-'));
	try {
		mkdirSync(join(ws, 'scripts'), { recursive: true });
		writeFileSync(join(ws, 'scripts', 'rclone-filter.txt'), filterText);
		// a clean environment: the check reads no key and no setting
		const r = spawnSync(process.execPath, [SCRIPT, '--workspace', ws, ...extra], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
		return { code: r.status, out: r.stdout, err: r.stderr };
	} finally {
		rmSync(ws, { recursive: true, force: true });
	}
}

test('check: no filter line means raw/ would sync (exit 1); uploads sync', () => {
	const r = run('- /team/.logs/**\n');
	assert.equal(r.code, 1);
	assert.match(r.out, /WOULD SYNC +team\/board\/raw/);
	assert.match(r.out, /syncs +team\/board\/files/);
});

test('check: with the raw line, raw/ is local and uploads sync (exit 0)', () => {
	const r = run('- /team/.logs/**\n- /team/board/raw/**\n');
	assert.equal(r.code, 0, r.out + r.err);
	assert.match(r.out, /local +team\/board\/raw/);
	assert.match(r.out, /syncs +team\/board\/files/);
});

test('check: a filter that also hides the uploads is reported HIDDEN (exit 1)', () => {
	const r = run('- /team/board/raw/**\n- /team/board/files/**\n');
	assert.equal(r.code, 1);
	assert.match(r.out, /HIDDEN +team\/board\/files/);
	assert.match(r.out, /local +team\/board\/raw/);
});

test('check: --folder and --synced name their own folders; a missing filter file is a usage error (exit 2)', () => {
	const r = run('- /team/board/raw/**\n', ['--folder', 'team/board/raw', '--synced', 'team/board/issues']);
	assert.equal(r.code, 0, r.out + r.err);
	assert.match(r.out, /syncs +team\/board\/issues/);
	const missing = spawnSync(process.execPath, [SCRIPT, '--workspace', '/nonexistent-workspace-board-check'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
	assert.equal(missing.status, 2);
});

test('check: a filter that hides only SOME uploads is HIDDEN too (exit 1)', () => {
	for (const rule of ['- *.png', '- *.mov', '- /team/board/files/*/*', '- /team/board/files/*/*.png', '- /team/board/files/**/*.png', '- /team/board/files/*']) {
		const r = run(`- /team/board/raw/**\n${rule}\n`);
		assert.equal(r.code, 1, `${rule}: ${r.out}`);
		assert.match(r.out, /HIDDEN +team\/board\/files/, rule);
		assert.match(r.out, /local +team\/board\/raw/, rule);
	}
});

test('check: a --synced folder outside the workspace fails the run (nothing there reaches Drive)', () => {
	const elsewhere = mkdtempSync(join(tmpdir(), 'board-check-elsewhere-'));
	try {
		const r = run('- /team/board/raw/**\n', ['--synced', elsewhere]);
		assert.equal(r.code, 1, r.out + r.err);
		assert.match(r.out, /HIDDEN +/);
		assert.match(r.out, /outside the synced workspace/);
	} finally {
		rmSync(elsewhere, { recursive: true, force: true });
	}
});

test('check: --synced alone does not also check raw/, and an unreadable filter is a usage error even then', () => {
	const r = run('- /team/.logs/**\n', ['--synced', 'team/board/files']);
	assert.equal(r.code, 0, r.out + r.err);
	assert.match(r.out, /syncs +team\/board\/files/);
	assert.doesNotMatch(r.out, /team\/board\/raw/);
	const bad = run('- /team/board/raw/**\n', ['--synced', 'team/board/files', '--filter', '/nonexistent-filter-for-board-check']);
	assert.equal(bad.code, 2, bad.out + bad.err);
});
