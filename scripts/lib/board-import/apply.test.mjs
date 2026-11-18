import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardStore } from '../board/index.mjs';
import { ImportError, applyReference, formatSummary, loadExisting, planReference, writeRaw } from './index.mjs';
import { MEMBERS, buildExport, buildInventorySizedExport } from './fixture.mjs';

function sandbox() {
	const root = mkdtempSync(join(tmpdir(), 'board-import-'));
	const dir = join(root, 'team', 'board');
	const lockDir = join(root, 'team', '.logs', 'board');
	mkdirSync(dir, { recursive: true });
	return {
		root,
		dir,
		rawDir: join(dir, 'raw'),
		store: (dryRun = false) => new BoardStore({ dir, lockDir, dryRun }),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** Every file under a folder with its size and mtime, so "nothing was written" can be proven. */
function snapshot(dir) {
	const out = {};
	const walk = (d) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else out[p] = `${st.size}:${st.mtimeMs}`;
		}
	};
	if (existsSync(dir)) walk(dir);
	return out;
}

async function run(s, entities, { dry = false, guard = async () => ({ where: 'test' }), options = {} } = {}) {
	const store = s.store(dry);
	const existing = await loadExisting(store);
	const plan = planReference(entities, { members: MEMBERS, existing, ...options });
	const result = await applyReference(plan, store, { rawDir: s.rawDir, guard });
	return { plan, ...result };
}

test('a real run writes every kind of file where the layout says', async () => {
	const s = sandbox();
	try {
		const r = await run(s, buildExport());
		for (const p of ['people.json', 'labels.json', 'project-map.json', 'teams/PSE.json', 'teams/INS.json', 'cycles/PSE/1.json', 'cycles/PSE/2.json', 'projects/test-project.md', 'projects/second-project.md', 'documents/d-1.md']) {
			assert.ok(existsSync(join(s.dir, p)), `${p} exists`);
		}
		assert.deepEqual(r.applied.teams, { created: 2, changed: 0, unchanged: 0, failed: 0 });
		assert.deepEqual(r.applied.projects, { created: 2, changed: 0, unchanged: 0, failed: 0 });
		const project = readFileSync(join(s.dir, 'projects', 'test-project.md'), 'utf8');
		assert.match(project, /^lead: "alice"$/m);
		const people = JSON.parse(readFileSync(join(s.dir, 'people.json'), 'utf8'));
		assert.equal(people.people['u-2'].former, true);
		assert.equal(readFileSync(join(s.dir, 'people.json'), 'utf8').includes('example.invalid'), false, 'no address on disk');
	} finally {
		s.cleanup();
	}
});

test('a second run writes nothing: every file the same, no file touched', async () => {
	const s = sandbox();
	try {
		await run(s, buildExport());
		const before = snapshot(s.dir);
		const again = await run(s, buildExport());
		assert.deepEqual(snapshot(s.dir), before, 'sizes and modification times unchanged');
		for (const [kind, a] of Object.entries(again.applied)) assert.equal(a.created + a.changed + a.failed, 0, `${kind}: nothing created or changed`);
		assert.equal(again.applied.projects.unchanged, 2);
	} finally {
		s.cleanup();
	}
});

test('a dry run writes nothing, not even a folder, and says what would be new', async () => {
	const s = sandbox();
	try {
		const before = snapshot(s.root);
		const r = await run(s, buildExport(), { dry: true, guard: async () => assert.fail('a dry run does not need the sync-filter guard') });
		const after = snapshot(s.root);
		assert.deepEqual(Object.keys(after).filter((p) => !p.includes(`${join('team', '.logs')}`)), Object.keys(before), 'no board file created');
		assert.equal(existsSync(join(s.dir, 'projects')), false);
		assert.equal(r.applied.projects.created, 2, 'two projects would be new');
		assert.match(formatSummary(r.plan, r, { dryRun: true }), /DRY RUN/);
		// after a real run the dry run reports the same
		await run(s, buildExport());
		const same = await run(s, buildExport(), { dry: true });
		assert.equal(same.applied.projects.unchanged, 2);
		assert.equal(same.applied.projects.created + same.applied.projects.changed, 0);
	} finally {
		s.cleanup();
	}
});

test('a dry run of the inventory-sized export counts the inventory and reports no failure', async () => {
	const s = sandbox();
	try {
		const r = await run(s, buildInventorySizedExport(), { dry: true });
		assert.equal(r.applied.projects.created, 63);
		assert.equal(r.applied.documents.created, 17);
		assert.equal(r.applied.teams.created, 4);
		assert.equal(r.applied.cycles.created, 40);
		assert.deepEqual(r.failures, {});
		const text = formatSummary(r.plan, r, { dryRun: true });
		assert.match(text, /projects\s+63\s+63/);
		assert.match(text, /documents\s+17\s+17/);
	} finally {
		s.cleanup();
	}
});

test('a real run asks the guard first; a guard that refuses leaves nothing behind', async () => {
	const s = sandbox();
	try {
		const refused = async () => {
			throw new ImportError('export-synced', 'the raw folder would sync');
		};
		await assert.rejects(run(s, buildExport(), { guard: refused }), (e) => e.code === 'export-synced');
		assert.equal(existsSync(join(s.dir, 'teams')), false);
		assert.equal(existsSync(join(s.dir, 'people.json')), false);
		assert.equal(existsSync(s.rawDir), false);
		const plan = planReference(buildExport(), { members: MEMBERS });
		await assert.rejects(applyReference(plan, s.store(), { rawDir: s.rawDir }), (e) => e.code === 'no-guard', 'no guard given: refused, not skipped');
		await assert.rejects(applyReference(plan, s.store(), { guard: async () => ({}) }), (e) => e.code === 'no-guard', 'no raw folder given: refused');
	} finally {
		s.cleanup();
	}
});

test('rule A on disk: the synced file holds [email], the raw file holds the original, written once', async () => {
	const s = sandbox();
	try {
		const e = buildExport();
		e.projects[0].description = 'Write to stranger@outside.example.invalid about it.';
		const r = await run(s, e);
		const synced = readFileSync(join(s.dir, 'projects', 'test-project.md'), 'utf8');
		assert.equal(synced.includes('stranger@'), false);
		assert.match(synced, /\[email\]/);
		const raw = readFileSync(join(s.rawDir, 'projects', 'test-project.json'), 'utf8');
		assert.match(raw, /stranger@outside\.example\.invalid/);
		assert.equal(statSync(join(s.rawDir, 'projects', 'test-project.json')).mode & 0o077, 0, 'raw file is private to the owner');
		assert.equal(statSync(join(s.rawDir, 'projects')).mode & 0o077, 0, 'raw type folder is private to the owner');
		assert.equal(statSync(s.rawDir).mode & 0o077, 0, 'raw folder is private to the owner');
		assert.equal(r.applied['raw projects'].created, 1);
		const again = await run(s, e);
		assert.equal(again.applied['raw projects'].unchanged, 1);
	} finally {
		s.cleanup();
	}
});

test('a raw write that fails stops the run before any synced file', async () => {
	const s = sandbox();
	try {
		const e = buildExport();
		e.projects[0].description = 'Write to stranger@outside.example.invalid about it.';
		writeFileSync(s.rawDir, 'a file where the folder should be');
		await assert.rejects(run(s, e));
		assert.equal(existsSync(join(s.dir, 'projects')), false, 'no redacted file without its raw copy');
		assert.equal(existsSync(join(s.dir, 'teams')), false);
	} finally {
		s.cleanup();
	}
});

test('writeRaw refuses a type or name that could leave its folder', async () => {
	const s = sandbox();
	try {
		await assert.rejects(writeRaw(s.rawDir, 'projects', '../x', {}), (e) => e.code === 'bad-raw');
		await assert.rejects(writeRaw(s.rawDir, 'secrets', 'x', {}), (e) => e.code === 'bad-raw');
		await assert.rejects(writeRaw(s.rawDir, 'projects', '', {}), (e) => e.code === 'bad-raw');
		assert.equal(existsSync(s.rawDir), false);
	} finally {
		s.cleanup();
	}
});

test('writeRaw refuses a type folder that is a link or not a folder: nothing reaches the target, in a real run or a dry one (round 2)', async () => {
	const s = sandbox();
	try {
		const synced = join(s.root, 'synced');
		mkdirSync(synced, { recursive: true });
		mkdirSync(s.rawDir, { recursive: true });
		symlinkSync(synced, join(s.rawDir, 'projects')); // raw/projects -> a folder that syncs
		symlinkSync(join(s.root, 'nowhere'), join(s.rawDir, 'documents')); // a link that points at nothing
		writeFileSync(join(s.rawDir, 'names'), 'a file where the folder should be');
		for (const type of ['projects', 'documents', 'names']) {
			for (const dryRun of [false, true]) {
				await assert.rejects(writeRaw(s.rawDir, type, 'P1', { text: 'original' }, { dryRun }), (e) => e instanceof ImportError && e.code === 'bad-raw' && !/original|synced/.test(e.message), `${type} dryRun=${dryRun}`);
			}
		}
		assert.deepEqual(readdirSync(synced), [], 'nothing was written through the link');
		assert.equal(existsSync(join(s.root, 'nowhere')), false, 'the dangling link was not created');
		assert.equal(readFileSync(join(s.rawDir, 'names'), 'utf8'), 'a file where the folder should be');
	} finally {
		s.cleanup();
	}
});

test('writeRaw still creates a missing type folder and writes into an existing real one (round 2)', async () => {
	const s = sandbox();
	try {
		assert.deepEqual(await writeRaw(s.rawDir, 'projects', 'P1', { a: 1 }, { dryRun: true }), { changed: true });
		assert.equal(existsSync(s.rawDir), false, 'a dry run creates nothing');
		assert.deepEqual(await writeRaw(s.rawDir, 'projects', 'P1', { a: 1 }), { changed: true });
		assert.deepEqual(await writeRaw(s.rawDir, 'projects', 'P1', { a: 1 }), { changed: false });
		assert.deepEqual(await writeRaw(s.rawDir, 'projects', 'P2', { a: 2 }), { changed: true });
		assert.deepEqual(readdirSync(join(s.rawDir, 'projects')).sort(), ['P1.json', 'P2.json']);
	} finally {
		s.cleanup();
	}
});

test('a project renamed in Linear keeps its file and its code', async () => {
	const s = sandbox();
	try {
		await run(s, buildExport());
		const renamed = buildExport();
		renamed.projects[0].name = 'Completely different name';
		const r = await run(s, renamed);
		assert.equal(r.applied.projects.changed, 1);
		assert.equal(r.applied.projects.created, 0);
		assert.deepEqual(readdirSync(join(s.dir, 'projects')).sort(), ['second-project.md', 'test-project.md']);
		assert.match(readFileSync(join(s.dir, 'projects', 'test-project.md'), 'utf8'), /^name: "Completely different name"$/m);
	} finally {
		s.cleanup();
	}
});

test('a field Linear cleared disappears, and a field somebody added by hand stays', async () => {
	const s = sandbox();
	try {
		await run(s, buildExport());
		const file = join(s.dir, 'projects', 'test-project.md');
		writeFileSync(file, readFileSync(file, 'utf8').replace('\n---\n', '\nnote: "added by hand"\n---\n'));
		const cleared = buildExport();
		delete cleared.projects[0].startDate;
		const r = await run(s, cleared);
		assert.equal(r.applied.projects.changed, 1);
		const text = readFileSync(file, 'utf8');
		assert.equal(/^startDate:/m.test(text), false);
		assert.match(text, /^note: "added by hand"$/m);
	} finally {
		s.cleanup();
	}
});

test('a damaged existing file is counted as failed and the rest of the run goes on', async () => {
	const s = sandbox();
	try {
		mkdirSync(join(s.dir, 'projects'), { recursive: true });
		writeFileSync(join(s.dir, 'projects', 'test-project.md'), 'no front matter at all\n');
		const r = await run(s, buildExport());
		assert.equal(r.applied.projects.failed, 1);
		assert.equal(r.applied.projects.created, 1);
		assert.deepEqual(r.failures, { damaged: 1 });
		assert.equal(readFileSync(join(s.dir, 'projects', 'test-project.md'), 'utf8'), 'no front matter at all\n', 'the damaged file is never overwritten');
		assert.ok(existsSync(join(s.dir, 'teams', 'PSE.json')));
		assert.match(formatSummary(r.plan, r, { dryRun: false }), /FAILED writes: damaged 1/);
		assert.match(formatSummary(r.plan, r, { dryRun: false }), /damaged project files left alone: 1/);
	} finally {
		s.cleanup();
	}
});

test('a team rewrite keeps the issue number the issues importer set', async () => {
	const s = sandbox();
	try {
		await run(s, buildExport());
		await s.store().raiseNextNumber('PSE', 1062);
		const r = await run(s, buildExport());
		assert.equal(r.applied.teams.unchanged, 2);
		assert.equal(JSON.parse(readFileSync(join(s.dir, 'teams', 'PSE.json'), 'utf8')).nextNumber, 1062);
	} finally {
		s.cleanup();
	}
});

test('the summary has counts and names of kinds only: no title, name, text or address', async () => {
	const s = sandbox();
	try {
		const e = buildExport();
		e.projects[0].description = 'Write to stranger@outside.example.invalid about it.';
		const r = await run(s, e);
		const text = formatSummary(r.plan, r, { dryRun: false });
		for (const secret of ['Test project', 'Second project', 'Invented', 'Test Person', 'stranger', 'example.invalid', 'alice', 'Area']) assert.equal(text.includes(secret), false, `"${secret}" is not in the summary`);
		assert.match(text, /1 projects, 0 documents and 0 team, state, label or cycle names had text redacted/);
	} finally {
		s.cleanup();
	}
});

test('a hand-edited tag in project-map.json survives a second run', async () => {
	const s = sandbox();
	try {
		await run(s, buildExport());
		const file = join(s.dir, 'project-map.json');
		const map = JSON.parse(readFileSync(file, 'utf8'));
		map.tags.ops = 'test-project';
		writeFileSync(file, `${JSON.stringify(map, null, '\t')}\n`);
		const r = await run(s, buildExport());
		assert.equal(JSON.parse(readFileSync(file, 'utf8')).tags.ops, 'test-project');
		assert.equal(r.applied['project-map'].unchanged, 1);
	} finally {
		s.cleanup();
	}
});

test('rule A on disk for names: the synced files hold [email], the raw names record holds the original, written once', async () => {
	const s = sandbox();
	try {
		const e = buildExport();
		e.labels[0].name = 'Mail other@outside.example.invalid';
		const r = await run(s, e);
		assert.equal(r.applied['raw names'].created, 1);
		const raw = readFileSync(join(s.rawDir, 'names', 'reference.json'), 'utf8');
		assert.match(raw, /other@outside/);
		assert.equal(readFileSync(join(s.dir, 'labels.json'), 'utf8').includes('other@'), false);
		assert.match(readFileSync(join(s.dir, 'labels.json'), 'utf8'), /\[email\]/);
		assert.match(formatSummary(r.plan, r, { dryRun: false }), /2 team, state, label or cycle names had text redacted/);
		const again = await run(s, e);
		assert.equal(again.applied['raw names'].unchanged, 1);
	} finally {
		s.cleanup();
	}
});
