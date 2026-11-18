import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardStore } from './index.mjs';

function sandbox(options = {}) {
	const root = mkdtempSync(join(tmpdir(), 'board-retire-'));
	const dir = join(root, 'team', 'board');
	mkdirSync(dir, { recursive: true });
	return { root, dir, store: new BoardStore({ dir, lockDir: join(root, 'locks'), ...options }), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const code = (c) => (e) => e.code === c;
const card = (id, extra = {}) => ({ fields: { id, linearId: 'lin-1', title: `Card ${id}`, source: { system: 'linear' }, ...extra }, body: `Text of ${id}.` });

/** A card imported under PSE-2 (earlier key INS-5), with a field the board does not know and a thread file. */
async function withOldCard(s) {
	await s.store.writeIssue(card('PSE-2', { aliases: ['INS-5'], myfield: 'kept' }), { expect: 'new' });
	writeFileSync(s.store.threadPath('PSE-2'), 'a thread\n');
}
const moved = (extra = {}) => card('REV-7', { aliases: ['INS-5', 'PSE-2'], ...extra });

test('retire: a card that moved teams is written under its new ID and the old file goes, with its thread and extra fields', async () => {
	const s = sandbox();
	try {
		await withOldCard(s);
		const r = await s.store.writeIssue(moved(), { expect: 'new', retire: ['PSE-2'] });
		assert.deepEqual(r.retired, ['PSE-2']);
		assert.equal(existsSync(s.store.issuePath('PSE-2')), false);
		assert.equal(existsSync(s.store.threadPath('PSE-2')), false);
		assert.equal(readFileSync(s.store.threadPath('REV-7'), 'utf8'), 'a thread\n');
		const text = readFileSync(s.store.issuePath('REV-7'), 'utf8');
		assert.match(text, /\nid: "REV-7"\n/);
		assert.match(text, /\nmyfield: "kept"\n/, 'a field the board does not know moves with the card');
		assert.equal(s.store.index.get('PSE-2'), null, 'the index forgets the old card at once');
		assert.equal((await s.store.readIssue('pse-2')).id, 'REV-7');
		assert.equal((await s.store.readIssue('INS-5')).id, 'REV-7');
		assert.equal((await s.store.readIssue('REV-7')).body.trim(), 'Text of REV-7.');
		// a second write of the same card changes nothing and retires nothing
		const again = await s.store.writeIssue(moved(), { expect: (await s.store.readIssue('REV-7')).hash, retire: ['PSE-2'] });
		assert.equal(again.changed, false);
		assert.deepEqual(again.retired, []);
	} finally {
		s.cleanup();
	}
});

test('retire: two old cards that both have a thread, or an old thread and one already at the new ID, is a conflict and changes nothing', async () => {
	const s = sandbox();
	try {
		// the same Linear issue under two earlier keys, each with its own thread
		await s.store.writeIssue(card('PSE-2'), { expect: 'new' });
		await s.store.writeIssue(card('INS-5'), { expect: 'new' });
		writeFileSync(s.store.threadPath('PSE-2'), 'thread of PSE-2\n');
		writeFileSync(s.store.threadPath('INS-5'), 'thread of INS-5\n');
		const before = (id) => readFileSync(s.store.issuePath(id), 'utf8');
		const state = { a: before('PSE-2'), b: before('INS-5') };
		await assert.rejects(s.store.writeIssue(moved(), { expect: 'new', retire: ['PSE-2', 'INS-5'] }), code('thread-conflict'));
		assert.equal(existsSync(s.store.issuePath('REV-7')), false, 'the new card is not written');
		assert.equal(before('PSE-2'), state.a);
		assert.equal(before('INS-5'), state.b);
		assert.equal(readFileSync(s.store.threadPath('PSE-2'), 'utf8'), 'thread of PSE-2\n');
		assert.equal(readFileSync(s.store.threadPath('INS-5'), 'utf8'), 'thread of INS-5\n');
		assert.equal(existsSync(s.store.threadPath('REV-7')), false);
		// a dry run refuses the same way
		const dry = new (s.store.constructor)({ dir: s.dir, lockDir: join(s.root, 'locks'), dryRun: true });
		await assert.rejects(dry.writeIssue(moved(), { expect: 'new', retire: ['PSE-2', 'INS-5'] }), code('thread-conflict'));
		// one old thread and the new card already has one: the rename would replace it
		rmSync(s.store.threadPath('INS-5'));
		mkdirSync(join(s.dir, 'issues', 'REV'), { recursive: true });
		writeFileSync(s.store.threadPath('REV-7'), 'thread already at REV-7\n');
		await assert.rejects(s.store.writeIssue(moved(), { expect: 'new', retire: ['PSE-2', 'INS-5'] }), code('thread-conflict'));
		assert.equal(readFileSync(s.store.threadPath('REV-7'), 'utf8'), 'thread already at REV-7\n');
		assert.equal(readFileSync(s.store.threadPath('PSE-2'), 'utf8'), 'thread of PSE-2\n');
		assert.equal(existsSync(s.store.issuePath('REV-7')), false);
		// a thread file that cannot be inspected (here a link that loops) is no "absent thread": refused as unreadable, nothing changed
		rmSync(s.store.threadPath('REV-7'));
		rmSync(s.store.threadPath('INS-5'), { force: true });
		symlinkSync('INS-5.thread.md', s.store.threadPath('INS-5'));
		await assert.rejects(s.store.writeIssue(moved(), { expect: 'new', retire: ['PSE-2', 'INS-5'] }), code('unreadable'));
		assert.equal(existsSync(s.store.issuePath('REV-7')), false);
		rmSync(s.store.threadPath('INS-5'));
		// with no thread at the new ID, exactly one old thread moves, whichever old card holds it
		const r = await s.store.writeIssue(moved(), { expect: 'new', retire: ['PSE-2', 'INS-5'] });
		assert.deepEqual(r.retired.sort(), ['INS-5', 'PSE-2']);
		assert.equal(readFileSync(s.store.threadPath('REV-7'), 'utf8'), 'thread of PSE-2\n');
		assert.equal(existsSync(s.store.threadPath('PSE-2')), false);
	} finally {
		s.cleanup();
	}
});

test('retire: the file of ANOTHER card is never removed or overwritten', async () => {
	const s = sandbox();
	try {
		await s.store.writeIssue(card('PSE-2', { linearId: 'lin-OTHER' }), { expect: 'new' });
		await assert.rejects(s.store.writeIssue(moved(), { expect: 'new', retire: ['PSE-2'] }), code('alias-conflict'));
		assert.ok(existsSync(s.store.issuePath('PSE-2')));
		assert.equal(existsSync(s.store.issuePath('REV-7')), false);
		// the same without retire: still a conflict (an alias is never another card's file)
		await assert.rejects(s.store.writeIssue(moved(), { expect: 'new' }), code('alias-conflict'));
		// a writer that gives no Linear id cannot retire anything
		await assert.rejects(s.store.writeIssue({ fields: { id: 'REV-7', aliases: ['PSE-2'], title: 'x' }, body: '' }, { expect: 'new', retire: ['PSE-2'] }), code('alias-conflict'));
	} finally {
		s.cleanup();
	}
});

test('retire: what is retired must be an alias of the new card, and not the card itself', async () => {
	const s = sandbox();
	try {
		await withOldCard(s);
		await assert.rejects(s.store.writeIssue(card('REV-7', { aliases: ['INS-5'] }), { expect: 'new', retire: ['PSE-2'] }), code('bad-id'));
		await assert.rejects(s.store.writeIssue(card('REV-7', { aliases: ['INS-5'] }), { expect: 'new', retire: ['REV-7'] }), code('bad-id'));
		await assert.rejects(s.store.writeIssue(moved(), { expect: 'new', retire: ['nonsense'] }), code('bad-id'));
		assert.ok(existsSync(s.store.issuePath('PSE-2')));
	} finally {
		s.cleanup();
	}
});

test('retire: a dry run removes and writes nothing but says what it would retire', async () => {
	const s = sandbox();
	try {
		await withOldCard(s);
		const dry = new BoardStore({ dir: s.dir, lockDir: join(s.root, 'locks'), dryRun: true });
		const r = await dry.writeIssue(moved(), { expect: 'new', retire: ['PSE-2'] });
		assert.deepEqual(r.retired, ['PSE-2']);
		assert.ok(existsSync(s.store.issuePath('PSE-2')));
		assert.ok(existsSync(s.store.threadPath('PSE-2')));
		assert.equal(existsSync(s.store.issuePath('REV-7')), false);
	} finally {
		s.cleanup();
	}
});

test('retire: a run that died between the write and the removal is finished by the next one', async () => {
	const s = sandbox();
	try {
		await withOldCard(s);
		await s.store.writeIssue(moved(), { expect: 'new' }).catch((e) => assert.equal(e.code, 'alias-conflict')); // the plain write is refused ...
		// ... so simulate the half-done state by hand: the new file is there, the old one too
		mkdirSync(join(s.dir, 'issues', 'REV'), { recursive: true });
		writeFileSync(s.store.issuePath('REV-7'), readFileSync(s.store.issuePath('PSE-2'), 'utf8').replace('"PSE-2"', '"REV-7"'));
		const current = await s.store.readIssue('REV-7').catch(() => null);
		const r = await s.store.writeIssue(moved(), { expect: current ? current.hash : 'new', retire: ['PSE-2'] });
		assert.deepEqual(r.retired, ['PSE-2']);
		assert.equal(existsSync(s.store.issuePath('PSE-2')), false);
		assert.equal((await s.store.readIssue('PSE-2')).id, 'REV-7');
	} finally {
		s.cleanup();
	}
});

test('retire: an old file that is not there is simply not retired', async () => {
	const s = sandbox();
	try {
		const r = await s.store.writeIssue(moved(), { expect: 'new', retire: ['PSE-2'] });
		assert.deepEqual(r.retired, []);
		assert.ok(existsSync(s.store.issuePath('REV-7')));
		assert.equal((await s.store.readIssue('PSE-2')).id, 'REV-7');
	} finally {
		s.cleanup();
	}
});

test('retire: a card that moves back to a key it had before (the old file lists it as an alias) is not refused', async () => {
	const s = sandbox();
	try {
		await s.store.writeIssue(card('PSE-2', { aliases: ['REV-7'] }), { expect: 'new' });
		const r = await s.store.writeIssue(card('REV-7', { aliases: ['PSE-2'] }), { expect: 'new', retire: ['PSE-2'] });
		assert.deepEqual(r.retired, ['PSE-2']);
		assert.equal((await s.store.readIssue('PSE-2')).id, 'REV-7');
	} finally {
		s.cleanup();
	}
});

test('retire: a writer that gives no text keeps the old card\'s text', async () => {
	const s = sandbox();
	try {
		await withOldCard(s);
		await s.store.writeIssue({ fields: moved().fields }, { expect: 'new', retire: ['PSE-2'] });
		assert.equal((await s.store.readIssue('REV-7')).body.trim(), 'Text of PSE-2.');
	} finally {
		s.cleanup();
	}
});
