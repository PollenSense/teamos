import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardStore } from './index.mjs';

function sandbox(options = {}) {
	const root = mkdtempSync(join(tmpdir(), 'board-thread-'));
	const dir = join(root, 'team', 'board');
	mkdirSync(dir, { recursive: true });
	return { root, dir, store: new BoardStore({ dir, lockDir: join(root, 'locks'), ...options }), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const code = (c) => (e) => e.code === c;
const card = (id, extra = {}) => ({ fields: { id, linearId: 'lin-1', title: `Card ${id}`, source: { system: 'linear' }, ...extra }, body: 'Text.' });
const entry = (extra = {}) => ({ time: '2025-02-01T09:00:00.000Z', author: 'alice', id: 'cm-1', source: 'linear', body: 'Invented comment.', ...extra });

test('a thread is written beside its card, read back, and an identical write changes nothing', async () => {
	const s = sandbox();
	try {
		await s.store.writeIssue(card('PSE-1'), { expect: 'new' });
		assert.equal(await s.store.readThread('PSE-1'), null);
		const first = await s.store.writeThread('PSE-1', [entry()], { expect: 'new' });
		assert.equal(first.changed, true);
		assert.equal(existsSync(join(s.dir, 'issues', 'PSE', 'PSE-1.thread.md')), true);
		const read = await s.store.readThread('PSE-1');
		assert.deepEqual(read.entries, [entry()]);
		assert.equal(read.hash, first.hash);
		const again = await s.store.writeThread('PSE-1', [entry()], { expect: read.hash });
		assert.equal(again.changed, false);
		const edited = await s.store.writeThread('PSE-1', [entry(), entry({ id: 'cm-2', body: 'more' })], { expect: read.hash });
		assert.equal(edited.changed, true);
		assert.equal((await s.store.readThread('PSE-1')).entries.length, 2);
		assert.deepEqual(readdirSync(join(s.dir, 'issues', 'PSE')).sort(), ['PSE-1.md', 'PSE-1.thread.md'], 'no temp file is left');
		await s.store.index.refresh();
		assert.equal(s.store.index.byId.has('PSE-1'), true);
		assert.equal(s.store.index.byId.size, 1, 'a thread file is not an issue');
	} finally {
		s.cleanup();
	}
});

test('a write names what it replaces: new over a file, a stale hash, a missing file, no expect', async () => {
	const s = sandbox();
	try {
		await s.store.writeIssue(card('PSE-1'), { expect: 'new' });
		await assert.rejects(s.store.writeThread('PSE-1', [entry()], { expect: 'abc' }), code('missing'));
		await assert.rejects(s.store.writeThread('PSE-1', [entry()]), code('bad-call'));
		await s.store.writeThread('PSE-1', [entry()], { expect: 'new' });
		await assert.rejects(s.store.writeThread('PSE-1', [entry({ body: 'x' })], { expect: 'new' }), code('duplicate-id'));
		await assert.rejects(s.store.writeThread('PSE-1', [entry({ body: 'x' })], { expect: 'a'.repeat(64) }), code('changed'));
		assert.equal((await s.store.readThread('PSE-1')).entries[0].body, 'Invented comment.', 'nothing was overwritten');
	} finally {
		s.cleanup();
	}
});

test('a damaged thread file is never overwritten, even with the right hash', async () => {
	const s = sandbox();
	try {
		await s.store.writeIssue(card('PSE-1'), { expect: 'new' });
		const path = s.store.threadPath('PSE-1');
		writeFileSync(path, '<<<<<<< conflict\nsomebody typed here\n');
		await assert.rejects(s.store.readThread('PSE-1'), code('damaged'));
		const before = readFileSync(path, 'utf8');
		await assert.rejects(s.store.writeThread('PSE-1', [entry()], { expect: 'a'.repeat(64) }), code('damaged'));
		assert.equal(readFileSync(path, 'utf8'), before);
	} finally {
		s.cleanup();
	}
});

test('a thread needs a card (real run), a bad id or a bad entry is refused, a dry run writes nothing', async () => {
	const s = sandbox();
	try {
		await assert.rejects(s.store.writeThread('PSE-1', [entry()], { expect: 'new' }), code('missing'));
		await assert.rejects(s.store.writeThread('../x', [entry()], { expect: 'new' }), code('bad-id'));
		await s.store.writeIssue(card('PSE-1'), { expect: 'new' });
		await assert.rejects(s.store.writeThread('PSE-1', [entry({ author: 'two\nlines' })], { expect: 'new' }), code('bad-value'));
		assert.equal(existsSync(s.store.threadPath('PSE-1')), false);
		const dry = new BoardStore({ dir: s.dir, lockDir: join(s.root, 'locks'), dryRun: true });
		const r = await dry.writeThread('PSE-9', [entry()], { expect: 'new' });
		assert.equal(r.changed, true, 'a dry run answers as a write would (the card of a new issue is not there yet)');
		assert.equal(existsSync(dry.threadPath('PSE-9')), false);
		assert.equal(existsSync(join(s.dir, 'issues', 'PSE', 'PSE-9.thread.md')), false);
	} finally {
		s.cleanup();
	}
});

test('a thread follows its card when the card moves teams', async () => {
	const s = sandbox();
	try {
		await s.store.writeIssue(card('PSE-2', { aliases: ['INS-5'] }), { expect: 'new' });
		await s.store.writeThread('PSE-2', [entry()], { expect: 'new' });
		await s.store.writeIssue(card('REV-7', { aliases: ['INS-5', 'PSE-2'] }), { expect: 'new', retire: ['PSE-2'] });
		assert.equal(existsSync(s.store.threadPath('PSE-2')), false);
		assert.deepEqual((await s.store.readThread('REV-7')).entries, [entry()]);
	} finally {
		s.cleanup();
	}
});
