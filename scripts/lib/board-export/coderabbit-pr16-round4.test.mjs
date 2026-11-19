import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANIFEST_FILE, assertLocalOnly, isSynced, parseFilter, writeExport } from './index.mjs';
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
/** Creating a symbolic link needs extra rights on Windows (EPERM): the tests that need one are skipped there. */
const NO_LINKS = process.platform === 'win32' ? 'a symbolic link needs extra rights on Windows' : false;

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

test('a link with a temp-looking name is refused, and neither the link nor what it points at is touched', { skip: NO_LINKS }, async () => {
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

test('a relative folder with `..` under a workspace root that is a link is checked where it is written', { skip: NO_LINKS }, async () => {
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

// --- sync-filter.mjs: an include rule ahead of the exclusion (A10) ---

const RAW = 'team/board/raw';
const EXCLUDE = '- /team/board/raw/**';
const guardWith = (s, lines) => assertLocalOnly(RAW, { workspaceRoot: s.workspace, filterText: `${lines.join('\n')}\n` });

test('an include rule ahead of the exclusion that names or matches something inside the folder is refused, though no probe path reaches it', () => {
	const s = sandbox();
	try {
		for (const [lines, firstLine] of [
			[['+ /team/board/raw/issues/PSE-1.json', EXCLUDE], 1],
			[['# keep the board local', '+ /team/board/raw/issues/PSE-*.json', EXCLUDE], 2],
			[['+ /team/board/raw/issues/**/*.json', EXCLUDE], 1],
			[['+ /team/board/raw', EXCLUDE], 1],
			[['+ PSE-1.json', EXCLUDE], 1],
			[['+ *.md', EXCLUDE], 1],
			[['+ /team/board/raw/a\\*b.json', EXCLUDE], 1],
		]) {
			// the generic probes all stay local, so only the new check can refuse it
			assert.ok(parseFilter(`${lines.join('\n')}\n`) && ['team/board/raw/probe.json', 'team/board/raw/a/probe.json', 'team/board/raw/a/b/probe.png', 'team/board/raw/.probe'].every((p) => !isSynced(parseFilter(`${lines.join('\n')}\n`), p)), lines.join(' | '));
			assert.throws(
				() => guardWith(s, lines),
				(e) => e.code === 'export-synced' && e.message.includes(`filter line ${firstLine}`),
				lines.join(' | '),
			);
		}
	} finally {
		s.cleanup();
	}
});

test('includes that cannot decide anything inside the folder do not stop the guard', () => {
	const s = sandbox();
	try {
		// after the exclusion: the first matching rule wins, so the include never gets a say
		assert.deepEqual(guardWith(s, [EXCLUDE, '+ /team/board/raw/issues/PSE-1.json', '+ *.md']), { where: 'filtered', rel: RAW });
		assert.equal(isSynced(parseFilter(`${EXCLUDE}\n+ /team/board/raw/issues/PSE-1.json\n`), 'team/board/raw/issues/PSE-1.json'), false, 'and that path really is local');
		// anchored somewhere else, ahead of the exclusion
		assert.deepEqual(guardWith(s, ['+ /team/board/files/**', '+ /team/board/rawer/x.json', EXCLUDE]), { where: 'filtered', rel: RAW });
		// a directory-only include does not let files below an excluded directory through
		assert.deepEqual(guardWith(s, ['+ /team/board/raw/issues/', EXCLUDE]), { where: 'filtered', rel: RAW });
		// the plain filter of the workspace
		assert.deepEqual(guardWith(s, ['- .git/**', '- /team/.logs/**', EXCLUDE]), { where: 'filtered', rel: RAW });
	} finally {
		s.cleanup();
	}
});

test('an include whose wildcard starts above or at the folder, or a folder kept local only by per-depth file rules, is refused too (independent review of round 4)', () => {
	const s = sandbox();
	try {
		const kept = (text) => ['team/board/raw/probe.json', 'team/board/raw/a/probe.json', 'team/board/raw/a/b/probe.png', 'team/board/raw/.probe'].every((p) => !isSynced(parseFilter(text), p));
		for (const [include, file] of [
			['+ /**/*.md', 'team/board/raw/issues/x.md'],
			['+ /**/PSE-1.json', 'team/board/raw/issues/PSE-1.json'],
			['+ /team/**/PSE-1.json', 'team/board/raw/issues/PSE-1.json'],
			['+ /team/board/**/PSE-1.json', 'team/board/raw/issues/PSE-1.json'],
			['+ /team/board/*/issues/*.json', 'team/board/raw/issues/PSE-1.json'],
			['+ /team/*/raw/issues/PSE-1.json', 'team/board/raw/issues/PSE-1.json'],
			['+ /*/board/raw/issues/x.md', 'team/board/raw/issues/x.md'],
			['+ /team/board/ra[w]/issues/x.md', 'team/board/raw/issues/x.md'],
			['+ /team/{board,x}/raw/issues/x.md', 'team/board/raw/issues/x.md'],
		]) {
			const text = `${include}\n${EXCLUDE}\n`;
			assert.ok(kept(text), `every probe stays local: ${include}`);
			assert.equal(isSynced(parseFilter(text), file), true, `${file} really syncs with ${include}`);
			assert.throws(() => guardWith(s, [include, EXCLUDE]), (e) => e.code === 'export-synced' && e.message.includes('filter line 1'), include);
		}
		// a deeper folder under a wildcard that starts above it
		assert.throws(
			() => assertLocalOnly('team/board/raw/export', { workspaceRoot: s.workspace, filterText: '+ /team/board/raw/**/*.md\n- /team/board/raw/export/**\n' }),
			(e) => e.code === 'export-synced' && e.message.includes('filter line 1'),
		);
		// kept local only by per-depth file rules: an include AFTER them still decides what they do not cover
		const perDepth = ['- /team/board/raw/*.json', '- /team/board/raw/*/*.json', '- /team/board/raw/*/*/*.png', '- /team/board/raw/.*', '+ /team/board/raw/**'];
		assert.ok(kept(`${perDepth.join('\n')}\n`));
		assert.equal(isSynced(parseFilter(`${perDepth.join('\n')}\n`), 'team/board/raw/issues/x.txt'), true);
		assert.throws(() => guardWith(s, perDepth), (e) => e.code === 'export-synced' && e.message.includes('filter line 5'));
		// the same include after a line that excludes the whole folder never gets to decide
		assert.deepEqual(guardWith(s, [EXCLUDE, '+ /team/board/raw/**', '+ /**/*.md']), { where: 'filtered', rel: RAW });
		// an include aimed at a sibling folder by a plain path passes; a wildcard above the folder is refused even when
		// its later segments could not match here (fail closed: move it below the exclusion)
		assert.deepEqual(guardWith(s, ['+ /team/board/files/**', EXCLUDE]), { where: 'filtered', rel: RAW });
		assert.throws(() => guardWith(s, ['+ /team/*/files/x.md', EXCLUDE]), (e) => e.code === 'export-synced');
	} finally {
		s.cleanup();
	}
});

// --- folder.mjs: only the writer's own file names count as its temp files (B1); a folder named like an omitted type does not stop the write (B2) ---

test('a temp-looking file with a name the writer never uses is somebody\'s: refused, nothing removed (B1)', async () => {
	for (const foreign of ['notes.json.tmp-1-abcdef01', 'Issues.json.tmp-1-abcdef01', 'issues.json.tmp-1-abcdef0', 'issues.json.tmp-1-abcdef012', 'issues.json.tmp--abcdef01', 'x.issues.json.tmp-1-abcdef01', 'export.json.bak.tmp-1-abcdef01']) {
		const s = sandbox();
		try {
			mkdirSync(s.out);
			writeFileSync(join(s.out, foreign), 'mine');
			writeFileSync(join(s.out, OWN_TEMP), 'half'); // the writer's own leftover next to it: it must survive the refusal too
			await assert.rejects(write(s), code('not-export-folder'), foreign);
			assert.deepEqual(readdirSync(s.out).sort(), [foreign, OWN_TEMP].sort(), `${foreign}: nothing was removed`);
			assert.equal(readFileSync(join(s.out, foreign), 'utf8'), 'mine');
		} finally {
			s.cleanup();
		}
	}
});

test('a temp file of every file name the writer makes (the manifest and each type) is still removed (B1)', async () => {
	const s = sandbox();
	try {
		mkdirSync(s.out);
		const names = [MANIFEST_FILE, ...Object.keys(buildFixture()).map((t) => `${t}.json`)];
		for (const [i, name] of names.entries()) writeFileSync(join(s.out, `${name}.tmp-${100 + i}-0a1b2c3d`), 'half');
		await write(s);
		assert.ok(!readdirSync(s.out).some((n) => n.includes('.tmp-')), 'every leftover was removed');
		assert.ok(readdirSync(s.out).includes(MANIFEST_FILE));
	} finally {
		s.cleanup();
	}
});

test('a folder named like a type that is left out stays, and the write finishes (B2)', async () => {
	const s = sandbox();
	try {
		await write(s);
		const all = buildFixture();
		const { issues, ...rest } = all;
		assert.ok(issues !== undefined, 'the fixture has issues');
		// the first export wrote issues.json as a file; make it a folder, as somebody else might have
		rmSync(join(s.out, 'issues.json'));
		mkdirSync(join(s.out, 'issues.json'));
		writeFileSync(join(s.out, 'issues.json', 'inside.txt'), 'mine');
		const { manifest } = await writeExport(s.out, { source: 'fixture', entities: rest }, s.guard);
		assert.deepEqual(readdirSync(join(s.out, 'issues.json')), ['inside.txt'], 'the folder is still there');
		assert.ok(!('issues' in manifest.entities), 'the manifest does not list the left-out type');
		const again = await writeExport(s.out, { source: 'fixture', entities: rest }, s.guard);
		assert.deepEqual(Object.keys(again.manifest.entities).sort(), Object.keys(rest).sort(), 'the manifest on disk is consistent');
	} finally {
		s.cleanup();
	}
});

test('a link named like a type that is left out stays, and what it points at is untouched (B2)', { skip: NO_LINKS }, async () => {
	const s = sandbox();
	try {
		await write(s);
		const { issues, ...rest } = buildFixture();
		assert.ok(issues !== undefined);
		const elsewhere = join(s.root, 'elsewhere.json');
		writeFileSync(elsewhere, 'mine');
		rmSync(join(s.out, 'issues.json'));
		symlinkSync(elsewhere, join(s.out, 'issues.json'));
		await writeExport(s.out, { source: 'fixture', entities: rest }, s.guard);
		assert.ok(lstatSync(join(s.out, 'issues.json')).isSymbolicLink(), 'the link is still there');
		assert.equal(readFileSync(elsewhere, 'utf8'), 'mine');
	} finally {
		s.cleanup();
	}
});

test('a left-out type whose file is an ordinary file of the writer is removed as before (B2)', async () => {
	const s = sandbox();
	try {
		await write(s);
		const { issues, ...rest } = buildFixture();
		assert.ok(issues !== undefined);
		await writeExport(s.out, { source: 'fixture', entities: rest }, s.guard);
		assert.ok(!existsSync(join(s.out, 'issues.json')));
	} finally {
		s.cleanup();
	}
});
