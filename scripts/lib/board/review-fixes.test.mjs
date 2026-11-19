import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { boardConfig } from './config.mjs';
import { BoardError } from './errors.mjs';
import { mergeFields, serializeDocument } from './frontmatter.mjs';
import { IssueIndex } from './issue-index.mjs';
import { BoardStore } from './store.mjs';

// Regression tests for the findings of the independent review of the first version (2026-11-13).

let root;
let n = 0;
before(() => {
	root = mkdtempSync(join(tmpdir(), 'board-review-'));
});
after(() => {
	rmSync(root, { recursive: true, force: true });
});
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function fresh(options = {}) {
	const base = join(root, `r${n++}`);
	return { base, store: new BoardStore({ dir: join(base, 'board'), lockDir: join(base, 'logs'), ...options }) };
}
const issue = (id, extra = {}) => ({ fields: { id, title: `Title of ${id}`, ...extra }, body: '' });
const rejects = (promise, code) => assert.rejects(promise, (e) => e instanceof BoardError && e.code === code, code);

test('a lock file with no readable content is judged by its age: a fresh one holds, an old one is taken over', async () => {
	const { store, base } = fresh({ lockOptions: { waitMs: 120, pollMs: 10, staleMs: 60_000 } });
	mkdirSync(join(base, 'logs'), { recursive: true });
	const lock = join(base, 'logs', 'issues.lock');
	writeFileSync(lock, '');
	await rejects(store.writeIssue(issue('PSE-1'), { expect: 'new' }), 'locked');
	const old = new Date(Date.now() - 3_600_000);
	utimesSync(lock, old, old);
	await store.writeIssue(issue('PSE-1'), { expect: 'new' });
	assert.equal(existsSync(lock), false);
	writeFileSync(lock, '{"pid": ');
	utimesSync(lock, old, old);
	await store.writeIssue(issue('PSE-2'), { expect: 'new' }); // half-written JSON, old: also taken over
});

test('a stale lock that cannot be removed ends in `locked` at the deadline, it does not spin', { skip: isRoot && 'root can remove it' }, async () => {
	const { store, base } = fresh({ lockOptions: { waitMs: 250, pollMs: 10, staleMs: 60_000 } });
	const logs = join(base, 'logs');
	mkdirSync(logs, { recursive: true });
	writeFileSync(join(logs, 'issues.lock'), JSON.stringify({ pid: 999999, host: 'elsewhere', at: Date.now() - 3_600_000 }));
	chmodSync(logs, 0o555);
	try {
		const started = Date.now();
		await rejects(store.writeIssue(issue('PSE-1'), { expect: 'new' }), 'locked');
		assert.ok(Date.now() - started < 3000, 'gave up at the deadline');
	} finally {
		chmodSync(logs, 0o755);
	}
});

test('people.json: only a JSON object can be written; undefined, null, arrays and strings are refused and nothing is created', async () => {
	const { store } = fresh();
	for (const bad of [undefined, null, [], [1], 'text', 5]) await rejects(store.writePeople(bad, { expect: 'new' }), 'bad-value');
	assert.equal(existsSync(store.peoplePath()), false);
	await store.writePeople({ a: 1 }, { expect: 'new' });
	assert.deepEqual((await store.readPeople()).data, { a: 1 });
});

test('an alias that is the name of an issue file the index cannot read (damaged, or an id mismatch) is refused too', async () => {
	const { store } = fresh();
	mkdirSync(join(store.dir, 'issues', 'PSE'), { recursive: true });
	writeFileSync(store.issuePath('PSE-5'), 'garbage, no front matter');
	writeFileSync(store.issuePath('PSE-6'), serializeDocument({ id: 'PSE-60' }, ''));
	await rejects(store.writeIssue(issue('PSE-7', { aliases: ['PSE-5'] }), { expect: 'new' }), 'alias-conflict');
	await rejects(store.writeIssue(issue('PSE-7', { aliases: ['PSE-6'] }), { expect: 'new' }), 'alias-conflict');
	assert.equal(existsSync(store.issuePath('PSE-7')), false);
});

test('an unreadable team folder makes a refresh fail, it is not read as an empty folder', { skip: isRoot && 'root can read it' }, async () => {
	const { store } = fresh();
	await store.writeIssue(issue('PSE-1'), { expect: 'new' });
	const dir = join(store.dir, 'issues', 'PSE');
	chmodSync(dir, 0o000);
	try {
		await assert.rejects(store.index.refresh(), (e) => e.code === 'EACCES');
		await assert.rejects(store.writeIssue(issue('PSE-2', { aliases: ['PSE-1'] }), { expect: 'new' }), (e) => e.code === 'EACCES');
	} finally {
		chmodSync(dir, 0o755);
	}
	await store.index.refresh();
	assert.deepEqual(store.index.entries().map((e) => e.id), ['PSE-1']);
});

test('the index keeps what the file says, not the caller\'s objects: changing them afterwards changes nothing', async () => {
	const { store, base } = fresh();
	const labels = ['Bug'];
	const prs = [{ url: 'u', note: undefined }];
	await store.writeIssue({ fields: { id: 'PSE-1', title: 't', labels, prs }, body: '' }, { expect: 'new' });
	labels.push('Portal');
	prs[0].extra = true;
	assert.deepEqual(store.index.get('PSE-1').fields.labels, ['Bug']);
	assert.deepEqual(store.index.get('PSE-1').fields.prs, [{ url: 'u' }], 'nested undefined is not in the file, so not in the index');
	await store.index.flush();
	const warm = new BoardStore({ dir: join(base, 'board'), lockDir: join(base, 'logs') });
	await warm.index.refresh();
	assert.deepEqual(warm.index.get('PSE-1').fields.labels, ['Bug']);
});

test('mergeFields keeps unknown fields that share a name with an object method (constructor, toString, valueOf)', () => {
	const existing = { id: 'PSE-1', constructor: 'a', toString: 'b', valueOf: 'c', future: 1 };
	const merged = mergeFields(existing, { id: 'PSE-1', title: 't' }, ['id', 'title']);
	assert.deepEqual(Object.keys(merged), ['id', 'title', 'constructor', 'toString', 'valueOf', 'future']);
	assert.equal(merged.constructor, 'a');
	const replaced = mergeFields(existing, { id: 'PSE-1', constructor: 'new' }, ['id']);
	assert.equal(replaced.constructor, 'new');
});

test('board.enabled: anything but true switches the module off', () => {
	for (const enabled of [false, null, 0, 1, 'false', 'no', 'off', 'true', [], {}]) {
		const cfg = boardConfig({ board: { enabled } }, '/repo');
		assert.equal(cfg.on, false, JSON.stringify(enabled));
		assert.ok(cfg.reason.includes('enabled'));
	}
	assert.equal(boardConfig({ board: { enabled: true } }, '/repo').on, true);
	assert.equal(boardConfig({ board: {} }, '/repo').on, true);
});

test('a team rewrite keeps nextNumber and only ever raises it: no ID is handed out twice', async () => {
	const { store } = fresh();
	await store.writeTeam({ key: 'PSE', name: 'P', nextNumber: 1 }, { expect: 'new' });
	assert.equal((await store.nextNumber('PSE')).id, 'PSE-1');
	assert.equal((await store.nextNumber('PSE')).id, 'PSE-2');
	let team = await store.readTeam('PSE');
	await store.writeTeam({ key: 'PSE', name: 'P renamed' }, { expect: team.hash }); // no nextNumber given
	team = await store.readTeam('PSE');
	assert.equal(team.data.nextNumber, 3);
	await store.writeTeam({ key: 'PSE', name: 'P renamed', nextNumber: 1 }, { expect: team.hash }); // lower
	team = await store.readTeam('PSE');
	assert.equal(team.data.nextNumber, 3);
	await store.writeTeam({ key: 'PSE', name: 'P renamed', nextNumber: 50 }, { expect: team.hash }); // higher
	assert.equal((await store.nextNumber('PSE')).id, 'PSE-50');
	await rejects(store.writeTeam({ key: 'PSE', nextNumber: 0 }, { expect: (await store.readTeam('PSE')).hash }), 'bad-value');
	await store.writeTeam({ key: 'OPS', name: 'no number yet' }, { expect: 'new' });
	assert.equal('nextNumber' in (await store.readTeam('OPS')).data, false);
});

test('a failed cache save leaves no temp file behind', async () => {
	const base = join(root, `r${n++}`);
	const issues = join(base, 'issues');
	mkdirSync(join(issues, 'PSE'), { recursive: true });
	writeFileSync(join(issues, 'PSE', 'PSE-1.md'), serializeDocument({ id: 'PSE-1' }, ''));
	const cachePath = join(base, 'logs', 'index.json');
	mkdirSync(cachePath, { recursive: true }); // a directory where the cache file should be: the rename cannot succeed
	writeFileSync(join(cachePath, 'keep'), 'x');
	const index = new IssueIndex(issues, { cachePath });
	assert.equal((await index.refresh()).count, 1, 'the read still works');
	assert.deepEqual(readdirSync(join(base, 'logs')), ['index.json']);
});

test('a shared alias goes to the lower issue number, not the lower string (PSE-9 before PSE-10)', async () => {
	const base = join(root, `r${n++}`);
	const issues = join(base, 'issues');
	mkdirSync(join(issues, 'PSE'), { recursive: true });
	for (const id of ['PSE-10', 'PSE-9']) writeFileSync(join(issues, 'PSE', `${id}.md`), serializeDocument({ id, aliases: ['INS-1'] }, ''));
	const index = new IssueIndex(issues, {});
	await index.refresh();
	assert.equal(index.resolve('INS-1'), 'PSE-9');
	assert.deepEqual(index.problems.map((p) => `${p.code}:${p.rel}`), ['alias-taken:PSE/PSE-10.md']);
	assert.ok(hostname());
	assert.ok(readFileSync(join(issues, 'PSE', 'PSE-9.md'), 'utf-8').length > 0);
});
