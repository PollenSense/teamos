import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { BoardError } from './errors.mjs';
import { serializeDocument } from './frontmatter.mjs';
import { withLock } from './lock.mjs';
import { BoardStore } from './store.mjs';

// Regression tests for the second CodeRabbit review of PR #15 (2026-11-18, round 4). Same technique as
// coderabbit-pr15.test.mjs: tests run as root, so a read error is made by replacing one `node:fs/promises`
// function for a moment (`syncBuiltinESMExports` carries it into the modules' named imports). Tests in one file
// run one after the other, so a replacement never overlaps another test.

let root;
let n = 0;
before(() => {
	root = mkdtempSync(join(tmpdir(), 'board-cr15r4-'));
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
const lockFile = (p) => String(p).endsWith('.lock');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Replace `fsp[name]` while `fn` runs: `wrap(real)` returns the replacement. */
async function withReplaced(name, wrap, fn) {
	const real = fsp[name];
	fsp[name] = wrap(real);
	syncBuiltinESMExports();
	try {
		return await fn();
	} finally {
		fsp[name] = real;
		syncBuiltinESMExports();
	}
}
const withBroken = (name, decide, fn) =>
	withReplaced(
		name,
		(real) =>
			async (...args) => {
				const err = decide(args);
				if (err) throw err;
				return real(...args);
			},
		fn,
	);

// --- lock.mjs: the release (A3a) ---

test('the release does not remove a lock that was already gone when it looked: another writer may have made one since', async () => {
	const { base } = fresh();
	const dir = join(base, 'logs');
	const theirs = JSON.stringify({ pid: process.pid, host: 'elsewhere', at: Date.now() });
	let looking = false;
	// While the release looks, the lock file "is gone" (ENOENT); by the time it would unlink, another writer's lock stands there.
	await withBroken('readFile', ([p]) => (looking && lockFile(p) ? fsError('ENOENT') : null), async () => {
		await withLock(dir, 'x', async () => {
			writeFileSync(join(dir, 'x.lock'), theirs); // replaces ours with another writer's
			looking = true;
		});
	});
	assert.equal(existsSync(join(dir, 'x.lock')), true, 'a lock we could not recognise as ours is left alone');
});

// --- lock.mjs: the deadline on the stale-lock paths (A3b) ---

/**
 * Every unlink of a lock file removes it for real and then puts a fresh stale lock in its place, as if other
 * waiters kept taking over: `mode` 'removed' reports success, 'enoent' reports that it was already gone. After
 * `times` rounds it stops, so a loop without a deadline check ends by taking the lock instead of spinning on.
 */
function staleForever(mode, times, counter) {
	return (real) =>
		async (p, ...rest) => {
			if (!lockFile(p)) return real(p, ...rest);
			counter.n++;
			await sleep(2); // each round takes a little time, so the deadline can pass
			if (counter.n <= times) {
				await real(p, ...rest).catch(() => {});
				writeFileSync(p, JSON.stringify({ pid: 1, host: 'elsewhere', at: 1 }));
				if (mode === 'enoent') throw fsError('ENOENT');
				return undefined;
			}
			return real(p, ...rest);
		};
}

for (const mode of ['removed', 'enoent']) {
	test(`a stale lock that is taken over again and again ends in \`locked\` at the deadline (unlink ${mode})`, { timeout: 5000 }, async () => {
		const { base } = fresh();
		const dir = join(base, 'logs');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'x.lock'), JSON.stringify({ pid: 1, host: 'elsewhere', at: 1 })); // stale: old, and not on this host
		const counter = { n: 0 };
		await withReplaced('unlink', staleForever(mode, 400, counter), async () => {
			await rejects(withLock(dir, 'x', async () => 'got it', { staleMs: 1000, waitMs: 60, pollMs: 5 }), 'locked');
		});
		// Only outcomes that do not depend on how fast the machine is: the stale path ran, and the loop stopped at the
		// deadline instead of after every round. (How many rounds fit into 60 ms varies; a loaded runner may fit one.)
		assert.ok(counter.n >= 1, `the stale path ran (${counter.n})`);
		assert.ok(counter.n < 400, `it gave up at the deadline, not after every round (${counter.n})`);
	});
}

test('a stale lock is still taken over when the deadline has not passed', async () => {
	const { base } = fresh();
	const dir = join(base, 'logs');
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'x.lock'), JSON.stringify({ pid: 1, host: 'elsewhere', at: 1 }));
	assert.equal(await withLock(dir, 'x', async () => 'got it', { staleMs: 1000, waitMs: 2000, pollMs: 5 }), 'got it');
	assert.equal(existsSync(join(dir, 'x.lock')), false);
});

// --- issue-index.mjs: a failed refresh changes nothing (A4) ---

test('a refresh that fails part way leaves the cache as it was: a later note of our own write keeps the first issue and its aliases', async () => {
	const { store } = fresh();
	await store.writeIssue(issue('PSE-1', { aliases: ['PSE-900'] }), { expect: 'new' });
	await store.writeIssue(issue('PSE-2'), { expect: 'new' });
	await store.writeIssue(issue('PSE-4', { aliases: ['PSE-904'] }), { expect: 'new' });
	await store.index.refresh();
	assert.equal(store.index.resolve('PSE-900'), 'PSE-1');

	// All three files change by hand, so the refresh has to read all three. PSE-1 answers "gone" (ENOENT), PSE-2
	// fails (EIO), PSE-4 reads fine with a different alias. The refresh fails, so none of that may reach the cache.
	for (const [id, extra] of [['PSE-1', { aliases: ['PSE-900'] }], ['PSE-2', {}], ['PSE-4', { aliases: ['PSE-905'] }]]) {
		writeFileSync(store.issuePath(id), serializeDocument({ id, title: `Changed by hand ${id}`, ...extra }, ''));
	}
	await withBroken(
		'open',
		([p, flag]) => (flag === 'r' && String(p).endsWith('PSE-1.md') ? fsError('ENOENT') : flag === 'r' && String(p).endsWith('PSE-2.md') ? fsError('EIO') : null),
		async () => {
			await rejects(store.index.refresh(), 'unreadable');
		},
	);

	// A note of our own write rebuilds the index from the cache.
	await store.index.noteWritten('PSE/PSE-3.md', { id: 'PSE-3', title: 'New' }, { m: 1, s: 1 });
	assert.deepEqual(store.index.entries().map((e) => e.id), ['PSE-1', 'PSE-2', 'PSE-3', 'PSE-4'], 'PSE-1 was not dropped by the failed refresh');
	assert.equal(store.index.resolve('PSE-900'), 'PSE-1', 'its alias is still there');
	assert.equal(store.index.get('PSE-1').fields.title, 'Title of PSE-1', 'and nothing of the failed refresh was kept');
	assert.equal(store.index.resolve('PSE-904'), 'PSE-4', 'a file read before the failure was not half-applied');
	assert.equal(store.index.resolve('PSE-905'), null);

	// With the files readable again, the next refresh sees the hand edits.
	const { reread } = await store.index.refresh();
	assert.equal(reread, 3);
	assert.equal(store.index.get('PSE-1').fields.title, 'Changed by hand PSE-1');
	assert.equal(store.index.resolve('PSE-905'), 'PSE-4');
});
