import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardError, BoardStore } from '../board/index.mjs';
import { ImportError, applyIssues, applyReference, formatIssuesSummary, formatSummary, loadExisting, planIssues, planReference, writeRaw } from './index.mjs';
import { MEMBERS, buildExport, buildInventorySizedExport, buildInventorySizedIssues } from './fixture.mjs';

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

// ---- issues (A5) ----

async function runIssues(s, entities, { dry = false, guard = async () => ({ where: 'test' }) } = {}) {
	const store = s.store(dry);
	const existing = await loadExisting(store);
	const reference = planReference(entities, { members: MEMBERS, existing });
	const plan = planIssues(entities, reference);
	const result = await applyIssues(plan, store, { rawDir: s.rawDir, guard });
	return { plan, ...result };
}

test('issues: a real run writes one file per issue under its team, with the text as the body', async () => {
	const s = sandbox();
	try {
		const r = await runIssues(s, buildExport());
		assert.deepEqual(r.failures, {});
		assert.equal(r.applied['issues PSE'].created, 2);
		assert.equal(r.applied['issues INS'].created, 1);
		const text = readFileSync(join(s.dir, 'issues', 'PSE', 'PSE-1.md'), 'utf8');
		assert.match(text, /^---\n/);
		assert.match(text, /\nid: "PSE-1"\n/);
		assert.match(text, /\nstatus: "Todo"\n/);
		assert.match(text, /\n---\n\nInvented description\.$/);
		assert.ok(existsSync(join(s.dir, 'issues', 'INS', 'INS-9.md')));
		assert.deepEqual(r.checks, { cardsChecked: 3, cardsMissing: 0, aliasesChecked: 1, aliasesBroken: 0, parentsChecked: 1, parentsBroken: 0 });
	} finally {
		s.cleanup();
	}
});

test('issues: a second run writes nothing and touches no file; an old key opens the card that moved', async () => {
	const s = sandbox();
	try {
		await runIssues(s, buildExport());
		const before = snapshot(s.dir);
		const again = await runIssues(s, buildExport());
		assert.deepEqual(again.failures, {});
		assert.equal(again.applied['issues PSE'].unchanged, 2);
		assert.equal(again.applied['issues PSE'].created + again.applied['issues PSE'].changed, 0);
		assert.deepEqual(snapshot(s.dir), before);
		const moved = await s.store().readIssue('ins-5');
		assert.equal(moved.id, 'PSE-2');
	} finally {
		s.cleanup();
	}
});

test('issues: a dry run writes nothing, not even a folder, and says what would be new', async () => {
	const s = sandbox();
	try {
		const r = await runIssues(s, buildExport(), { dry: true });
		assert.equal(r.applied['issues PSE'].created, 2);
		assert.equal(existsSync(join(s.dir, 'issues')), false);
		assert.equal(existsSync(s.rawDir), false);
		assert.deepEqual(r.checks, { cardsChecked: 0, cardsMissing: 0, aliasesChecked: 0, aliasesBroken: 0, parentsChecked: 0, parentsBroken: 0 });
		const text = formatIssuesSummary(r.plan, r, { dryRun: true });
		assert.match(text, /DRY RUN, nothing written/);
		assert.match(text, /team +read +new +changed +same +failed/, 'a dry run says new, not created');
		assert.doesNotMatch(text, /checked on the files/);
	} finally {
		s.cleanup();
	}
});

test('issues: a real run asks the guard first; a guard that refuses, or none, leaves nothing behind', async () => {
	const s = sandbox();
	try {
		const plan = planIssues(buildExport(), planReference(buildExport(), { members: MEMBERS }));
		await assert.rejects(applyIssues(plan, s.store(), { rawDir: s.rawDir, guard: async () => { throw new ImportError('export-synced', 'would sync'); } }), (e) => e.code === 'export-synced');
		await assert.rejects(applyIssues(plan, s.store(), { rawDir: s.rawDir }), (e) => e.code === 'no-guard');
		assert.equal(existsSync(join(s.dir, 'issues')), false);
		assert.equal(existsSync(s.rawDir), false);
	} finally {
		s.cleanup();
	}
});

test('issues, rule A on disk: the synced file holds [email], the raw file holds the original, written once', async () => {
	const s = sandbox();
	try {
		const e = buildExport();
		e.issues[0].description = 'Write to stranger@outside.example.invalid about it.';
		const r = await runIssues(s, e);
		assert.equal(r.applied['raw issues'].created, 1);
		assert.match(readFileSync(join(s.rawDir, 'issues', 'PSE-1.json'), 'utf8'), /stranger@outside/);
		const synced = readFileSync(join(s.dir, 'issues', 'PSE', 'PSE-1.md'), 'utf8');
		assert.equal(synced.includes('stranger@'), false);
		assert.match(synced, /\[email\]/);
		const again = await runIssues(s, e);
		assert.equal(again.applied['raw issues'].unchanged, 1);
		const text = formatIssuesSummary(r.plan, r, { dryRun: false });
		assert.match(text, /1 issues had a title, description or branch name redacted or left out/);
	} finally {
		s.cleanup();
	}
});

test('issues: a damaged file, or an alias that is the file of a card this export does not know, is counted as failed and the rest goes on', async () => {
	const s = sandbox();
	try {
		mkdirSync(join(s.dir, 'issues', 'PSE'), { recursive: true });
		writeFileSync(join(s.dir, 'issues', 'PSE', 'PSE-1.md'), 'no front matter at all\n');
		await s.store().writeIssue({ fields: { id: 'AER-1', linearId: 'lin-OTHER', title: 'Not in the export' }, body: '' }, { expect: 'new' });
		const e = buildExport();
		e.issues[2].previousKeys = ['AER-1'];
		const r = await runIssues(s, e);
		assert.equal(r.applied['issues PSE'].failed, 1, 'PSE-1 is damaged');
		assert.equal(r.applied['issues INS'].failed, 1, 'INS-9 claims the key of another card');
		assert.equal(r.applied['issues PSE'].created, 1, 'PSE-2 is written');
		assert.deepEqual(r.failures, { damaged: 1, 'alias-conflict': 1 });
		assert.equal(readFileSync(join(s.dir, 'issues', 'PSE', 'PSE-1.md'), 'utf8'), 'no front matter at all\n', 'never overwritten');
		assert.equal(existsSync(join(s.dir, 'issues', 'INS', 'INS-9.md')), false);
		// the promises are checked on the files: PSE-1 and INS-9 are not cards, INS-9's alias opens another card, PSE-2's parent cannot be opened
		assert.deepEqual(r.checks, { cardsChecked: 3, cardsMissing: 2, aliasesChecked: 2, aliasesBroken: 1, parentsChecked: 1, parentsBroken: 1 });
		const text = formatIssuesSummary(r.plan, r, { dryRun: false });
		assert.match(text, /FAILED writes: damaged 1, alias-conflict 1/);
		assert.match(text, /checked on the files: 1 of 3 cards present, 1 of 2 aliases open their card, 0 of 1 children name their parent and the parent is a card/);
	} finally {
		s.cleanup();
	}
});

test('issues: a key that is an alias of another card on disk is refused, and the check does not take the other card for it', async () => {
	const s = sandbox();
	try {
		await s.store().writeIssue({ fields: { id: 'AER-1', aliases: ['INS-9'], linearId: 'lin-OTHER', title: 'Not in the export' }, body: '' }, { expect: 'new' });
		const r = await runIssues(s, buildExport());
		assert.deepEqual(r.failures, { 'alias-conflict': 1 });
		assert.equal(r.checks.cardsMissing, 1, 'INS-9 opens AER-1, which is not INS-9');
		assert.equal(existsSync(join(s.dir, 'issues', 'INS', 'INS-9.md')), false);
	} finally {
		s.cleanup();
	}
});

test('issues: a key that is another issue\'s real key is not kept as an alias; the card is still written', async () => {
	const s = sandbox();
	try {
		const e = buildExport();
		e.issues[2].previousKeys = ['PSE-2'];
		const r = await runIssues(s, e);
		assert.deepEqual(r.failures, {});
		assert.equal(r.checks.aliasesBroken, 0);
		assert.equal(readFileSync(join(s.dir, 'issues', 'INS', 'INS-9.md'), 'utf8').includes('aliases'), false);
		assert.equal((await s.store().readIssue('PSE-2')).id, 'PSE-2');
		assert.match(formatIssuesSummary(r.plan, r, { dryRun: false }), /1 NOT KEPT/);
	} finally {
		s.cleanup();
	}
});

test('issues: a raw write that fails stops the run before any synced issue file', async () => {
	const s = sandbox();
	try {
		mkdirSync(s.dir, { recursive: true });
		writeFileSync(s.rawDir, 'a file where the raw folder should be');
		const e = buildExport();
		e.issues[0].description = 'Write to stranger@outside.example.invalid about it.';
		await assert.rejects(runIssues(s, e));
		assert.equal(existsSync(join(s.dir, 'issues')), false, 'no synced file was written');
	} finally {
		s.cleanup();
	}
});

test('issues: a field Linear cleared disappears, a field somebody added by hand stays, an earlier text is replaced', async () => {
	const s = sandbox();
	try {
		const e = buildExport();
		await runIssues(s, e);
		const path = join(s.dir, 'issues', 'PSE', 'PSE-1.md');
		writeFileSync(path, readFileSync(path, 'utf8').replace('\nid: "PSE-1"\n', '\nid: "PSE-1"\nmyfield: "kept"\n'));
		e.issues[0].dueDate = null;
		e.issues[0].description = 'A new text.';
		const r = await runIssues(s, e);
		assert.equal(r.applied['issues PSE'].changed, 1);
		const text = readFileSync(path, 'utf8');
		assert.equal(text.includes('dueDate'), false);
		assert.match(text, /myfield: "kept"/);
		assert.match(text, /\n---\n\nA new text\.$/);
	} finally {
		s.cleanup();
	}
});

test('issues: a card that moved teams since the last run stays ONE card: the old file is retired, its thread and later fields follow, the old key opens it', async () => {
	const s = sandbox();
	try {
		const e = buildExport();
		await runIssues(s, e);
		// the old card gets a thread and a field a later ticket owns
		const oldPath = join(s.dir, 'issues', 'PSE', 'PSE-2.md');
		writeFileSync(join(s.dir, 'issues', 'PSE', 'PSE-2.thread.md'), 'a thread\n');
		writeFileSync(oldPath, readFileSync(oldPath, 'utf8').replace('\nid: "PSE-2"\n', '\nid: "PSE-2"\nrelations: {"blocks":["PSE-1"]}\n'));
		// then Linear moves it: INS-5 was its first key, PSE-2 its second, REV-7 is now its key
		e.teams.push({ id: 't-3', key: 'REV', name: 'Test Revops', private: false, cyclesEnabled: false });
		Object.assign(e.issues[1], { key: 'REV-7', teamKey: 'REV', number: 7, previousKeys: ['INS-5', 'PSE-2'] });
		const dry = await runIssues(s, e, { dry: true });
		assert.equal(dry.moved, 1, 'the dry run says it would retire one');
		assert.ok(existsSync(oldPath), 'and does not');
		assert.match(formatIssuesSummary(dry.plan, dry, { dryRun: true }), /moved: 1 cards .* would be retired/);
		const r = await runIssues(s, e);
		assert.deepEqual(r.failures, {});
		assert.equal(r.moved, 1);
		assert.equal(existsSync(oldPath), false);
		assert.equal(existsSync(join(s.dir, 'issues', 'PSE', 'PSE-2.thread.md')), false);
		assert.equal(readFileSync(join(s.dir, 'issues', 'REV', 'REV-7.thread.md'), 'utf8'), 'a thread\n');
		assert.match(readFileSync(join(s.dir, 'issues', 'REV', 'REV-7.md'), 'utf8'), /\nrelations: \{"blocks":\["PSE-1"\]\}\n/);
		assert.equal((await s.store().readIssue('pse-2')).id, 'REV-7');
		assert.equal((await s.store().readIssue('INS-5')).id, 'REV-7');
		assert.deepEqual(r.checks, { cardsChecked: 3, cardsMissing: 0, aliasesChecked: 2, aliasesBroken: 0, parentsChecked: 1, parentsBroken: 0 });
		assert.match(formatIssuesSummary(r.plan, r, { dryRun: false }), /moved: 1 cards .* it is retired/);
		const again = await runIssues(s, e);
		assert.equal(again.moved, 0);
		assert.equal(Object.values(again.applied).reduce((n, a) => n + a.created + a.changed, 0), 0, 'a second run writes nothing');
	} finally {
		s.cleanup();
	}
});

test('issues: a rerun does not clear what a later ticket put in a card (relations, pull requests, links, deleted)', async () => {
	const s = sandbox();
	try {
		const e = buildExport();
		await runIssues(s, e);
		const path = join(s.dir, 'issues', 'PSE', 'PSE-1.md');
		writeFileSync(path, readFileSync(path, 'utf8').replace('\nid: "PSE-1"\n', '\nid: "PSE-1"\nrelations: {"blocks":["PSE-2"]}\nprs: [{"number":7}]\nlinks: ["https://example.invalid/x"]\ndeleted: true\n'));
		e.issues[0].title = 'A new title';
		const r = await runIssues(s, e);
		assert.equal(r.applied['issues PSE'].changed, 1);
		const text = readFileSync(path, 'utf8');
		assert.match(text, /title: "A new title"/);
		for (const kept of ['relations: {"blocks":["PSE-2"]}', 'prs: [{"number":7}]', 'links: ["https://example.invalid/x"]', 'deleted: true']) assert.ok(text.includes(kept), kept);
	} finally {
		s.cleanup();
	}
});

test('issues: a flagged text with a guard that refuses, or in a dry run, writes no raw file', async () => {
	const s = sandbox();
	try {
		const e = buildExport();
		e.issues[0].description = 'Write to stranger@outside.example.invalid about it.';
		await assert.rejects(runIssues(s, e, { guard: async () => { throw new ImportError('export-synced', 'would sync'); } }), (err) => err.code === 'export-synced');
		assert.equal(existsSync(s.rawDir), false, 'the guard ran before any raw write');
		const dry = await runIssues(s, e, { dry: true });
		assert.equal(dry.applied['raw issues'].created, 1, 'a dry run counts it');
		assert.equal(existsSync(s.rawDir), false, 'and writes none');
	} finally {
		s.cleanup();
	}
});

test('issues: a held lock stops the run at the first write instead of waiting on every one', async () => {
	const s = sandbox();
	try {
		const plan = planIssues(buildExport(), planReference(buildExport(), { members: MEMBERS }));
		let writes = 0;
		const locked = { dryRun: false, readIssue: async () => null, writeIssue: async () => { writes++; throw new BoardError('locked', 'held'); } };
		await assert.rejects(applyIssues(plan, locked, { rawDir: s.rawDir, guard: async () => ({}) }), (err) => err.code === 'locked');
		assert.equal(writes, 1);
	} finally {
		s.cleanup();
	}
});

test('issues: the check on the files notices a child whose file does not name its parent, and a card that is not there', async () => {
	const s = sandbox();
	try {
		const plan = planIssues(buildExport(), planReference(buildExport(), { members: MEMBERS }));
		const cards = { 'PSE-1': { id: 'PSE-1', fields: {} }, 'PSE-2': { id: 'PSE-2', fields: {} }, 'INS-5': { id: 'PSE-2', fields: {} } };
		const stub = { dryRun: false, readIssue: async (k) => cards[k] ?? null, writeIssue: async () => ({ changed: false, retired: [] }) };
		const r = await applyIssues(plan, stub, { rawDir: s.rawDir, guard: async () => ({}) });
		assert.deepEqual(r.checks, { cardsChecked: 3, cardsMissing: 1, aliasesChecked: 1, aliasesBroken: 0, parentsChecked: 1, parentsBroken: 1 }, 'INS-9 is not there; PSE-2 has no parent field');
	} finally {
		s.cleanup();
	}
});

test('issues: a project renamed in Linear keeps its code in the issue; the summary names dangling references by kind', async () => {
	const s = sandbox();
	try {
		const e = buildExport();
		await run(s, e);
		e.projects[0].name = 'A completely different name';
		e.issues[0].stateId = 's-nowhere';
		const r = await runIssues(s, e);
		assert.equal(readFileSync(join(s.dir, 'issues', 'PSE', 'PSE-1.md'), 'utf8').match(/\nproject: "(.*)"\n/)[1], 'test-project');
		assert.match(formatIssuesSummary(r.plan, r, { dryRun: false }), /dangling references: issues\.state 1/);
	} finally {
		s.cleanup();
	}
});

test('issues: the summary has counts only: no title, name, text or address', async () => {
	const s = sandbox();
	try {
		const e = buildExport();
		e.issues[0].description = 'Write to stranger@outside.example.invalid about it.';
		const r = await runIssues(s, e);
		const text = formatIssuesSummary(r.plan, r, { dryRun: false });
		for (const secret of ['Invented', 'stranger', 'example.invalid', 'alice', 'Area', 'Todo']) assert.equal(text.includes(secret), false, `"${secret}" is not in the summary`);
		assert.match(text, /PSE +2 /);
		assert.match(text, /aliases: 1 issues carry 1 earlier keys/);
		assert.match(text, /checked on the files: 3 of 3 cards present, 1 of 1 aliases open their card, 1 of 1 children name their parent and the parent is a card/);
	} finally {
		s.cleanup();
	}
});

for (const [label, divisor, skip] of [['a tenth of', 10, false], ['the full', 1, process.env.BOARD_FULL_SIZE ? false : 'set BOARD_FULL_SIZE=1 (two runs of about 40 s)']]) {
	test(`issues, ${label} inventory size: every issue written, a second run writes none, every alias opens its card`, { timeout: 400_000, skip }, async () => {
		const s = sandbox();
		try {
			const e = buildInventorySizedIssues(divisor);
			const first = await runIssues(s, e);
			assert.deepEqual(first.failures, {});
			const perTeam = first.plan.counts.byTeam;
			for (const team of ['PSE', 'INS', 'REV', 'AER']) assert.equal(first.applied[`issues ${team}`].created, perTeam[team].read, team);
			assert.equal(Object.values(first.applied).filter((a) => a.created > 0).length, 4);
			assert.equal(first.checks.aliasesChecked, first.plan.counts.aliases.total);
			assert.equal(first.checks.aliasesBroken, 0);
			assert.equal(first.checks.parentsBroken, 0);
			assert.equal(first.checks.parentsChecked, first.plan.counts.parents);
			if (divisor === 1) assert.deepEqual([first.checks.aliasesChecked, first.plan.counts.read], [600, 1464]);
			const before = snapshot(s.dir);
			const again = await runIssues(s, e);
			assert.deepEqual(again.failures, {});
			assert.equal(Object.values(again.applied).reduce((n, a) => n + a.created + a.changed, 0), 0);
			assert.deepEqual(snapshot(s.dir), before, 'a second run touches no file');
		} finally {
			s.cleanup();
		}
	});
}

test('issues: an error that is not the store\'s own refusal stops the run instead of being counted', async () => {
	const s = sandbox();
	try {
		const plan = planIssues(buildExport(), planReference(buildExport(), { members: MEMBERS }));
		const broken = { dryRun: false, readIssue: async () => null, writeIssue: async () => { throw new TypeError('a bug'); } };
		await assert.rejects(applyIssues(plan, broken, { rawDir: s.rawDir, guard: async () => ({}) }), TypeError);
	} finally {
		s.cleanup();
	}
});
