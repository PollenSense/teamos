import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANIFEST_FILE, writeExport } from './index.mjs';
import { buildFixture } from './fixture-data.mjs';

// Regression tests for the second CodeRabbit review of PR #16 (2026-11-18, round 4): the cleanup of a folder with no
// manifest, and the folder the sync guard checks.

const FILTER = '- /team/board/raw/**\n';

function sandbox() {
	const root = mkdtempSync(join(tmpdir(), 'board-export-cr16r4-'));
	const workspace = join(root, 'pollen-bot');
	mkdirSync(join(workspace, 'team', 'board'), { recursive: true });
	return { root, workspace, out: join(root, 'linear-export'), guard: { workspaceRoot: workspace, filterText: FILTER }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const code = (c) => (e) => e.code === c;
const write = (s, dir = s.out, guard = s.guard) => writeExport(dir, { source: 'fixture', entities: buildFixture() }, guard);
const OWN_TEMP = 'issues.json.tmp-4242-0a1b2c3d';
const OTHER_TEMP = 'export.json.tmp-4242-0a1b2c3d';

// --- folder.mjs: a name that fits the temp pattern but is not a file (A6) ---

test('a folder with a temp-looking name is refused before anything is removed', async () => {
	const s = sandbox();
	try {
		mkdirSync(s.out);
		writeFileSync(join(s.out, OTHER_TEMP), 'half'); // ours: would be removed in a first write that was killed
		mkdirSync(join(s.out, OWN_TEMP)); // a FOLDER with a temp-looking name: not ours, and `rm` without recursive would throw EISDIR
		writeFileSync(join(s.out, OWN_TEMP, 'inside.txt'), 'mine');
		await assert.rejects(write(s), code('not-export-folder'));
		assert.deepEqual(readdirSync(s.out).sort(), [OTHER_TEMP, OWN_TEMP].sort(), 'nothing was removed, not even the file that would have been');
		assert.deepEqual(readdirSync(join(s.out, OWN_TEMP)), ['inside.txt']);
		assert.ok(!existsSync(join(s.out, MANIFEST_FILE)));
	} finally {
		s.cleanup();
	}
});

test('a link with a temp-looking name is refused, and neither the link nor what it points at is touched', async () => {
	const s = sandbox();
	try {
		mkdirSync(s.out);
		const elsewhere = join(s.root, 'elsewhere.txt');
		writeFileSync(elsewhere, 'mine');
		symlinkSync(elsewhere, join(s.out, OWN_TEMP));
		writeFileSync(join(s.out, OTHER_TEMP), 'half');
		await assert.rejects(write(s), code('not-export-folder'));
		assert.deepEqual(readdirSync(s.out).sort(), [OTHER_TEMP, OWN_TEMP].sort());
		assert.ok(existsSync(elsewhere));
	} finally {
		s.cleanup();
	}
});

test('regular temp files of a killed first write are still removed and the write goes on', async () => {
	const s = sandbox();
	try {
		mkdirSync(s.out);
		writeFileSync(join(s.out, OWN_TEMP), 'half');
		writeFileSync(join(s.out, OTHER_TEMP), 'half');
		await write(s);
		assert.ok(!readdirSync(s.out).some((n) => n.includes('.tmp-')));
		assert.ok(readdirSync(s.out).includes(MANIFEST_FILE));
	} finally {
		s.cleanup();
	}
});

// --- folder.mjs: the guard checks the folder the writer writes (A8) ---

/**
 * `<root>/L/ws` is the workspace root as the caller names it: `L` is a link to `W/sub`, and `W/sub/ws` links back to
 * `W`, the real workspace. `../out` from there is `<root>/L/out` for the writer (physically `W/sub/out`, inside the
 * synced workspace) and `<root>/out` for a guard that joins it onto the real root (outside the workspace).
 */
function linkedWorkspace() {
	const root = mkdtempSync(join(tmpdir(), 'board-export-cr16r4-link-'));
	const real = join(root, 'W');
	mkdirSync(join(real, 'sub'), { recursive: true });
	mkdirSync(join(real, 'team', 'board'), { recursive: true });
	symlinkSync(real, join(real, 'sub', 'ws'));
	symlinkSync(join(real, 'sub'), join(root, 'L'));
	return { root, real, workspaceRoot: join(root, 'L', 'ws'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a relative folder with `..` under a workspace root that is a link is checked where it is written', async () => {
	const w = linkedWorkspace();
	try {
		const data = { source: 'fixture', entities: buildFixture() };
		// the filter keeps /team/board/raw local, not sub/out: the folder is inside the synced workspace and not filtered
		await assert.rejects(writeExport('../out', data, { workspaceRoot: w.workspaceRoot, filterText: FILTER }), code('export-synced'));
		assert.ok(!existsSync(join(w.real, 'sub', 'out')), 'nothing was written into the synced workspace');
		assert.ok(!existsSync(join(w.root, 'out')));
		// with a filter line for the folder it really is, the write goes ahead there
		await writeExport('../out', data, { workspaceRoot: w.workspaceRoot, filterText: '- /sub/out/**\n' });
		assert.ok(existsSync(join(w.real, 'sub', 'out', MANIFEST_FILE)));
	} finally {
		w.cleanup();
	}
});

test('without a workspace root the guard says so (an ExportError, not a crash)', async () => {
	const s = sandbox();
	try {
		await assert.rejects(write(s, s.out, { filterText: FILTER }), code('bad-path'));
		await assert.rejects(write(s, s.out, { workspaceRoot: '', filterText: FILTER }), code('bad-path'));
	} finally {
		s.cleanup();
	}
});
