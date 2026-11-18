import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANIFEST_FILE, TYPE_NAMES, UPLOAD_EXTENSIONS, assertLocalOnly, assertSynced, exportFilePaths, readExport, uploadProbePaths, writeExport } from './index.mjs';
import { buildFixture } from './fixture-data.mjs';

// Regression tests for the CodeRabbit findings on PR #16 (2026-11-17).

const FILTER = '- /team/board/raw/**\n';

function sandbox() {
	const root = mkdtempSync(join(tmpdir(), 'board-export-cr16-'));
	const workspace = join(root, 'pollen-bot');
	mkdirSync(join(workspace, 'team', 'board'), { recursive: true });
	return { root, workspace, out: join(root, 'linear-export'), guard: { workspaceRoot: workspace, filterText: FILTER }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const code = (c) => (e) => e.code === c;
/** Creating a symbolic link needs extra rights on Windows (EPERM): what needs one is skipped there. */
const NO_LINKS = process.platform === 'win32' ? 'a symbolic link needs extra rights on Windows' : false;
const write = (s, entities = buildFixture(), options) => writeExport(s.out, { source: 'fixture', entities }, s.guard, options);

// --- folder.mjs: a killed first write (finding 5) ---

test('a first write killed after some entity files were renamed in (no manifest) is retried', async () => {
	const s = sandbox();
	try {
		await write(s);
		rmSync(join(s.out, MANIFEST_FILE)); // the state a kill leaves: the entity files, the manifest not yet written
		assert.ok(readdirSync(s.out).includes('teams.json'));
		const fixture = buildFixture();
		fixture.users = fixture.users.slice(0, 1);
		await write(s, fixture);
		const back = await readExport(s.out);
		assert.equal(back.entities.users.length, 1, 'the second write replaced the leftovers');
		assert.deepEqual(readdirSync(s.out).sort(), [MANIFEST_FILE, ...TYPE_NAMES.map((t) => `${t}.json`)].sort());
	} finally {
		s.cleanup();
	}
});

test('only the writer\'s own leftovers are removed: a foreign file with an entity name, a link, or another version is refused and nothing is touched', async () => {
	const s = sandbox();
	try {
		await write(s);
		rmSync(join(s.out, MANIFEST_FILE));
		const before = readFileSync(join(s.out, 'teams.json'), 'utf8');
		// somebody else's issues.json: not the writer's header
		writeFileSync(join(s.out, 'issues.json'), '[1, 2, 3]\n');
		await assert.rejects(write(s), code('not-export-folder'));
		assert.equal(readFileSync(join(s.out, 'issues.json'), 'utf8'), '[1, 2, 3]\n');
		assert.equal(readFileSync(join(s.out, 'teams.json'), 'utf8'), before, 'the writer\'s own file next to it was not removed either');
		// the header of another format version
		writeFileSync(join(s.out, 'issues.json'), '{"type":"issues","version":2,"records":[]}\n');
		await assert.rejects(write(s), code('not-export-folder'));
		// the header of another type
		writeFileSync(join(s.out, 'issues.json'), '{"type":"teams","version":1,"records":[]}\n');
		await assert.rejects(write(s), code('not-export-folder'));
		// a link with the right name (not on Windows: a symbolic link needs extra rights there)
		rmSync(join(s.out, 'issues.json'));
		if (!NO_LINKS) {
			writeFileSync(join(s.root, 'elsewhere.json'), before);
			symlinkSync(join(s.root, 'elsewhere.json'), join(s.out, 'issues.json'));
			await assert.rejects(write(s), code('not-export-folder'));
			assert.equal(existsSync(join(s.root, 'elsewhere.json')), true);
			rmSync(join(s.out, 'issues.json'));
		}
		mkdirSync(join(s.out, 'issues.json'));
		await assert.rejects(write(s), code('not-export-folder'));
		// and a name that is not an entity type at all
		rmSync(join(s.out, 'issues.json'), { recursive: true });
		writeFileSync(join(s.out, 'notes.json'), '{"type":"notes","version":1,"records":[]}\n');
		await assert.rejects(write(s), code('not-export-folder'));
		assert.equal(readFileSync(join(s.out, 'teams.json'), 'utf8'), before);
	} finally {
		s.cleanup();
	}
});

// --- folder.mjs: validate what the reader will see (finding 6) ---

test('records that pass in memory but fail after the JSON round trip are refused before anything is written', async () => {
	const sparse = buildFixture();
	sparse.projects[0].teamKeys = new Array(2); // holes: every() skips them, JSON writes null
	sparse.projects[0].teamKeys[0] = 'PSE';
	const withDate = buildFixture();
	withDate.attachments = [{ id: 'a-1', issueKey: 'PSE-1', url: 'https://example.invalid/x', metadata: new Date(0) }]; // a Date passes as a plain object in memory; JSON writes a string, which is not an object
	// Both must fail the way the reader would have failed.
	for (const [what, entities] of [['a sparse list of strings', sparse], ['a Date in an object field', withDate]]) {
		const s = sandbox();
		try {
			await assert.rejects(write(s, entities), code('invalid-record'), what);
			assert.equal(existsSync(s.out), false, `${what}: nothing was created`);
		} finally {
			s.cleanup();
		}
	}
});

test('what the reader would refuse for size is refused by the writer, and what cannot be JSON is an invalid-record', async () => {
	const s = sandbox();
	try {
		await assert.rejects(write(s, buildFixture(), { maxFileBytes: 200 }), code('file-too-large'));
		assert.equal(existsSync(s.out), false);
		const big = buildFixture();
		big.users[0].name = 12n; // BigInt: JSON.stringify throws
		await assert.rejects(write(s, big), code('invalid-record'));
		assert.equal(existsSync(s.out), false);
		// the cap is the reader's: a file the writer accepts is one the reader accepts
		await write(s, buildFixture(), { maxFileBytes: 1_000_000 });
		await readExport(s.out, { maxFileBytes: 1_000_000 });
	} finally {
		s.cleanup();
	}
});

// --- sync-filter.mjs (findings 7 and 8) ---

function workspace() {
	const root = mkdtempSync(join(tmpdir(), 'board-export-cr16ws-'));
	mkdirSync(join(root, 'team', 'board'), { recursive: true });
	return root;
}
const RAW = '- /team/board/raw/**\n';

test('exportFilePaths: the manifest and every entity file name', () => {
	const paths = exportFilePaths('team/board/raw');
	assert.equal(paths.length, 1 + TYPE_NAMES.length);
	assert.ok(paths.includes('team/board/raw/export.json'));
	assert.ok(paths.includes('team/board/raw/users.json'));
	assert.ok(paths.includes('team/board/raw/issues.json'));
});

test('assertLocalOnly: a filter that keeps one export file synced by name is refused, even when the generic probes stay local', () => {
	const ws = workspace();
	try {
		assert.deepEqual(assertLocalOnly('team/board/raw', { workspaceRoot: ws, filterText: RAW }), { where: 'filtered', rel: 'team/board/raw' });
		for (const name of ['users.json', 'export.json', 'issues.json']) {
			const filterText = `+ /team/board/raw/${name}\n${RAW}`;
			assert.throws(
				() => assertLocalOnly('team/board/raw', { workspaceRoot: ws, filterText }),
				(e) => e.code === 'export-synced' && /1 of \d+ probe paths would sync/.test(e.message),
				name,
			);
		}
	} finally {
		rmSync(ws, { recursive: true, force: true });
	}
});

test('uploadProbePaths: each named issue folder gets the whole upload shape, PSE-1 is not repeated', () => {
	const one = uploadProbePaths('team/board/files');
	const two = uploadProbePaths('team/board/files', ['PSE-1', 'PSE-2', 'INS-7']);
	assert.equal(two.length, one.length + 2 * (2 + UPLOAD_EXTENSIONS.length));
	assert.ok(two.includes('team/board/files/PSE-2/shot.png'));
	assert.ok(two.includes('team/board/files/INS-7/shot.mov'));
	assert.ok(two.includes('team/board/files/INS-7/a/b/shot.png'));
	assert.equal(new Set(two).size, two.length, 'no path twice');
});

test('assertSynced: a filter line for one existing issue folder (or one extension in it) is caught; a card with no folder yet is not probed', () => {
	const ws = workspace();
	try {
		const files = join(ws, 'team', 'board', 'files');
		const guard = (extra) => ({ workspaceRoot: ws, filterText: `${RAW}${extra}` });
		// no folder yet: the generic probes pass whatever is said about PSE-2
		assert.deepEqual(assertSynced('team/board/files', guard('- /team/board/files/PSE-2/**\n')), { where: 'synced', rel: 'team/board/files' });
		mkdirSync(join(files, 'PSE-2'), { recursive: true });
		mkdirSync(join(files, 'INS-7'), { recursive: true });
		mkdirSync(join(files, 'notes'), { recursive: true }); // not an issue folder: not probed
		writeFileSync(join(files, 'PSE-9'), 'a file, not a folder');
		assert.deepEqual(assertSynced('team/board/files', guard('')), { where: 'synced', rel: 'team/board/files' });
		for (const rule of ['- /team/board/files/PSE-2/**', '- /team/board/files/INS-7/*.mov', '- /team/board/files/INS-7/a/**', '- /team/board/files/PSE-2/']) {
			assert.throws(
				() => assertSynced('team/board/files', guard(`${rule}\n`)),
				(e) => e.code === 'export-hidden' && /filter line/.test(e.message),
				rule,
			);
		}
		// not probed: a line for a card with no folder, a line for the folder that is not an issue folder, a file named like an issue
		for (const rule of ['- /team/board/files/PSE-3/**', '- /team/board/files/notes/**', '- /team/board/files/PSE-9']) {
			assert.deepEqual(assertSynced('team/board/files', guard(`${rule}\n`)), { where: 'synced', rel: 'team/board/files' }, rule);
		}
		// the count in the message covers the folders that exist now
		assert.throws(
			() => assertSynced('team/board/files', guard('- /team/board/files/PSE-2/**\n')),
			(e) => new RegExp(`of ${uploadProbePaths('team/board/files', ['INS-7', 'PSE-2']).length} probe paths`).test(e.message),
		);
	} finally {
		rmSync(ws, { recursive: true, force: true });
	}
});

// --- folder.mjs: a relative folder is relative to the workspace root, not the current folder (round 2) ---

test('writeExport with a relative folder writes where the guard checked, not under the current folder', async () => {
	const s = sandbox();
	const before = process.cwd();
	try {
		const cwd = join(s.workspace, 'team'); // the guard's root is the workspace; the process runs one level down
		process.chdir(cwd);
		await writeExport('team/board/raw/export', { source: 'fixture', entities: buildFixture() }, s.guard);
		const where = join(s.workspace, 'team', 'board', 'raw', 'export');
		assert.ok(existsSync(join(where, MANIFEST_FILE)), 'the manifest is in the folder the guard checked');
		assert.equal(existsSync(join(cwd, 'team')), false, 'nothing was written under the current folder');
		assert.equal((await readExport(where)).manifest.source, 'fixture');
		// A killed first write in that folder is retried in the same place: its temp file is removed there too.
		rmSync(join(where, MANIFEST_FILE));
		const leftover = join(where, 'issues.json.tmp-123-abcdef01');
		writeFileSync(leftover, 'half');
		await writeExport('team/board/raw/export', { source: 'fixture', entities: buildFixture() }, s.guard);
		assert.ok(existsSync(join(where, MANIFEST_FILE)));
		assert.equal(existsSync(leftover), false, 'the leftover of the killed write is removed from the folder the guard checked');
		assert.equal(existsSync(join(cwd, 'team')), false);
		// A type that the next export does not have is removed from that folder as well.
		const fewer = buildFixture();
		delete fewer.users;
		assert.ok(existsSync(join(where, 'users.json')));
		await writeExport('team/board/raw/export', { source: 'fixture', entities: fewer }, s.guard);
		assert.equal(existsSync(join(where, 'users.json')), false);
		assert.equal(existsSync(join(cwd, 'team')), false);
	} finally {
		process.chdir(before);
		s.cleanup();
	}
});

test('a relative folder the filter does not keep local is refused before anything is created, wherever the process runs', async () => {
	const s = sandbox();
	const before = process.cwd();
	try {
		process.chdir(join(s.workspace, 'team'));
		await assert.rejects(writeExport('team/board/synced-export', { source: 'fixture', entities: buildFixture() }, s.guard), code('export-synced'));
		assert.equal(existsSync(join(s.workspace, 'team', 'board', 'synced-export')), false);
		assert.equal(existsSync(join(s.workspace, 'team', 'team')), false);
	} finally {
		process.chdir(before);
		s.cleanup();
	}
});

// --- folder.mjs: replaceExisting: false is checked inside the writer's own listing (round 2) ---

test('replaceExisting: false refuses a folder that already holds a manifest and changes nothing; the default still replaces', async () => {
	const s = sandbox();
	try {
		await write(s);
		const names = readdirSync(s.out).sort();
		const manifestBefore = readFileSync(join(s.out, MANIFEST_FILE), 'utf8');
		const fewer = buildFixture();
		delete fewer.users;
		await assert.rejects(write(s, fewer, { replaceExisting: false }), code('export-exists'));
		assert.deepEqual(readdirSync(s.out).sort(), names, 'no file was removed or added');
		assert.equal(readFileSync(join(s.out, MANIFEST_FILE), 'utf8'), manifestBefore);
		// a folder with no manifest is not "an export that is there": the first write goes through
		const fresh = sandbox();
		try {
			await write(fresh, buildFixture(), { replaceExisting: false });
			assert.ok(existsSync(join(fresh.out, MANIFEST_FILE)));
		} finally {
			fresh.cleanup();
		}
		// default, and an explicit true, replace
		await write(s, fewer);
		assert.equal(existsSync(join(s.out, 'users.json')), false);
		await write(s, buildFixture(), { replaceExisting: true });
		assert.ok(existsSync(join(s.out, 'users.json')));
	} finally {
		s.cleanup();
	}
});
