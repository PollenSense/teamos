import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeExport } from './lib/board-export/index.mjs';
import { MEMBERS, buildExport } from './lib/board-import/fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ISSUES = join(HERE, 'board-import-issues.mjs');
const REFERENCE = join(HERE, 'board-import-reference.mjs');
const FILTER = '- /team/board/raw/**\n';

function sandbox({ importer = true, filter = FILTER } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'board-issues-cli-'));
	const workspace = join(root, 'pollen-bot');
	mkdirSync(join(workspace, 'team'), { recursive: true });
	mkdirSync(join(workspace, 'scripts'), { recursive: true });
	writeFileSync(join(workspace, 'teamos.config.json'), JSON.stringify({ board: { path: 'team/board', importer } }));
	writeFileSync(join(workspace, 'team', 'members.json'), JSON.stringify({ members: MEMBERS }));
	writeFileSync(join(workspace, 'scripts', 'rclone-filter.txt'), filter);
	return { root, workspace, exportDir: join(root, 'linear-export'), board: join(workspace, 'team', 'board'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function exported(s, entities = buildExport()) {
	const all = { ...Object.fromEntries(['comments', 'relations', 'attachments'].map((t) => [t, []])), ...entities };
	await writeExport(s.exportDir, { source: 'test', complete: true, entities: all }, { workspaceRoot: s.workspace, filterText: FILTER });
}

// A clean environment: these scripts read no key and no setting.
function run(script, s, ...extra) {
	const r = spawnSync(process.execPath, [script, '--workspace', s.workspace, '--export', s.exportDir, ...extra], { env: { PATH: process.env.PATH, HOME: s.root }, encoding: 'utf8' });
	return { code: r.status, out: r.stdout, err: r.stderr };
}
const issues = (s, ...extra) => run(ISSUES, s, ...extra);
const reference = (s, ...extra) => run(REFERENCE, s, ...extra);

test('a dry run prints counts per team and writes nothing, even with the importer switched off and before the reference import', async () => {
	const s = sandbox({ importer: false });
	try {
		await exported(s);
		const r = issues(s);
		assert.equal(r.code, 0, r.err);
		assert.match(r.out, /Issue import: DRY RUN, nothing written/);
		assert.match(r.out, /PSE +2 +2 +0 +0 +0 +0/);
		assert.match(r.out, /INS +1 +1 +0 +0 +0 +1/);
		assert.match(r.out, /aliases: 1 issues carry 1 earlier keys/);
		assert.equal(existsSync(s.board), false);
		for (const secret of ['Invented', 'example.invalid', 'alice', 'Test Person']) assert.equal(r.out.includes(secret), false, `"${secret}" is not printed`);
	} finally {
		s.cleanup();
	}
});

test('--apply is refused unless board.importer is true, and until the reference data is imported', async () => {
	const off = sandbox({ importer: false });
	const on = sandbox();
	try {
		await exported(off);
		const a = issues(off, '--apply');
		assert.equal(a.code, 2);
		assert.match(a.err, /board\.importer is not true/);
		await exported(on);
		const b = issues(on, '--apply');
		assert.equal(b.code, 2);
		assert.match(b.err, /run board-import-reference\.mjs --apply first/);
		assert.equal(existsSync(join(on.board, 'issues')), false);
	} finally {
		off.cleanup();
		on.cleanup();
	}
});

test('--apply writes after the reference import; a second --apply changes nothing; an old key opens the card', async () => {
	const s = sandbox();
	try {
		await exported(s);
		assert.equal(reference(s, '--apply').code, 0);
		const first = issues(s, '--apply');
		assert.equal(first.code, 0, first.out + first.err);
		assert.match(first.out, /Issue import: written/);
		assert.match(first.out, /checked on the files: 3 of 3 cards present, 1 of 1 aliases open their card, 1 of 1 children name their parent and the parent is a card/);
		assert.ok(existsSync(join(s.board, 'issues', 'PSE', 'PSE-2.md')));
		assert.match(readFileSync(join(s.board, 'issues', 'PSE', 'PSE-2.md'), 'utf8'), /aliases: \["INS-5"\]/);
		const second = issues(s, '--apply');
		assert.equal(second.code, 0, second.err);
		assert.match(second.out, /PSE +2 +0 +0 +2 +0/);
	} finally {
		s.cleanup();
	}
});

test('--apply stops before any write when the sync filter would let raw/ reach Drive', async () => {
	const s = sandbox({ filter: '- /team/.logs/**\n' });
	try {
		await exported(s);
		mkdirSync(s.board, { recursive: true });
		writeFileSync(join(s.board, 'people.json'), JSON.stringify({ version: 1, people: {} }));
		const r = issues(s, '--apply');
		assert.equal(r.code, 1);
		assert.match(r.err, /stopped \(export-synced\)/);
		assert.equal(existsSync(join(s.board, 'issues')), false);
	} finally {
		s.cleanup();
	}
});

test('an alias that is another issue\'s real key is not kept: the run still succeeds and says so', async () => {
	const s = sandbox();
	try {
		const e = buildExport();
		e.issues[2].previousKeys = ['PSE-2']; // INS-9 claims the key of a real card
		await exported(s, e);
		assert.equal(reference(s, '--apply').code, 0);
		const dry = issues(s);
		assert.match(dry.out, /1 NOT KEPT/, 'the dry run shows what the real run does');
		assert.equal(dry.code, 0);
		const r = issues(s, '--apply');
		assert.equal(r.code, 0, r.out + r.err);
		assert.match(r.out, /1 NOT KEPT/);
		assert.ok(existsSync(join(s.board, 'issues', 'INS', 'INS-9.md')));
		assert.ok(existsSync(join(s.board, 'issues', 'PSE', 'PSE-2.md')));
	} finally {
		s.cleanup();
	}
});

test('a damaged card with no alias and no child still makes the run exit 1 (the failed write alone decides)', async () => {
	const s = sandbox();
	try {
		await exported(s);
		assert.equal(reference(s, '--apply').code, 0);
		mkdirSync(join(s.board, 'issues', 'INS'), { recursive: true });
		writeFileSync(join(s.board, 'issues', 'INS', 'INS-9.md'), 'no front matter at all\n');
		const r = issues(s, '--apply');
		assert.equal(r.code, 1, r.out + r.err);
		assert.match(r.out, /FAILED writes: damaged 1/);
		assert.match(r.out, /checked on the files: 2 of 3 cards present, 1 of 1 aliases open their card, 1 of 1 children name their parent and the parent is a card/);
		assert.equal(readFileSync(join(s.board, 'issues', 'INS', 'INS-9.md'), 'utf8'), 'no front matter at all\n');
	} finally {
		s.cleanup();
	}
});

test('usage errors exit 2 and name no value; a members file or map of the wrong shape stops the run', async () => {
	const s = sandbox();
	try {
		assert.equal(spawnSync(process.execPath, [ISSUES, '--workspace'], { env: { PATH: process.env.PATH }, encoding: 'utf8' }).status, 2);
		await exported(s);
		writeFileSync(join(s.workspace, 'team', 'members.json'), JSON.stringify({ members: { alice: 1 } }));
		const a = issues(s);
		assert.equal(a.code, 2);
		assert.match(a.err, /members\.json has no "members" list/);
		writeFileSync(join(s.workspace, 'team', 'members.json'), JSON.stringify({ members: MEMBERS }));
		writeFileSync(join(s.root, 'x.json'), 'null');
		const b = issues(s, '--people-map', join(s.root, 'x.json'));
		assert.equal(b.code, 2);
		assert.match(b.err, /people map must be a JSON object/);
		const manifest = JSON.parse(readFileSync(join(s.exportDir, 'export.json'), 'utf8'));
		manifest.complete = false;
		writeFileSync(join(s.exportDir, 'export.json'), JSON.stringify(manifest));
		const c = issues(s);
		assert.equal(c.code, 1);
		assert.match(c.err, /stopped \(/);
	} finally {
		s.cleanup();
	}
});

test('--people-map, --members and --filter are honoured; a board that is switched off is a usage error', async () => {
	const s = sandbox();
	try {
		await exported(s);
		// --members: another file with a member whose e-mail matches u-2, so the creator of PSE-1 is that member's name
		writeFileSync(join(s.root, 'members2.json'), JSON.stringify({ members: [...MEMBERS, { name: 'carol', email: 'two@example.invalid', active: true }] }));
		assert.equal(reference(s, '--apply', '--members', join(s.root, 'members2.json')).code, 0);
		assert.equal(issues(s, '--apply', '--members', join(s.root, 'members2.json')).code, 0);
		assert.match(readFileSync(join(s.board, 'issues', 'PSE', 'PSE-1.md'), 'utf8'), /\ncreator: "carol"\n/);
		// --people-map: u-2 is bob instead
		writeFileSync(join(s.root, 'map.json'), JSON.stringify({ 'u-2': 'bob' }));
		const mapped = issues(s, '--apply', '--members', join(s.root, 'members2.json'), '--people-map', join(s.root, 'map.json'));
		assert.equal(mapped.code, 0, mapped.out + mapped.err);
		assert.match(readFileSync(join(s.board, 'issues', 'PSE', 'PSE-1.md'), 'utf8'), /\ncreator: "bob"\n/);
		// --filter: a filter file that lacks the raw line stops the run before any write
		writeFileSync(join(s.root, 'filter2.txt'), '- /team/.logs/**\n');
		const refused = issues(s, '--apply', '--filter', join(s.root, 'filter2.txt'));
		assert.equal(refused.code, 1);
		assert.match(refused.err, /stopped \(export-synced\)/);
		// a workspace with no board section
		writeFileSync(join(s.workspace, 'teamos.config.json'), JSON.stringify({}));
		const off = issues(s);
		assert.equal(off.code, 2);
		assert.match(off.err, /the board module is off/);
	} finally {
		s.cleanup();
	}
});
