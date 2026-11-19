import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeExport } from './lib/board-export/index.mjs';
import { MEMBERS, buildExport } from './lib/board-import/fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const UPLOADS = join(HERE, 'board-import-uploads.mjs');
const FILTER = '- /team/board/raw/**\n';
const link = (path) => `https://uploads.linear.app/ws/${path}`;

function sandbox({ importer = true, filter = FILTER } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'board-uploads-cli-'));
	const workspace = join(root, 'pollen-bot');
	mkdirSync(join(workspace, 'team'), { recursive: true });
	mkdirSync(join(workspace, 'scripts'), { recursive: true });
	writeFileSync(join(workspace, 'teamos.config.json'), JSON.stringify({ board: { path: 'team/board', importer } }));
	writeFileSync(join(workspace, 'team', 'members.json'), JSON.stringify({ members: MEMBERS }));
	writeFileSync(join(workspace, 'scripts', 'rclone-filter.txt'), filter);
	return { root, workspace, exportDir: join(root, 'linear-export'), board: join(workspace, 'team', 'board'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function exported(s) {
	const e = buildExport();
	e.issues[0].description = `Invented ![secret name](${link('pse1/one')}) and ${link('pse1/two')}`;
	e.comments = [{ id: 'cm-1', issueKey: 'PSE-1', body: `Again ${link('pse1/one')} and ${link('pse1/three')}`, createdAt: '2025-02-01T09:00:00.000Z', authorId: 'u-1' }];
	e.documents[0].content = `A document with ${link('docs/four')}`;
	e.relations = [];
	e.attachments = [];
	await writeExport(s.exportDir, { source: 'test', complete: true, entities: e }, { workspaceRoot: s.workspace, filterText: FILTER });
}

// A clean environment: no key unless the test gives one.
function run(s, env = {}, ...extra) {
	const r = spawnSync(process.execPath, [UPLOADS, '--workspace', s.workspace, '--export', s.exportDir, ...extra], { env: { PATH: process.env.PATH, HOME: s.root, ...env }, encoding: 'utf8' });
	return { code: r.status, out: r.stdout, err: r.stderr };
}

test('a dry run without a key only counts the links, says sizes were not asked, and writes nothing', async () => {
	const s = sandbox({ importer: false });
	try {
		await exported(s);
		const r = run(s);
		assert.equal(r.code, 0, r.err);
		assert.match(r.out, /Uploads import: DRY RUN, nothing written/);
		assert.match(r.out, /found: 3 distinct links \(2 in descriptions, 2 in comments\) on 1 issue keys; 0 refused; 1 more only in documents/);
		assert.match(r.out, /sizes not asked \(no key in the environment\)/);
		assert.match(r.out, /files folder: synced \(reaches Drive\)/);
		assert.equal(existsSync(s.board), false);
		for (const secret of ['secret name', 'uploads.linear.app', 'pse1', 'Invented']) assert.equal(r.out.includes(secret), false, `"${secret}" is not printed`);
	} finally {
		s.cleanup();
	}
});

test('a files folder the sync filter hides is reported, not refused', async () => {
	const s = sandbox({ filter: `${FILTER}- /team/board/files/**\n` });
	try {
		await exported(s);
		const r = run(s);
		assert.equal(r.code, 0, r.err);
		assert.match(r.out, /files folder: NOT SYNCED: the sync filter hides/);
	} finally {
		s.cleanup();
	}
});

test('--apply is refused unless board.importer is true and a key is in the environment', async () => {
	const off = sandbox({ importer: false });
	const on = sandbox();
	try {
		await exported(off);
		const a = run(off, { LINEAR_API_KEY_RO: 'lin_api_DUMMYDUMMYDUMMY' }, '--apply');
		assert.equal(a.code, 2);
		assert.match(a.err, /board\.importer is not true/);
		await exported(on);
		const b = run(on, {}, '--apply');
		assert.equal(b.code, 2);
		assert.match(b.err, /needs LINEAR_API_KEY_RO/);
		assert.equal(existsSync(join(on.board, 'files')), false);
	} finally {
		off.cleanup();
		on.cleanup();
	}
});

test('a real run with no cards on the board asks for nothing, says the links are not placed and writes no file', async () => {
	const s = sandbox();
	try {
		await exported(s);
		const r = run(s, { LINEAR_API_KEY_RO: 'lin_api_DUMMYDUMMYDUMMY' }, '--apply');
		assert.equal(r.code, 0, r.err + r.out);
		assert.match(r.out, /Uploads import: written/);
		assert.match(r.out, /1 keys have no card \(3 links not placed: import the issues first\)/);
		assert.match(r.out, /downloaded 0 /);
		assert.equal(r.out.includes('lin_api'), false);
		assert.equal(existsSync(join(s.board, 'files')), false);
	} finally {
		s.cleanup();
	}
});

test('the caps must be numbers of megabytes', async () => {
	const s = sandbox();
	try {
		await exported(s);
		for (const bad of ['0', '-5', 'many', '1e9']) assert.equal(run(s, {}, '--max-file-mb', bad).code, 2, bad);
		assert.equal(run(s, {}, '--max-file-mb', '5', '--max-total-mb', '200').code, 0);
		assert.equal(run(s, {}, '--bogus').code, 2);
	} finally {
		s.cleanup();
	}
});

test('an error the importer does not know prints its kind only, never a message or a path', async () => {
	const s = sandbox();
	try {
		await exported(s);
		mkdirSync(s.board, { recursive: true });
		writeFileSync(join(s.board, 'raw'), 'not a folder'); // the raw folder is a file: mkdir under it fails with ENOTDIR
		const r = run(s, { LINEAR_API_KEY_RO: 'lin_api_DUMMYDUMMYDUMMY' }, '--apply');
		assert.equal(r.code, 1);
		assert.match(r.err, /stopped \(unexpected: ENOTDIR\)/);
		assert.equal(r.err.includes(s.root), false, 'no path in the error text');
		assert.equal(r.err.includes('at '), false, 'no stack');
	} finally {
		s.cleanup();
	}
});
