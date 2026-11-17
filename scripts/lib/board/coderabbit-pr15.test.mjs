import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { BoardError } from './errors.mjs';
import { serializeDocument } from './frontmatter.mjs';
import { withLock } from './lock.mjs';
import { BoardStore } from './store.mjs';

// Regression tests for the CodeRabbit findings on PR #15 (2026-11-17). The tests run as root, where chmod makes
// nothing unreadable, so a read error is made either with a path that is a folder (EISDIR) or by replacing one
// `node:fs/promises` function for a moment (`syncBuiltinESMExports` carries the replacement into the modules'
// named imports). Tests in one file run one after the other, so the replacement never overlaps another test.

let root;
let n = 0;
before(() => {
	root = mkdtempSync(join(tmpdir(), 'board-cr15-'));
});
after(() => {
	rmSync(root, { recursive: true, force: true });
});

function fresh(options = {}) {
	const base = join(root, `r${n++}`);
	return { base, store: new BoardStore({ dir: join(base, 'board'), lockDir: join(base, 'logs'), ...options }) };
}
const issue = (id, extra = {}) => ({ fields: { id, title: `Title of ${id}`, ...extra }, body: '' });
const rejects = (promise, code) => assert.rejects(promise, (e) => e instanceof BoardError && e.code === code, code);
const fsError = (code) => Object.assign(new Error(`stub ${code}`), { code });

/** Replace `fsp[name]` while `fn` runs: `decide(args)` returns an error to throw, or null to call the real one. */
async function withBroken(name, decide, fn) {
	const real = fsp[name];
	fsp[name] = async (...args) => {
		const err = decide(args);
		if (err) throw err;
		return real(...args);
	};
	syncBuiltinESMExports();
	try {
		return await fn();
	} finally {
		fsp[name] = real;
		syncBuiltinESMExports();
	}
}
const lockFile = (p) => String(p).endsWith('.lock');

// --- lock.mjs (finding 3) ---

test('a lock path that cannot be read (here a folder) ends in `unreadable` at once, it does not spin', { timeout: 5000 }, async () => {
	const { store, base } = fresh({ lockOptions: { waitMs: 200, pollMs: 10 } });
	mkdirSync(join(base, 'logs', 'issues.lock'), { recursive: true });
	await rejects(store.writeIssue(issue('PSE-1'), { expect: 'new' }), 'unreadable');
	assert.equal(existsSync(store.issuePath('PSE-1')), false);
});

test('a lock file that cannot be inspected is `unreadable`; a lock file that is gone is still retried', { timeout: 5000 }, async () => {
	const { store, base } = fresh({ lockOptions: { waitMs: 200, pollMs: 10 } });
	mkdirSync(join(base, 'logs'), { recursive: true });
	writeFileSync(join(base, 'logs', 'issues.lock'), ''); // no usable content: judged by the file's age, which needs a stat
	await withBroken('stat', ([p]) => (lockFile(p) ? fsError('EIO') : null), async () => {
		await rejects(store.writeIssue(issue('PSE-1'), { expect: 'new' }), 'unreadable');
	});
	await withBroken('stat', ([p]) => (lockFile(p) ? fsError('ENOENT') : null), async () => {
		await rejects(store.writeIssue(issue('PSE-1'), { expect: 'new' }), 'locked'); // gone when we looked: try again, then give up at the deadline
	});
});

test('a holder file that keeps answering "gone" while the lock exists ends in `locked` at the deadline', { timeout: 5000 }, async () => {
	const { store, base } = fresh({ lockOptions: { waitMs: 150, pollMs: 10 } });
	mkdirSync(join(base, 'logs'), { recursive: true });
	writeFileSync(join(base, 'logs', 'issues.lock'), JSON.stringify({ pid: process.pid, host: 'elsewhere', at: Date.now() }));
	await withBroken('readFile', ([p]) => (lockFile(p) ? fsError('ENOENT') : null), async () => {
		await rejects(store.writeIssue(issue('PSE-1'), { expect: 'new' }), 'locked');
	});
});

test('the release leaves a lock it cannot read, and does not replace what the work returned', async () => {
	const { base } = fresh();
	const dir = join(base, 'logs');
	let broken = false;
	await withBroken('readFile', ([p]) => (broken && lockFile(p) ? fsError('EIO') : null), async () => {
		const value = await withLock(dir, 'x', async () => {
			broken = true;
			return 42;
		});
		assert.equal(value, 42);
	});
	assert.equal(existsSync(join(dir, 'x.lock')), true, 'a lock we could not read is not removed');
	// A readable lock of ours is still released.
	await withLock(dir, 'y', async () => {});
	assert.equal(existsSync(join(dir, 'y.lock')), false);
});

// --- issue-index.mjs (finding 1) ---

test('an issue file that cannot be inspected or read fails the refresh with `unreadable` and is not dropped from the index', async () => {
	const { store } = fresh();
	await store.writeIssue(issue('PSE-1', { aliases: ['PSE-900'] }), { expect: 'new' });
	await store.writeIssue(issue('PSE-2'), { expect: 'new' });
	await store.index.refresh();
	assert.equal(store.index.resolve('PSE-900'), 'PSE-1');

	await withBroken('stat', ([p]) => (String(p).endsWith('PSE-1.md') ? fsError('EACCES') : null), async () => {
		await rejects(store.index.refresh(), 'unreadable');
	});
	assert.equal(store.index.resolve('PSE-900'), 'PSE-1', 'the failed refresh left the index as it was');
	assert.deepEqual(store.index.entries().map((e) => e.id), ['PSE-1', 'PSE-2']);

	// Change PSE-1 so a re-read is needed, then make the read fail.
	writeFileSync(store.issuePath('PSE-1'), serializeDocument({ id: 'PSE-1', title: 'Changed by hand', aliases: ['PSE-900'] }, ''));
	await withBroken('open', ([p, flag]) => (String(p).endsWith('PSE-1.md') && flag === 'r' ? fsError('EIO') : null), async () => {
		await rejects(store.index.refresh(), 'unreadable');
	});
	assert.equal(store.index.resolve('PSE-900'), 'PSE-1');

	// Once the file reads again, the refresh works and sees the change.
	const { reread } = await store.index.refresh();
	assert.equal(reread, 1);
	assert.equal(store.index.get('PSE-1').fields.title, 'Changed by hand');
});

test('a file that is really gone (ENOENT) is still dropped by the refresh', async () => {
	const { store } = fresh();
	await store.writeIssue(issue('PSE-1'), { expect: 'new' });
	await store.writeIssue(issue('PSE-2'), { expect: 'new' });
	await store.index.refresh();
	await withBroken('stat', ([p]) => (String(p).endsWith('PSE-2.md') ? fsError('ENOENT') : null), async () => {
		await store.index.refresh();
	});
	assert.deepEqual(store.index.entries().map((e) => e.id), ['PSE-1']);
});

// --- store.mjs + issue-index.mjs (finding 2) ---

test('the index keeps the temp file\'s mtime and size: a file a sync replaced right after our rename is re-read next time', async () => {
	const replacement = serializeDocument({ id: 'PSE-1', title: 'Replaced by a sync, and a longer title than ours' }, 'other text\n');
	const { store } = fresh({
		hooks: {
			afterRename: (path) => {
				writeFileSync(path, replacement); // another machine's version lands before the store notes its write
			},
		},
	});
	await store.writeIssue(issue('PSE-1', { title: 'Ours' }), { expect: 'new' });
	assert.equal(readFileSync(store.issuePath('PSE-1'), 'utf-8'), replacement);
	const { reread } = await store.index.refresh();
	assert.equal(reread, 1, 'the cached stat is the temp file\'s, so the replacement does not match it');
	assert.equal(store.index.get('PSE-1').fields.title, 'Replaced by a sync, and a longer title than ours');
});

test('our own write is not read back, a write of identical text changes nothing, and no internal field leaks into the result', async () => {
	const { store } = fresh();
	const a = await store.writeIssue(issue('PSE-1'), { expect: 'new' });
	assert.equal((await store.index.refresh()).reread, 0, 'our own write is not read back');
	const again = await store.writeIssue(issue('PSE-1'), { expect: a.hash });
	assert.equal(again.changed, false);
	assert.equal('written' in again, false);
	assert.equal((await store.index.refresh()).reread, 0);
});

// --- issue-index.mjs (finding 4) ---

test('a note of our own write that lands in the middle of a refresh is not lost', async () => {
	const { store } = fresh();
	await store.writeIssue(issue('PSE-1'), { expect: 'new' });
	await store.index.refresh();
	const index = store.index;

	// Hold the refresh after it has taken its file list, write PSE-2 meanwhile, then let the refresh finish.
	const realList = index._listFiles.bind(index);
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	let listed;
	const listedPromise = new Promise((resolve) => {
		listed = resolve;
	});
	index._listFiles = async () => {
		const files = await realList();
		listed();
		await gate;
		return files;
	};
	const refreshing = index.refresh();
	await listedPromise;
	index._listFiles = realList; // only that one refresh is held
	const writing = store.writeIssue(issue('PSE-2', { aliases: ['PSE-901'] }), { expect: 'new' });
	await new Promise((resolve) => setTimeout(resolve, 50)); // the write is waiting behind the held refresh, or is past it
	release();
	await Promise.all([refreshing, writing]);

	assert.deepEqual(index.entries().map((e) => e.id), ['PSE-1', 'PSE-2'], 'PSE-2 is in the index without another refresh');
	assert.equal(index.resolve('PSE-901'), 'PSE-2');
});

test('readIssue by alias (a refresh without the write lock) running with many writes loses none of them', async () => {
	const { store } = fresh();
	await store.writeIssue(issue('PSE-1', { aliases: ['PSE-900'] }), { expect: 'new' });
	const jobs = [];
	for (let i = 2; i <= 14; i++) {
		jobs.push(store.writeIssue(issue(`PSE-${i}`, { aliases: [`PSE-${900 + i}`] }), { expect: 'new' }));
		jobs.push(store.readIssue('PSE-900'));
	}
	const reads = (await Promise.all(jobs)).filter((r) => r && r.fields);
	assert.ok(reads.every((r) => r.id === 'PSE-1'));
	assert.equal(store.index.entries().length, 14);
	for (let i = 2; i <= 14; i++) assert.equal(store.index.resolve(`PSE-${900 + i}`), `PSE-${i}`);
});
