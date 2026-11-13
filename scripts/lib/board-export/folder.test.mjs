import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FORMAT, FORMAT_VERSION, MANIFEST_FILE, TYPE_NAMES, readExport, writeExport } from './index.mjs';
import { buildFixture } from './fixture-data.mjs';

const FILTER = '- /team/board/raw/**\n';

function sandbox() {
	const root = mkdtempSync(join(tmpdir(), 'board-export-folder-'));
	const workspace = join(root, 'pollen-bot');
	mkdirSync(join(workspace, 'team', 'board'), { recursive: true });
	const out = join(root, 'linear-export');
	return { root, workspace, out, guard: { workspaceRoot: workspace, filterText: FILTER }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Re-write a file and fix its manifest entry (hash + count), as a careful foreign producer would. */
function rewrite(dir, type, mutate, { fixHash = true } = {}) {
	const file = join(dir, `${type}.json`);
	const doc = readJson(file);
	mutate(doc);
	const text = `${JSON.stringify(doc)}\n`;
	writeFileSync(file, text);
	if (fixHash) {
		const manifest = readJson(join(dir, MANIFEST_FILE));
		manifest.entities[type].sha256 = sha(Buffer.from(text));
		writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest));
	}
}

const code = (c) => (e) => e.code === c;

test('write then read gives back every record of every type', async () => {
	const s = sandbox();
	try {
		const fixture = buildFixture();
		const { manifest } = await writeExport(s.out, { source: 'fixture', fetchedAt: '2026-11-13T10:00:00.000Z', entities: fixture }, s.guard);
		assert.equal(manifest.format, FORMAT);
		assert.equal(manifest.version, FORMAT_VERSION);
		assert.equal(manifest.complete, true);
		const back = await readExport(s.out);
		assert.deepEqual(back.entities, fixture);
		for (const type of TYPE_NAMES) assert.equal(back.manifest.entities[type].count, fixture[type].length);
		assert.deepEqual(readdirSync(s.out).sort(), [MANIFEST_FILE, ...TYPE_NAMES.map((t) => `${t}.json`)].sort(), 'no temp files left behind');
		assert.equal(statSync(join(s.out, MANIFEST_FILE)).mode & 0o077, 0, 'files are private to the owner');
		assert.equal(statSync(s.out).mode & 0o077, 0, 'the folder is private to the owner');
	} finally {
		s.cleanup();
	}
});

test('a folder made by another producer, by hand, with only JSON and a hash, reads', async () => {
	const s = sandbox();
	try {
		mkdirSync(s.out);
		const fixture = buildFixture();
		const entities = {};
		for (const type of ['teams', 'issues']) {
			const text = `${JSON.stringify({ type, version: 1, records: fixture[type].slice().reverse() }, null, 1)}\n`;
			writeFileSync(join(s.out, `${type}.json`), text);
			entities[type] = { file: `${type}.json`, count: fixture[type].length, sha256: sha(Buffer.from(text)) };
		}
		writeFileSync(join(s.out, MANIFEST_FILE), JSON.stringify({ entities, complete: true, fetchedAt: '2026-11-13T10:00:00Z', source: 'by-hand', version: 1, format: 'teamos-board-export' }));
		const back = await readExport(s.out, { require: ['teams', 'issues'] });
		assert.deepEqual(Object.keys(back.entities).sort(), ['issues', 'teams']);
		assert.deepEqual(back.entities.issues.map((i) => i.key).sort(), ['INS-9', 'PSE-1', 'PSE-2']);
	} finally {
		s.cleanup();
	}
});

test('order does not matter: shuffled records and manifest keys read as the same set', async () => {
	const s = sandbox();
	try {
		const fixture = buildFixture();
		await writeExport(s.out, { source: 'fixture', entities: fixture }, s.guard);
		rewrite(s.out, 'issues', (d) => d.records.reverse());
		rewrite(s.out, 'users', (d) => d.records.reverse());
		const manifest = readJson(join(s.out, MANIFEST_FILE));
		manifest.entities = Object.fromEntries(Object.entries(manifest.entities).reverse());
		writeFileSync(join(s.out, MANIFEST_FILE), JSON.stringify(manifest));
		const back = await readExport(s.out);
		const ids = (list) => list.map((r) => r.id).sort();
		for (const type of TYPE_NAMES) assert.deepEqual(ids(back.entities[type]), ids(fixture[type]), type);
	} finally {
		s.cleanup();
	}
});

test('a manifest with a newer version is refused with a message that says to update', async () => {
	const s = sandbox();
	try {
		await writeExport(s.out, { source: 'fixture', entities: buildFixture() }, s.guard);
		const manifest = readJson(join(s.out, MANIFEST_FILE));
		writeFileSync(join(s.out, MANIFEST_FILE), JSON.stringify({ ...manifest, version: FORMAT_VERSION + 1 }));
		await assert.rejects(readExport(s.out), (e) => e.code === 'version-newer' && /Update TeamOS/.test(e.message) && new RegExp(`version ${FORMAT_VERSION + 1}`).test(e.message));
	} finally {
		s.cleanup();
	}
});

test('a missing, zero, fractional, text or absent version is invalid, not newer or fine', async () => {
	const s = sandbox();
	try {
		await writeExport(s.out, { source: 'fixture', entities: buildFixture() }, s.guard);
		const manifest = readJson(join(s.out, MANIFEST_FILE));
		for (const version of [undefined, 0, -1, 1.5, '1', null, Infinity]) {
			writeFileSync(join(s.out, MANIFEST_FILE), JSON.stringify({ ...manifest, version }));
			await assert.rejects(readExport(s.out), code('version-invalid'), String(version));
		}
	} finally {
		s.cleanup();
	}
});

test('manifest problems: missing, not JSON, wrong format, not an object, incomplete, no source', async () => {
	const s = sandbox();
	try {
		mkdirSync(s.out);
		await assert.rejects(readExport(s.out), code('missing-manifest'));
		writeFileSync(join(s.out, MANIFEST_FILE), '{not json');
		await assert.rejects(readExport(s.out), code('manifest-damaged'));
		writeFileSync(join(s.out, MANIFEST_FILE), '[]');
		await assert.rejects(readExport(s.out), code('manifest-damaged'));
		await writeExport(s.out, { source: 'fixture', entities: buildFixture() }, s.guard);
		const manifest = readJson(join(s.out, MANIFEST_FILE));
		const put = (m) => writeFileSync(join(s.out, MANIFEST_FILE), JSON.stringify(m));
		put({ ...manifest, format: 'something-else' });
		await assert.rejects(readExport(s.out), code('wrong-format'));
		put({ ...manifest, source: '' });
		await assert.rejects(readExport(s.out), code('manifest-damaged'));
		put({ ...manifest, fetchedAt: '2026-02-30T10:00:00Z' });
		await assert.rejects(readExport(s.out), code('manifest-damaged'));
		put({ ...manifest, complete: false });
		await assert.rejects(readExport(s.out), code('export-incomplete'));
		assert.equal((await readExport(s.out, { allowIncomplete: true })).manifest.complete, false);
		put({ ...manifest, entities: [] });
		await assert.rejects(readExport(s.out), code('manifest-damaged'));
	} finally {
		s.cleanup();
	}
});

test('an entity file that changed after the manifest was written is refused (hash), also when it is half-written', async () => {
	const s = sandbox();
	try {
		await writeExport(s.out, { source: 'fixture', entities: buildFixture() }, s.guard);
		rewrite(s.out, 'issues', (d) => { d.records[0].title = 'edited by hand'; }, { fixHash: false });
		await assert.rejects(readExport(s.out), (e) => e.code === 'hash-mismatch' && /"issues"/.test(e.message));
		await writeExport(s.out, { source: 'fixture', entities: buildFixture() }, s.guard);
		const text = readFileSync(join(s.out, 'comments.json'), 'utf8');
		writeFileSync(join(s.out, 'comments.json'), text.slice(0, text.length >> 1));
		await assert.rejects(readExport(s.out), code('hash-mismatch'));
	} finally {
		s.cleanup();
	}
});

test('file problems with a matching hash: invalid JSON, wrong header, wrong count, invalid record, duplicate id', async () => {
	const s = sandbox();
	try {
		const fresh = () => writeExport(s.out, { source: 'fixture', entities: buildFixture() }, s.guard);
		await fresh();
		const bad = '{"type":"issues"';
		writeFileSync(join(s.out, 'issues.json'), bad);
		const m = readJson(join(s.out, MANIFEST_FILE));
		m.entities.issues.sha256 = sha(Buffer.from(bad));
		writeFileSync(join(s.out, MANIFEST_FILE), JSON.stringify(m));
		await assert.rejects(readExport(s.out), code('file-damaged'));

		await fresh();
		rewrite(s.out, 'issues', (d) => { d.type = 'comments'; });
		await assert.rejects(readExport(s.out), code('file-damaged'));
		await fresh();
		rewrite(s.out, 'issues', (d) => { d.version = 2; });
		await assert.rejects(readExport(s.out), code('file-damaged'));
		await fresh();
		rewrite(s.out, 'issues', (d) => { d.records.pop(); });
		await assert.rejects(readExport(s.out), code('count-mismatch'));
		await fresh();
		rewrite(s.out, 'issues', (d) => { delete d.records[1].title; });
		await assert.rejects(readExport(s.out), (e) => e.code === 'invalid-record' && /issues: record 2/.test(e.message));
		await fresh();
		rewrite(s.out, 'issues', (d) => { d.records[2].id = d.records[0].id; });
		await assert.rejects(readExport(s.out), code('duplicate-id'));
	} finally {
		s.cleanup();
	}
});

test('a listed file that is missing, a link, or a path out of the folder is refused; an unknown type too', async () => {
	const s = sandbox();
	try {
		await writeExport(s.out, { source: 'fixture', entities: buildFixture() }, s.guard);
		const manifest = readJson(join(s.out, MANIFEST_FILE));
		const put = (m) => writeFileSync(join(s.out, MANIFEST_FILE), JSON.stringify(m));
		rmSync(join(s.out, 'labels.json'));
		await assert.rejects(readExport(s.out), code('file-missing'));

		await writeExport(s.out, { source: 'fixture', entities: buildFixture() }, s.guard);
		const elsewhere = join(s.root, 'elsewhere.json');
		writeFileSync(elsewhere, readFileSync(join(s.out, 'labels.json')));
		rmSync(join(s.out, 'labels.json'));
		symlinkSync(elsewhere, join(s.out, 'labels.json'));
		await assert.rejects(readExport(s.out), code('file-missing'));
		rmSync(join(s.out, 'labels.json'));
		writeFileSync(join(s.out, 'labels.json'), readFileSync(elsewhere));

		put({ ...manifest, entities: { ...manifest.entities, labels: { ...manifest.entities.labels, file: '../elsewhere.json' } } });
		await assert.rejects(readExport(s.out), code('manifest-damaged'));
		put({ ...manifest, entities: { ...manifest.entities, secrets: manifest.entities.labels } });
		await assert.rejects(readExport(s.out), code('unknown-type'));
		put({ ...manifest, entities: { ...manifest.entities, labels: { ...manifest.entities.labels, sha256: 'xyz' } } });
		await assert.rejects(readExport(s.out), code('manifest-damaged'));
	} finally {
		s.cleanup();
	}
});

test('require names the types a caller needs; a file above the size limit is refused', async () => {
	const s = sandbox();
	try {
		await writeExport(s.out, { source: 'fixture', entities: { teams: buildFixture().teams } }, s.guard);
		assert.equal((await readExport(s.out, { require: ['teams'] })).entities.teams.length, 2);
		await assert.rejects(readExport(s.out, { require: ['teams', 'issues'] }), (e) => e.code === 'missing-type' && /"issues"/.test(e.message));
		await assert.rejects(readExport(s.out, { require: ['nope'] }), code('unknown-type'));
		await assert.rejects(readExport(s.out, { maxFileBytes: 20 }), code('file-too-large'));
	} finally {
		s.cleanup();
	}
});

test('writeExport refuses an invalid record and writes nothing', async () => {
	const s = sandbox();
	try {
		const entities = buildFixture();
		entities.issues[1] = { ...entities.issues[1], key: 'nope' };
		await assert.rejects(writeExport(s.out, { source: 'fixture', entities }, s.guard), code('invalid-record'));
		assert.equal(existsSync(s.out), false);
		await assert.rejects(writeExport(s.out, { source: 'fixture', entities: { bogus: [] } }, s.guard), code('unknown-type'));
		await assert.rejects(writeExport(s.out, { source: '', entities: {} }, s.guard), code('manifest-damaged'));
		await assert.rejects(writeExport(s.out, { source: 'x', fetchedAt: 'not a date', entities: {} }, s.guard), code('manifest-damaged'));
		assert.equal(existsSync(s.out), false);
	} finally {
		s.cleanup();
	}
});

test('writeExport asks the sync guard first: inside the synced workspace it needs the filter lines', async () => {
	const s = sandbox();
	try {
		const inside = join(s.workspace, 'team', 'board', 'raw', 'export');
		await assert.rejects(writeExport(inside, { source: 'fixture', entities: buildFixture() }, { workspaceRoot: s.workspace, filterText: '- /team/.logs/**\n' }), code('export-synced'));
		assert.equal(existsSync(join(s.workspace, 'team', 'board', 'raw')), false, 'nothing was created');
		await assert.rejects(writeExport(inside, { source: 'fixture', entities: buildFixture() }, undefined), code('export-synced'));
		await writeExport(inside, { source: 'fixture', entities: buildFixture() }, s.guard);
		assert.equal((await readExport(inside)).entities.users.length, 3);
		const wrong = join(s.workspace, 'team', 'board', 'issues', 'export');
		await assert.rejects(writeExport(wrong, { source: 'fixture', entities: buildFixture() }, s.guard), code('export-synced'));
	} finally {
		s.cleanup();
	}
});

test('a folder with other files and no manifest is not written into', async () => {
	const s = sandbox();
	try {
		mkdirSync(s.out);
		writeFileSync(join(s.out, 'notes.txt'), 'mine');
		await assert.rejects(writeExport(s.out, { source: 'fixture', entities: buildFixture() }, s.guard), code('not-export-folder'));
		assert.deepEqual(readdirSync(s.out), ['notes.txt']);
	} finally {
		s.cleanup();
	}
});

test('a second write replaces the export: types left out are removed, other files stay', async () => {
	const s = sandbox();
	try {
		await writeExport(s.out, { source: 'fixture', entities: buildFixture() }, s.guard);
		writeFileSync(join(s.out, 'README-mine.txt'), 'mine');
		await writeExport(s.out, { source: 'fixture', entities: { teams: buildFixture().teams } }, s.guard);
		assert.deepEqual(readdirSync(s.out).sort(), [MANIFEST_FILE, 'README-mine.txt', 'teams.json'].sort());
		assert.deepEqual(Object.keys((await readExport(s.out)).entities), ['teams']);
	} finally {
		s.cleanup();
	}
});

test('a stopped write leaves a folder the reader refuses, never a mix', async () => {
	const s = sandbox();
	try {
		const first = buildFixture();
		await writeExport(s.out, { source: 'fixture', entities: first }, s.guard);
		// Simulate a second run that replaced issues.json and died before the manifest.
		const second = buildFixture();
		second.issues.push({ ...second.issues[0], id: 'i-9', key: 'PSE-9', number: 9 });
		const text = `${JSON.stringify({ type: 'issues', version: 1, records: second.issues })}\n`;
		writeFileSync(join(s.out, 'issues.json'), text);
		await assert.rejects(readExport(s.out), code('hash-mismatch'));
	} finally {
		s.cleanup();
	}
});
