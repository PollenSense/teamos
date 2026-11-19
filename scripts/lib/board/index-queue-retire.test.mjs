import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { serializeDocument } from './frontmatter.mjs';
import { BoardStore } from './store.mjs';

// PR #15 finding 4 (refresh and the notes of our own writes run in one queue) also covers `noteRemoved`, which a
// retiring write calls after it deleted the old card's file.

let root;
before(() => {
	root = mkdtempSync(join(tmpdir(), 'board-queue-retire-'));
});
after(() => {
	rmSync(root, { recursive: true, force: true });
});

test('a removal noted while a refresh is reading that card is not undone by the refresh', async () => {
	const base = join(root, 'a');
	const store = new BoardStore({ dir: join(base, 'board'), lockDir: join(base, 'logs') });
	await store.writeIssue({ fields: { id: 'PSE-1', title: 'One' }, body: '' }, { expect: 'new' });
	await store.writeIssue({ fields: { id: 'PSE-2', title: 'Two' }, body: '' }, { expect: 'new' });
	const index = store.index;
	await index.refresh();
	// PSE-2 changed on disk, so the next refresh must read it; hold that read after it has finished reading.
	writeFileSync(store.issuePath('PSE-2'), serializeDocument({ id: 'PSE-2', title: 'Two, edited by hand' }, ''));
	const realRead = index._readFront.bind(index);
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	let read;
	const readPromise = new Promise((resolve) => {
		read = resolve;
	});
	index._readFront = async (path) => {
		const parsed = await realRead(path);
		if (path.endsWith('PSE-2.md')) {
			read();
			await gate;
		}
		return parsed;
	};
	const refreshing = index.refresh();
	await readPromise;
	index._readFront = realRead;
	// The store retires PSE-2 meanwhile: file deleted, then the index told.
	unlinkSync(store.issuePath('PSE-2'));
	const noting = index.noteRemoved('PSE/PSE-2.md');
	await new Promise((resolve) => setTimeout(resolve, 50));
	release();
	await Promise.all([refreshing, noting]);
	assert.deepEqual(index.entries().map((e) => e.id), ['PSE-1'], 'PSE-2 stays removed without another refresh');
});
