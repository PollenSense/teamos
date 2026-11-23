import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { withLock } from './lock.mjs';

// Regression test for the CodeRabbit review of PR #15 (2026-11-23, round 7): the lock record's `at` must be the
// moment the lock was taken, not the moment the writer started waiting for it.

let root;
before(() => {
	root = mkdtempSync(join(tmpdir(), 'board-cr15r7-'));
});
after(() => {
	rmSync(root, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a writer that waited records the time it took the lock, not the time it began waiting', async () => {
	const dir = join(root, 'logs');
	let firstHolding;
	const holding = new Promise((resolve) => {
		firstHolding = resolve;
	});
	let endOfFirst = 0;
	const first = withLock(dir, 'x', async () => {
		firstHolding();
		await sleep(200);
		endOfFirst = Date.now();
	});
	await holding;
	let recorded = null;
	const second = withLock(
		dir,
		'x',
		async () => {
			recorded = JSON.parse(readFileSync(join(dir, 'x.lock'), 'utf-8'));
		},
		{ waitMs: 5000, pollMs: 5 },
	);
	await Promise.all([first, second]);
	assert.ok(endOfFirst > 0, 'the first writer ran to its end');
	assert.ok(recorded, 'the second writer read its own lock file');
	// The second writer began waiting while the first still held the lock (about 200 ms earlier). With the record
	// built before the wait, `at` would be older than the first release.
	assert.ok(recorded.at >= endOfFirst, `at (${recorded.at}) is not before the first release (${endOfFirst})`);
	assert.equal(recorded.pid, process.pid);
});
