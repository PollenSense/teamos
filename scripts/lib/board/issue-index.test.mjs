import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { serializeDocument } from './frontmatter.mjs';
import { IssueIndex } from './issue-index.mjs';
import { BoardStore } from './store.mjs';

let root;
let n = 0;
before(() => {
	root = mkdtempSync(join(tmpdir(), 'board-index-'));
});
after(() => rmSync(root, { recursive: true, force: true }));

function dirs() {
	const base = join(root, `i${n++}`);
	mkdirSync(join(base, 'issues'), { recursive: true });
	return { issues: join(base, 'issues'), cachePath: join(base, 'logs', 'index.json') };
}
function put(issues, id, fields = {}, body = '') {
	const team = id.split('-')[0];
	mkdirSync(join(issues, team), { recursive: true });
	const path = join(issues, team, `${id}.md`);
	writeFileSync(path, serializeDocument({ id, title: `Title ${id}`, ...fields }, body));
	return path;
}

test('a first refresh reads every file, a second reads none, a changed one is read again', async () => {
	const { issues, cachePath } = dirs();
	for (let i = 1; i <= 120; i++) put(issues, `PSE-${i}`, { status: 'Todo' });
	for (let i = 1; i <= 30; i++) put(issues, `INS-${i}`);
	const index = new IssueIndex(issues, { cachePath });
	assert.deepEqual(await index.refresh(), { count: 150, reread: 150 });
	assert.deepEqual(await index.refresh(), { count: 150, reread: 0 });
	put(issues, 'PSE-7', { status: 'Done', extra: 'longer so the size differs' });
	const again = await index.refresh();
	assert.equal(again.reread, 1);
	assert.equal(index.get('PSE-7').fields.status, 'Done');
	assert.equal(index.entries()[0].id, 'INS-1');
	assert.equal(index.entries().at(-1).id, 'PSE-120');
});

test('a changed file whose mtime went BACKWARDS but whose size differs is read again (Drive can restore an older mtime)', async () => {
	const { issues, cachePath } = dirs();
	const path = put(issues, 'PSE-1', { status: 'Todo' });
	const index = new IssueIndex(issues, { cachePath });
	await index.refresh();
	const old = statSync(path).mtime;
	put(issues, 'PSE-1', { status: 'In Review and a longer value' });
	const past = new Date(old.getTime() - 3_600_000);
	utimesSync(path, past, past);
	assert.ok(statSync(path).mtimeMs < old.getTime());
	assert.equal((await index.refresh()).reread, 1);
	assert.equal(index.get('PSE-1').fields.status, 'In Review and a longer value');
});

test('a new process starts from the cache file: no file is parsed again, and a deleted file drops out', async () => {
	const { issues, cachePath } = dirs();
	for (let i = 1; i <= 40; i++) put(issues, `PSE-${i}`, { aliases: i === 40 ? ['PSE-4000'] : [] });
	await new IssueIndex(issues, { cachePath }).refresh();
	assert.ok(existsSync(cachePath));
	const warm = new IssueIndex(issues, { cachePath });
	assert.deepEqual(await warm.refresh(), { count: 40, reread: 0 });
	assert.equal(warm.resolve('pse-4000'), 'PSE-40');
	unlinkSync(join(issues, 'PSE', 'PSE-3.md'));
	assert.deepEqual(await warm.refresh(), { count: 39, reread: 0 });
	assert.equal(warm.get('PSE-3'), null);
	writeFileSync(cachePath, '{"version":1,"files":'); // a cache file that is cut off is ignored
	assert.deepEqual(await new IssueIndex(issues, { cachePath }).refresh(), { count: 39, reread: 39 });
});

test('problems are listed, not thrown: damaged, misplaced, id-mismatch, shadowed and shared aliases', async () => {
	const { issues, cachePath } = dirs();
	put(issues, 'PSE-1');
	writeFileSync(join(issues, 'PSE', 'PSE-2.md'), 'no front matter at all');
	put(issues, 'PSE-3', { id: 'PSE-33' });
	mkdirSync(join(issues, 'INS'), { recursive: true });
	writeFileSync(join(issues, 'INS', 'PSE-5.md'), serializeDocument({ id: 'PSE-5' }, ''));
	put(issues, 'PSE-6', { aliases: ['PSE-1', 'PSE-77'] });
	put(issues, 'PSE-8', { aliases: ['PSE-77'] });
	const index = new IssueIndex(issues, { cachePath });
	await index.refresh();
	const codes = index.problems.map((p) => `${p.code}:${p.rel}${p.alias ? `:${p.alias}` : ''}`).sort();
	assert.deepEqual(codes, ['alias-shadowed:PSE/PSE-6.md:PSE-1', 'alias-taken:PSE/PSE-8.md:PSE-77', 'damaged:PSE/PSE-2.md', 'id-mismatch:PSE/PSE-3.md', 'misplaced:INS/PSE-5.md']);
	assert.deepEqual(index.entries().map((e) => e.id), ['PSE-1', 'PSE-6', 'PSE-8']);
	assert.equal(index.resolve('PSE-77'), 'PSE-6', 'the lower ID keeps a shared alias');
	assert.equal(index.resolve('PSE-1'), 'PSE-1', 'a real ID is never taken over by an alias');
});

test('front matter longer than the head the index reads first is still read whole', async () => {
	const { issues, cachePath } = dirs();
	put(issues, 'PSE-1', { labels: Array.from({ length: 3000 }, (_, i) => `label-number-${i}`), status: 'Done' }, 'body');
	const index = new IssueIndex(issues, { cachePath });
	await index.refresh();
	assert.equal(index.get('PSE-1').fields.labels.length, 3000);
	assert.equal(index.get('PSE-1').fields.status, 'Done');
});

test('writes through the store keep the index warm without re-reading, and flush saves the cache once', async () => {
	const base = join(root, `store${n++}`);
	const store = new BoardStore({ dir: join(base, 'board'), lockDir: join(base, 'logs') });
	for (let i = 1; i <= 25; i++) await store.writeIssue({ fields: { id: `PSE-${i}`, title: `T${i}`, aliases: i === 25 ? ['PSE-2500'] : undefined }, body: '' }, { expect: 'new' });
	assert.equal((await store.index.refresh()).reread, 0, 'the store noted each write itself');
	assert.equal(store.index.resolve('PSE-2500'), 'PSE-25');
	await store.index.flush();
	const saved = JSON.parse(readFileSync(join(base, 'logs', 'index.json'), 'utf-8'));
	assert.equal(Object.keys(saved.files).length, 25);
	const warm = new BoardStore({ dir: join(base, 'board'), lockDir: join(base, 'logs') });
	assert.equal((await warm.index.refresh()).reread, 0);
});

test('1,500 issues: a warm refresh and an ID lookup are fast (rough guard, not a benchmark)', async () => {
	const { issues, cachePath } = dirs();
	for (let i = 1; i <= 1500; i++) put(issues, `PSE-${i}`, { status: 'Todo', labels: ['a', 'b'], assignee: 'van' }, 'x'.repeat(2000));
	const cold = new IssueIndex(issues, { cachePath });
	const t0 = performance.now();
	await cold.refresh();
	const coldMs = performance.now() - t0;
	const warm = new IssueIndex(issues, { cachePath });
	const t1 = performance.now();
	const result = await warm.refresh();
	const warmMs = performance.now() - t1;
	assert.deepEqual(result, { count: 1500, reread: 0 });
	console.log(`# 1500 issues: cold ${coldMs.toFixed(0)} ms, warm ${warmMs.toFixed(0)} ms`);
	assert.ok(warmMs < 3000, `warm refresh took ${warmMs} ms`);
});
