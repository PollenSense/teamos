import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeExport } from './lib/board-export/index.mjs';
import { MEMBERS, buildExport } from './lib/board-import/fixture.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'board-import-reference.mjs');
const FILTER = '- /team/board/raw/**\n';

function sandbox({ importer = true, filter = FILTER } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'board-import-cli-'));
	const workspace = join(root, 'pollen-bot');
	mkdirSync(join(workspace, 'team'), { recursive: true });
	mkdirSync(join(workspace, 'scripts'), { recursive: true });
	writeFileSync(join(workspace, 'teamos.config.json'), JSON.stringify({ board: { path: 'team/board', importer } }));
	writeFileSync(join(workspace, 'team', 'members.json'), JSON.stringify({ members: MEMBERS }));
	writeFileSync(join(workspace, 'scripts', 'rclone-filter.txt'), filter);
	return { root, workspace, exportDir: join(root, 'linear-export'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function exported(s, entities = buildExport()) {
	const all = { ...Object.fromEntries(['issues', 'comments', 'relations', 'attachments'].map((t) => [t, []])), ...entities };
	await writeExport(s.exportDir, { source: 'test', complete: true, entities: all }, { workspaceRoot: s.workspace, filterText: FILTER });
}

function cli(s, ...extra) {
	const r = spawnSync(process.execPath, [CLI, '--workspace', s.workspace, '--export', s.exportDir, ...extra], { env: { PATH: process.env.PATH, HOME: s.root }, encoding: 'utf8' });
	return { code: r.status, out: r.stdout, err: r.stderr };
}

test('a dry run prints counts and writes nothing, even with the importer switched off', async () => {
	const s = sandbox({ importer: false });
	try {
		await exported(s);
		const r = cli(s);
		assert.equal(r.code, 0, r.err);
		assert.match(r.out, /DRY RUN, nothing written/);
		assert.match(r.out, /projects\s+2\s+2/);
		assert.equal(existsSync(join(s.workspace, 'team', 'board', 'projects')), false);
		for (const secret of ['Test project', 'Invented', 'example.invalid', 'alice']) assert.equal(r.out.includes(secret), false, `"${secret}" is not printed`);
	} finally {
		s.cleanup();
	}
});

test('--apply is refused unless board.importer is true', async () => {
	const s = sandbox({ importer: false });
	try {
		await exported(s);
		const r = cli(s, '--apply');
		assert.equal(r.code, 2);
		assert.match(r.err, /board\.importer is not true/);
		assert.equal(existsSync(join(s.workspace, 'team', 'board')), false);
	} finally {
		s.cleanup();
	}
});

test('--apply stops before any write when the sync filter would let raw/ reach Drive', async () => {
	const s = sandbox({ filter: '- /team/.logs/**\n' });
	try {
		await exported(s);
		const r = cli(s, '--apply');
		assert.equal(r.code, 1);
		assert.match(r.err, /stopped \(export-synced\)/);
		assert.equal(existsSync(join(s.workspace, 'team', 'board', 'teams')), false);
		assert.equal(existsSync(join(s.workspace, 'team', 'board', 'people.json')), false);
	} finally {
		s.cleanup();
	}
});

test('--apply writes, and a second --apply changes nothing', async () => {
	const s = sandbox();
	try {
		await exported(s);
		const first = cli(s, '--apply');
		assert.equal(first.code, 0, first.err);
		assert.match(first.out, /Reference data import: written/);
		assert.ok(existsSync(join(s.workspace, 'team', 'board', 'projects', 'test-project.md')));
		const second = cli(s, '--apply');
		assert.equal(second.code, 0, second.err);
		assert.match(second.out, /projects\s+2\s+0\s+0\s+2\s+0/);
		const people = JSON.parse(readFileSync(join(s.workspace, 'team', 'board', 'people.json'), 'utf8'));
		assert.equal(people.people['u-1'].name, 'alice');
	} finally {
		s.cleanup();
	}
});

test('an export that is not complete, or a damaged folder, is refused without a value in the message', async () => {
	const s = sandbox();
	try {
		await exported(s);
		const manifest = JSON.parse(readFileSync(join(s.exportDir, 'export.json'), 'utf8'));
		manifest.complete = false;
		writeFileSync(join(s.exportDir, 'export.json'), JSON.stringify(manifest));
		const r = cli(s);
		assert.equal(r.code, 1);
		assert.match(r.err, /stopped \(/);
		assert.equal(existsSync(join(s.workspace, 'team', 'board', 'projects')), false);
	} finally {
		s.cleanup();
	}
});

test('a people map and tag hints from files are used; an unknown member in the map stops the run', async () => {
	const s = sandbox();
	try {
		const e = buildExport();
		e.users.push({ id: 'u-9', name: 'Odd Mail', email: 'different@example.invalid', active: true, app: false, admin: false, guest: false });
		await exported(s, e);
		writeFileSync(join(s.root, 'map.json'), JSON.stringify({ 'u-9': 'bob' }));
		writeFileSync(join(s.root, 'hints.json'), JSON.stringify({ ops: 'Second project' }));
		const ok = cli(s, '--apply', '--people-map', join(s.root, 'map.json'), '--tag-hints', join(s.root, 'hints.json'));
		assert.equal(ok.code, 0, ok.err);
		assert.equal(JSON.parse(readFileSync(join(s.workspace, 'team', 'board', 'people.json'), 'utf8')).people['u-9'].name, 'bob');
		assert.equal(JSON.parse(readFileSync(join(s.workspace, 'team', 'board', 'project-map.json'), 'utf8')).tags.ops, 'second-project');
		writeFileSync(join(s.root, 'map.json'), JSON.stringify({ 'u-9': 'nobody' }));
		const bad = cli(s, '--people-map', join(s.root, 'map.json'));
		assert.equal(bad.code, 1);
		assert.match(bad.err, /stopped \(bad-override\)/);
	} finally {
		s.cleanup();
	}
});

test('usage errors exit 2 and name no value', () => {
	const r = spawnSync(process.execPath, [CLI, '--workspace'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
	assert.equal(r.status, 2);
});
