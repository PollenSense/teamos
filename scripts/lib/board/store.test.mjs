import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { BoardError } from './errors.mjs';
import { serializeDocument } from './frontmatter.mjs';
import { BoardStore } from './store.mjs';

let root;
let n = 0;
before(() => {
	root = mkdtempSync(join(tmpdir(), 'board-store-'));
});
after(() => rmSync(root, { recursive: true, force: true }));

function fresh(options = {}) {
	const base = join(root, `s${n++}`);
	return { base, store: new BoardStore({ dir: join(base, 'board'), lockDir: join(base, 'logs'), ...options }) };
}
const issue = (id, extra = {}) => ({ fields: { id, title: `Title of ${id}`, status: 'Todo', statusType: 'unstarted', ...extra }, body: `Description of ${id}\n` });
const rejects = (promise, code) => assert.rejects(promise, (e) => e instanceof BoardError && e.code === code, code);

test('write, read, write again: the same text, the same hash, and the second write touches nothing', async () => {
	const { store } = fresh();
	const first = await store.writeIssue(issue('PSE-1', { labels: ['Bug'], relations: { blocks: ['PSE-2'] } }), { expect: 'new' });
	assert.equal(first.changed, true);
	const read = await store.readIssue('PSE-1');
	assert.equal(read.hash, first.hash);
	assert.deepEqual(read.fields.labels, ['Bug']);
	assert.equal(read.body, 'Description of PSE-1\n');
	const before = statSync(store.issuePath('PSE-1')).mtimeMs;
	await new Promise((r) => setTimeout(r, 15));
	const second = await store.writeIssue({ fields: read.fields, body: read.body }, { expect: read.hash });
	assert.equal(second.changed, false);
	assert.equal(second.hash, first.hash);
	assert.equal(statSync(store.issuePath('PSE-1')).mtimeMs, before);
});

test('awkward titles survive a write and a read through the store', async () => {
	const { store } = fresh();
	const titles = ['[x] foo', 'a: b', 'say "hi"', '', '  spaced  ', `ls${String.fromCharCode(0x2028)}x`, '🌼', 'a\nb'];
	let i = 1;
	for (const title of titles) {
		const id = `PSE-${i++}`;
		await store.writeIssue(issue(id, { title }), { expect: 'new' });
		assert.equal((await store.readIssue(id)).fields.title, title);
	}
});

test('bad IDs, a team that does not match, and a write without expect are refused', async () => {
	const { store } = fresh();
	for (const id of ['pse-1', 'PSE-0', '../x', 'PSE-1/../../etc', '', undefined]) await rejects(store.writeIssue(issue(id), { expect: 'new' }), 'bad-id');
	await rejects(store.writeIssue(issue('PSE-1', { team: 'INS' }), { expect: 'new' }), 'bad-id');
	await rejects(store.writeIssue(issue('PSE-1'), {}), 'bad-call');
	await rejects(store.writeIssue(issue('PSE-1'), { expect: 'nonsense' }), 'missing');
	assert.equal(existsSync(join(store.dir, 'issues')), false, 'a refused write creates nothing');
});

test('a duplicate ID is refused; a stale hash is refused; a missing file is refused', async () => {
	const { store } = fresh();
	const a = await store.writeIssue(issue('PSE-1'), { expect: 'new' });
	await rejects(store.writeIssue(issue('PSE-1', { title: 'other' }), { expect: 'new' }), 'duplicate-id');
	await store.writeIssue(issue('PSE-1', { title: 'changed by someone else' }), { expect: a.hash });
	await rejects(store.writeIssue(issue('PSE-1', { title: 'mine' }), { expect: a.hash }), 'changed');
	await rejects(store.writeIssue(issue('PSE-9'), { expect: a.hash }), 'missing');
	assert.equal((await store.readIssue('PSE-1')).fields.title, 'changed by someone else');
});

test('an alias opens the same card, in any case', async () => {
	const { store } = fresh();
	await store.writeIssue(issue('PSE-1061', { aliases: ['PSE-812', 'pse-700'] }), { expect: 'new' });
	for (const typed of ['PSE-812', 'pse-812', ' PSE-700 ', 'PSE-1061']) assert.equal((await store.readIssue(typed)).id, 'PSE-1061', typed);
	assert.equal(await store.readIssue('PSE-5'), null);
	assert.equal(await store.readIssue('nonsense'), null);
	assert.deepEqual((await store.readIssue('PSE-812')).fields.aliases, ['PSE-812', 'PSE-700']);
});

test('an alias that is another issue\'s real ID, is claimed twice, is the card\'s own ID, or is not an ID is refused', async () => {
	const { store } = fresh();
	await store.writeIssue(issue('PSE-1'), { expect: 'new' });
	await store.writeIssue(issue('PSE-2', { aliases: ['PSE-50'] }), { expect: 'new' });
	await rejects(store.writeIssue(issue('PSE-3', { aliases: ['PSE-1'] }), { expect: 'new' }), 'alias-conflict');
	await rejects(store.writeIssue(issue('PSE-3', { aliases: ['PSE-50'] }), { expect: 'new' }), 'alias-conflict');
	await rejects(store.writeIssue(issue('PSE-3', { aliases: ['PSE-3'] }), { expect: 'new' }), 'alias-conflict');
	await rejects(store.writeIssue(issue('PSE-3', { aliases: ['not an id'] }), { expect: 'new' }), 'bad-id');
	await rejects(store.writeIssue(issue('PSE-3', { aliases: 'PSE-9' }), { expect: 'new' }), 'bad-id');
	await rejects(store.writeIssue(issue('PSE-50'), { expect: 'new' }), 'alias-conflict'); // a real ID that is already an alias
	assert.equal(existsSync(store.issuePath('PSE-3')), false);
	assert.equal(existsSync(store.issuePath('PSE-50')), false);
	assert.equal((await store.readIssue('PSE-50')).id, 'PSE-2', 'the existing alias still resolves');
	assert.equal((await store.readIssue('PSE-1')).fields.title, 'Title of PSE-1', 'nothing was overwritten');
});

test('unknown fields are kept on rewrite, a known field that is missing is removed, the body stays when not given', async () => {
	const { store, base } = fresh();
	const a = await store.writeIssue(issue('PSE-1', { milestone: 'M1', estimate: 3 }), { expect: 'new' });
	// a newer version of the board (or a person) adds fields the importer does not know
	const path = store.issuePath('PSE-1');
	const text = readFileSync(path, 'utf-8').replace('\n---\n\n', '\nfutureField: {"a":[1,2]}\nnote: "by hand"\n---\n\n');
	writeFileSync(path, text);
	const hash = (await store.readIssue('PSE-1')).hash;
	assert.notEqual(hash, a.hash);
	await store.writeIssue({ fields: { id: 'PSE-1', title: 'Renamed', status: 'Done' } }, { expect: hash });
	const back = await store.readIssue('PSE-1');
	assert.equal(back.fields.title, 'Renamed');
	assert.equal('milestone' in back.fields, false);
	assert.equal('estimate' in back.fields, false);
	assert.deepEqual(back.fields.futureField, { a: [1, 2] });
	assert.equal(back.fields.note, 'by hand');
	assert.equal(back.body, 'Description of PSE-1\n');
	assert.ok(base);
});

test('a write that fails before the rename leaves the old file and no temp file', async () => {
	let fail = false;
	const { store } = fresh({
		hooks: {
			beforeRename: () => {
				if (fail) throw new Error('disk went away');
			},
		},
	});
	const a = await store.writeIssue(issue('PSE-1'), { expect: 'new' });
	const dir = join(store.dir, 'issues', 'PSE');
	fail = true;
	await assert.rejects(store.writeIssue(issue('PSE-1', { title: 'new title' }), { expect: a.hash }), /disk went away/);
	await assert.rejects(store.writeIssue(issue('PSE-2'), { expect: 'new' }), /disk went away/);
	assert.deepEqual(readdirSync(dir), ['PSE-1.md']);
	assert.equal((await store.readIssue('PSE-1')).fields.title, 'Title of PSE-1');
	fail = false;
	await store.writeIssue(issue('PSE-2'), { expect: 'new' }); // the lock was released
});

test('a file that is damaged is reported, never overwritten', async () => {
	const { store } = fresh();
	mkdirSync(join(store.dir, 'issues', 'PSE'), { recursive: true });
	writeFileSync(store.issuePath('PSE-1'), '<<<<<<< conflict\nnot front matter\n');
	await rejects(store.readIssue('PSE-1'), 'damaged');
	await rejects(store.writeIssue(issue('PSE-1'), { expect: 'new' }), 'damaged');
	assert.match(readFileSync(store.issuePath('PSE-1'), 'utf-8'), /conflict/);
});

test('two writers that read the same hash: exactly one wins, the other gets `changed`', async () => {
	const { store } = fresh();
	const a = await store.writeIssue(issue('PSE-1'), { expect: 'new' });
	const results = await Promise.allSettled([
		store.writeIssue(issue('PSE-1', { title: 'writer one' }), { expect: a.hash }),
		store.writeIssue(issue('PSE-1', { title: 'writer two' }), { expect: a.hash }),
	]);
	assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
	assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'changed');
});

test('a lock whose process is gone is taken over; a live fresh lock makes a writer give up with `locked`', async () => {
	const { store, base } = fresh({ lockOptions: { waitMs: 150, pollMs: 10 } });
	const lockFile = join(base, 'logs', 'issues.lock');
	mkdirSync(join(base, 'logs'), { recursive: true });
	const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
	writeFileSync(lockFile, JSON.stringify({ pid: Number(dead.stdout.toString()), host: hostname(), at: Date.now() }));
	await store.writeIssue(issue('PSE-1'), { expect: 'new' });
	assert.equal(existsSync(lockFile), false, 'released after the write');

	writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() }));
	await rejects(store.writeIssue(issue('PSE-2'), { expect: 'new' }), 'locked');
	assert.equal(existsSync(store.issuePath('PSE-2')), false);

	writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: 'another-machine', at: Date.now() - 120_000 }));
	await store.writeIssue(issue('PSE-2'), { expect: 'new' }); // older than the stale timeout, whatever the pid
	assert.equal(existsSync(store.issuePath('PSE-2')), true);
});

test('projects: front matter and description, unknown fields kept, a code that is not a code refused', async () => {
	const { store } = fresh();
	const p = await store.writeProject({ fields: { code: 'airevoSite', name: 'Airevo site', teams: ['PSE', 'INS'], milestones: [{ name: 'M1', targetDate: '2026-12-01' }] }, body: 'About the project.\n' }, { expect: 'new' });
	const read = await store.readProject('airevoSite');
	assert.deepEqual(read.fields.teams, ['PSE', 'INS']);
	assert.equal(read.body, 'About the project.\n');
	assert.equal(read.hash, p.hash);
	await rejects(store.writeProject({ fields: { code: '../x' } }, { expect: 'new' }), 'bad-id');
	await rejects(store.writeProject({ fields: { code: 'airevoSite' } }, { expect: 'new' }), 'duplicate-id');
	assert.deepEqual(await store.listProjects(), ['airevoSite']);
	assert.equal(await store.readProject('nothing'), null);
});

test('teams, cycles and people: JSON files, unknown keys kept, never half-written, damaged ones refused', async () => {
	const { store } = fresh();
	const t = await store.writeTeam({ key: 'PSE', name: 'Platform', states: [{ name: 'Todo', type: 'unstarted' }], nextNumber: 100 }, { expect: 'new' });
	const path = store.teamPath('PSE');
	writeFileSync(path, readFileSync(path, 'utf-8').replace('{', '{\n\t"extra": true,'));
	const read = await store.readTeam('PSE');
	await store.writeTeam({ key: 'PSE', name: 'Platform 2', nextNumber: 100 }, { expect: read.hash });
	const back = await store.readTeam('PSE');
	assert.equal(back.data.name, 'Platform 2');
	assert.equal(back.data.extra, true);
	assert.equal('states' in back.data, false);
	assert.notEqual(t.hash, back.hash);
	await rejects(store.writeTeam({ key: 'pse' }, { expect: 'new' }), 'bad-id');

	await store.writeCycle({ team: 'PSE', number: 37, startsAt: '2026-11-02', endsAt: '2026-11-09', completed: false }, { expect: 'new' });
	await store.writeCycle({ team: 'PSE', number: 5, startsAt: '2026-09-01' }, { expect: 'new' });
	assert.deepEqual(await store.listCycles('PSE'), [5, 37]);
	assert.equal((await store.readCycle('PSE', 37)).data.completed, false);
	await rejects(store.writeCycle({ team: 'PSE', number: 0 }, { expect: 'new' }), 'bad-id');

	assert.equal(await store.readPeople(), null);
	const people = { 'linear:a': { member: 'van' }, 'linear:b': { former: true } };
	await store.writePeople(people, { expect: 'new' });
	assert.deepEqual((await store.readPeople()).data, people);
	writeFileSync(store.peoplePath(), '{"half": ');
	await rejects(store.readPeople(), 'damaged');
	writeFileSync(store.peoplePath(), '[1,2]');
	await rejects(store.readPeople(), 'damaged');
});

test('the ID allocator: increments under the lock, skips numbers that exist, never hands one out twice, never lowers', async () => {
	const { store } = fresh();
	await store.writeTeam({ key: 'OPS', name: 'Operations', nextNumber: 1 }, { expect: 'new' });
	assert.deepEqual(await store.nextNumber('OPS'), { id: 'OPS-1', number: 1 });
	await store.writeIssue(issue('OPS-2'), { expect: 'new' });
	await store.writeIssue(issue('OPS-4', { aliases: ['OPS-3'] }), { expect: 'new' });
	assert.equal((await store.nextNumber('OPS')).id, 'OPS-5', 'OPS-2 has a file, OPS-3 is an alias, OPS-4 has a file');
	const many = await Promise.all(Array.from({ length: 20 }, () => store.nextNumber('OPS')));
	assert.equal(new Set(many.map((m) => m.id)).size, 20);
	assert.equal(Math.min(...many.map((m) => m.number)), 6);
	assert.equal((await store.readTeam('OPS')).data.nextNumber, 26);
	assert.equal(await store.raiseNextNumber('OPS', 10), 26, 'never lowers');
	assert.equal(await store.raiseNextNumber('OPS', 1062), 1062);
	assert.equal((await store.nextNumber('OPS')).id, 'OPS-1062');
	await rejects(store.nextNumber('PSE'), 'missing');
	await rejects(store.raiseNextNumber('OPS', 0), 'bad-value');
	writeFileSync(store.teamPath('OPS'), '{"key":"OPS","nextNumber":"x"}');
	await rejects(store.nextNumber('OPS'), 'damaged');
});

test('files that are in the folder but are not issues (threads, temp files, strays) do not show up in the index', async () => {
	const { store } = fresh();
	await store.writeIssue(issue('PSE-1'), { expect: 'new' });
	const dir = join(store.dir, 'issues', 'PSE');
	writeFileSync(join(dir, 'PSE-1.thread.md'), serializeDocument({ id: 'PSE-1' }, 'thread'));
	writeFileSync(join(dir, '.123-abc.tmp'), 'partial');
	writeFileSync(join(dir, 'notes.md'), 'x');
	mkdirSync(join(store.dir, 'issues', 'lowercase'), { recursive: true });
	writeFileSync(join(store.dir, 'issues', 'lowercase', 'PSE-9.md'), serializeDocument({ id: 'PSE-9' }, ''));
	await store.index.refresh();
	assert.deepEqual(store.index.entries().map((e) => e.id), ['PSE-1']);
	assert.deepEqual(store.index.problems, []);
});
