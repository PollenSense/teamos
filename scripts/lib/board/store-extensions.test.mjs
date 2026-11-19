import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardStore, assertDocumentId } from './index.mjs';

function sandbox(options = {}) {
	const root = mkdtempSync(join(tmpdir(), 'board-ext-'));
	const dir = join(root, 'team', 'board');
	mkdirSync(dir, { recursive: true });
	return { root, dir, store: new BoardStore({ dir, lockDir: join(root, 'locks'), ...options }), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const code = (c) => (e) => e.code === c;

test('documents: write, read, list; identical text is not a write; a second writer must name what it replaces', async () => {
	const s = sandbox();
	try {
		const doc = { fields: { id: 'doc-1', title: 'A title', project: 'p', source: { system: 'linear' } }, body: 'Some text.' };
		assert.equal((await s.store.writeDocument(doc, { expect: 'new' })).changed, true);
		const read = await s.store.readDocument('doc-1');
		assert.equal(read.fields.title, 'A title');
		assert.equal(read.body.trim(), 'Some text.');
		assert.deepEqual(await s.store.listDocuments(), ['doc-1']);
		assert.equal((await s.store.writeDocument(doc, { expect: read.hash })).changed, false);
		await assert.rejects(s.store.writeDocument(doc, { expect: 'new' }), code('duplicate-id'));
		await assert.rejects(s.store.writeDocument(doc, { expect: 'not-the-hash' }), code('changed'));
		await assert.rejects(s.store.writeDocument(doc), code('bad-call'));
	} finally {
		s.cleanup();
	}
});

test('documents: an id that could leave the folder is refused before any path is built', async () => {
	const s = sandbox();
	try {
		for (const bad of ['../x', 'a/b', '', '.hidden', 'a'.repeat(65), 'a b', undefined, 7]) {
			assert.throws(() => assertDocumentId(bad), code('bad-id'));
			await assert.rejects(s.store.writeDocument({ fields: { id: bad, title: 't' }, body: '' }, { expect: 'new' }), code('bad-id'));
		}
		assert.equal(existsSync(join(s.dir, 'documents')), false);
	} finally {
		s.cleanup();
	}
});

test('single files: only people, labels and project-map; read and replace whole', async () => {
	const s = sandbox();
	try {
		assert.equal(await s.store.readSingle('labels'), null);
		await s.store.writeSingle('labels', { version: 1, labels: [] }, { expect: 'new' });
		const read = await s.store.readSingle('labels');
		assert.deepEqual(read.data, { version: 1, labels: [] });
		assert.equal((await s.store.writeSingle('labels', { version: 1, labels: [] }, { expect: read.hash })).changed, false);
		for (const bad of ['../people', 'issues', 'people.json', '', undefined]) {
			await assert.rejects(s.store.readSingle(bad), code('bad-id'));
			await assert.rejects(s.store.writeSingle(bad, {}, { expect: 'new' }), code('bad-id'));
		}
		await s.store.writePeople({ version: 1, people: {} }, { expect: 'new' });
		assert.deepEqual((await s.store.readPeople()).data, { version: 1, people: {} }, 'the people methods read the same file as readSingle');
		assert.deepEqual((await s.store.readSingle('people')).data, { version: 1, people: {} });
	} finally {
		s.cleanup();
	}
});

test('dryRun: every write runs its checks and says what it would do, and no file or folder appears', async () => {
	const s = sandbox({ dryRun: true });
	try {
		const team = { key: 'PSE', name: 'Eng' };
		assert.equal((await s.store.writeTeam(team, { expect: 'new' })).changed, true);
		assert.equal((await s.store.writeProject({ fields: { code: 'p', name: 'P' }, body: 'x' }, { expect: 'new' })).changed, true);
		assert.equal((await s.store.writeDocument({ fields: { id: 'd-1', title: 't' }, body: 'x' }, { expect: 'new' })).changed, true);
		assert.equal((await s.store.writeSingle('people', { a: 1 }, { expect: 'new' })).changed, true);
		assert.equal((await s.store.writeIssue({ fields: { id: 'PSE-1', team: 'PSE', title: 'T' }, body: '' }, { expect: 'new' })).changed, true);
		assert.deepEqual(readdirSync(s.dir), [], 'the board folder is still empty');
		assert.equal(s.store.index.byId.has('PSE-1'), false, 'the in-memory index does not learn of a file that was not written');
		assert.equal(existsSync(join(s.root, 'locks', 'index.json')), false, 'the issue index cache is not written either');
		await assert.rejects(s.store.writeTeam(team), code('bad-call'), 'a dry run checks the call like a real one');
	} finally {
		s.cleanup();
	}
});

test('dryRun against an existing file: unchanged text says changed false, new text says true, neither writes', async () => {
	const real = sandbox();
	try {
		await real.store.writeDocument({ fields: { id: 'd-1', title: 'one' }, body: 'x' }, { expect: 'new' });
		const dry = new BoardStore({ dir: real.dir, lockDir: join(real.root, 'locks'), dryRun: true });
		const current = await dry.readDocument('d-1');
		assert.equal((await dry.writeDocument({ fields: { id: 'd-1', title: 'one' }, body: 'x' }, { expect: current.hash })).changed, false);
		assert.equal((await dry.writeDocument({ fields: { id: 'd-1', title: 'two' }, body: 'x' }, { expect: current.hash })).changed, true);
		assert.match(readFileSync(join(real.dir, 'documents', 'd-1.md'), 'utf8'), /"one"/, 'the file still says one');
	} finally {
		real.cleanup();
	}
});

test('project and team fields added for the importer are kept on a write', async () => {
	const s = sandbox();
	try {
		await s.store.writeProject({ fields: { code: 'p', name: 'P', statusType: 'started', archived: '2025-01-01T00:00:00.000Z', completed: '2025-02-01', canceled: '2025-03-01' }, body: '' }, { expect: 'new' });
		const p = await s.store.readProject('p');
		assert.deepEqual([p.fields.statusType, p.fields.archived, p.fields.completed, p.fields.canceled], ['started', '2025-01-01T00:00:00.000Z', '2025-02-01', '2025-03-01']);
		await s.store.writeTeam({ key: 'PSE', name: 'E', private: true, archived: '2025-01-01T00:00:00.000Z' }, { expect: 'new' });
		assert.equal((await s.store.readTeam('PSE')).data.private, true);
	} finally {
		s.cleanup();
	}
});

test('dryRun on an issue that exists: the index keeps what the file says, not what the dry write would have said', async () => {
	const real = sandbox();
	try {
		const one = { fields: { id: 'PSE-1', team: 'PSE', title: 'one' }, body: '' };
		await real.store.writeIssue(one, { expect: 'new' });
		const dry = new BoardStore({ dir: real.dir, lockDir: join(real.root, 'locks'), dryRun: true });
		const current = await dry.readIssue('PSE-1');
		assert.equal((await dry.writeIssue({ fields: { ...one.fields, title: 'two' }, body: '' }, { expect: current.hash })).changed, true);
		await dry.index.refresh();
		assert.equal(dry.index.byId.get('PSE-1').fields.title, 'one');
		assert.match(readFileSync(join(real.dir, 'issues', 'PSE', 'PSE-1.md'), 'utf8'), /"one"/);
	} finally {
		real.cleanup();
	}
});
