import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardError, BoardStore, parseDocument, parseThread } from '../board/index.mjs';
import { applyIssues, applyUploads, createUploadClient, findUploads, formatUploadsSummary, loadExisting, planIssues, planLinks, planReference, withLinks } from './index.mjs';
import { fakeUploadHost } from './fake-uploads.mjs';
import { MEMBERS, buildExport } from './fixture.mjs';
import { UPLOAD_HOST, uploadId } from './uploads.mjs';

/** Invented data only: names, bytes and addresses are made up (the `.invalid` domain never resolves). */

const KEY = 'lin_api_TESTKEYTESTKEY0123456789';
const link = (path) => `https://${UPLOAD_HOST}/ws/${path}`;
const L = { one: link('pse1/one'), two: link('pse1/two'), three: link('pse1/three'), four: link('pse2/four') };
const sha = (text) => createHash('sha256').update(text).digest('hex');

function sandbox() {
	const root = mkdtempSync(join(tmpdir(), 'board-uploads-'));
	const dir = join(root, 'team', 'board');
	const lockDir = join(root, 'team', '.logs', 'board');
	mkdirSync(dir, { recursive: true });
	return { root, dir, rawDir: join(dir, 'raw'), filesDir: join(dir, 'files'), store: (dryRun = false) => new BoardStore({ dir, lockDir, dryRun }), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function snapshot(dir) {
	const out = {};
	const walk = (d) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else out[p] = `${st.size}:${st.mtimeMs}`;
		}
	};
	if (existsSync(dir)) walk(dir);
	return out;
}

/** The fixture export with upload links: PSE-1 holds three in its description and a comment, PSE-2 (earlier key INS-5) one in a comment. */
function exportWithUploads() {
	const e = buildExport();
	e.issues[0].description = `Look ![shot one](${L.one}) and [report](${L.two}).`;
	e.comments = [
		{ id: 'cm-1', issueKey: 'PSE-1', body: `Same shot again ![](${L.one}) and a photo ![p](${L.three})`, createdAt: '2025-02-01T09:00:00.000Z', authorId: 'u-1' },
		{ id: 'cm-2', issueKey: 'PSE-1', body: 'No link here.', createdAt: '2025-02-01T09:05:00.000Z', botName: 'Test Bot' },
		{ id: 'cm-5', issueKey: 'PSE-1', parentId: 'cm-1', body: 'Reply.', createdAt: '2025-02-01T10:00:00.000Z', authorId: 'u-2' },
		{ id: 'cm-7', issueKey: 'INS-5', body: `On the moved card ![](${L.four})`, createdAt: '2025-02-03T09:00:00.000Z', authorId: 'u-1' },
	];
	return e;
}

const ROUTES = () => ({
	'/ws/pse1/one': { body: 'ONE-BYTES', type: 'image/png', name: 'shot-one.png' },
	'/ws/pse1/two': { body: 'TWO', type: 'application/pdf', name: 'report.pdf' },
	'/ws/pse1/three': { body: 'THREE-BYTES', type: 'image/jpeg', name: 'photo.jpg' },
	'/ws/pse2/four': { body: 'FOUR', type: 'image/png', name: 'moved.png' },
});

async function importCards(s, entities) {
	const store = s.store();
	const existing = await loadExisting(store);
	const reference = planReference(entities, { members: MEMBERS, existing });
	const issues = planIssues(entities, reference);
	const plan = withLinks(issues, planLinks(entities, issues, reference, { report: issues.report }));
	return applyIssues(plan, store, { rawDir: s.rawDir, guard: async () => ({ where: 'test' }) });
}

function world(routes = ROUTES(), entities = exportWithUploads()) {
	const s = sandbox();
	const host = fakeUploadHost(routes, { key: KEY });
	const sleeps = [];
	const client = createUploadClient({ key: KEY, fetchImpl: host.fetchImpl, sleep: async (ms) => void sleeps.push(ms), paceMs: 0 });
	const run = async ({ dry = false, noClient = false, guard = async () => ({ where: 'test' }), ...limits } = {}) => {
		const found = findUploads(entities);
		const result = await applyUploads(found, s.store(dry), { client: noClient ? null : client, boardDir: s.dir, rawDir: s.rawDir, guard, ...limits });
		return { found, ...result };
	};
	return { s, host, client, entities, run };
}

const card = (s, id) => {
	const { fields, body } = parseDocument(readFileSync(join(s.dir, 'issues', id.split('-')[0], `${id}.md`), 'utf8'));
	return { fields, body };
};
const thread = (s, id) => parseThread(readFileSync(join(s.dir, 'issues', id.split('-')[0], `${id}.thread.md`), 'utf8')).entries;
const filesOf = (s, id) => readdirSync(join(s.filesDir, id)).sort();

test('a real run saves each upload under its card, lists it in the card and in the comment that used it', async () => {
	const w = world();
	try {
		await importCards(w.s, w.entities);
		const r = await w.run();
		assert.equal(r.stopped, null);
		assert.deepEqual(r.failures, []);
		assert.equal(r.counts.got.downloaded, 4);
		assert.equal(r.counts.checks.filesBroken, 0);
		assert.equal(r.counts.checks.filesChecked, 4);
		assert.deepEqual(filesOf(w.s, 'PSE-1'), ['photo.jpg', 'report.pdf', 'shot-one.png'], 'the shot used in the description and in a comment is stored once');
		assert.deepEqual(filesOf(w.s, 'PSE-2'), ['moved.png'], 'a link under the earlier key INS-5 lands in the card that holds that key now');
		assert.equal(readFileSync(join(w.s.filesDir, 'PSE-1', 'shot-one.png'), 'utf8'), 'ONE-BYTES');
		assert.deepEqual(card(w.s, 'PSE-1').fields.files, [
			{ upload: uploadId(L.three), path: 'files/PSE-1/photo.jpg', name: 'photo.jpg', bytes: 11, sha256: sha('THREE-BYTES'), type: 'image/jpeg' },
			{ upload: uploadId(L.two), path: 'files/PSE-1/report.pdf', name: 'report.pdf', bytes: 3, sha256: sha('TWO'), type: 'application/pdf' },
			{ upload: uploadId(L.one), path: 'files/PSE-1/shot-one.png', name: 'shot-one.png', bytes: 9, sha256: sha('ONE-BYTES'), type: 'image/png' },
		]);
		assert.equal(card(w.s, 'PSE-2').fields.files[0].path, 'files/PSE-2/moved.png');
		const entries = thread(w.s, 'PSE-1');
		assert.deepEqual(entries.find((e) => e.id === 'cm-1').extra, { files: ['files/PSE-1/photo.jpg', 'files/PSE-1/shot-one.png'] });
		assert.equal(entries.find((e) => e.id === 'cm-2').extra, undefined);
		assert.equal(entries.find((e) => e.id === 'cm-5').extra, undefined);
		assert.deepEqual(thread(w.s, 'PSE-2')[0].extra, { files: ['files/PSE-2/moved.png'] });
		assert.equal(r.counts.threads.entriesLinked, 2);
		assert.deepEqual(w.host.methods(), ['GET', 'HEAD']);
		assert.equal(readdirSync(join(w.s.filesDir, 'PSE-1'), { withFileTypes: true }).some((d) => d.name.startsWith('.')), false, 'no temp file is left');
	} finally {
		w.s.cleanup();
	}
});

test('a second run asks for nothing and touches no file', async () => {
	const w = world();
	try {
		await importCards(w.s, w.entities);
		await w.run();
		const before = snapshot(w.s.dir);
		const calls = w.host.calls.length;
		const again = await w.run();
		assert.equal(w.host.calls.length, calls, 'no request at all');
		assert.deepEqual(snapshot(w.s.dir), before);
		assert.equal(again.counts.uploads.present, 4);
		assert.equal(again.counts.uploads.toFetch, 0);
		assert.equal(again.counts.got.downloaded, 0);
		assert.equal(again.counts.threads.written, 0);
		assert.equal(again.counts.checks.filesBroken, 0);
	} finally {
		w.s.cleanup();
	}
});

test('the issue importer run again keeps the files list and the thread links, and writes nothing', async () => {
	const w = world();
	try {
		await importCards(w.s, w.entities);
		await w.run();
		const before = snapshot(w.s.dir);
		const again = await importCards(w.s, w.entities);
		assert.deepEqual(again.failures, {});
		assert.deepEqual(snapshot(w.s.dir), before, 'neither a card nor a thread nor a file was rewritten');
		assert.equal(card(w.s, 'PSE-1').fields.files.length, 3);
		assert.deepEqual(thread(w.s, 'PSE-1').find((e) => e.id === 'cm-1').extra.files.length, 2);
		// a comment that changed in Linear is rewritten but keeps its links
		const changed = exportWithUploads();
		changed.comments[0].body += ' (edited)';
		await importCards(w.s, changed);
		const entry = thread(w.s, 'PSE-1').find((e) => e.id === 'cm-1');
		assert.match(entry.body, /edited/);
		assert.equal(entry.extra.files.length, 2);
	} finally {
		w.s.cleanup();
	}
});

test('the dry run asks for sizes only and writes nothing; without a client it only counts', async () => {
	const routes = ROUTES();
	routes['/ws/pse1/three'].noLength = true;
	const w = world(routes);
	try {
		await importCards(w.s, w.entities);
		const before = snapshot(w.s.dir);
		const r = await w.run({ dry: true });
		assert.deepEqual(w.host.methods(), ['HEAD']);
		assert.deepEqual(snapshot(w.s.dir), before);
		assert.equal(existsSync(w.s.filesDir), false);
		assert.deepEqual(r.counts.head, { ok: 4, gone: 0, denied: 0, failed: 0, bytesKnown: 9 + 3 + 4, sizeUnknown: 1, largest: 9 });
		assert.equal(r.counts.uploads.toFetch, 4);
		const calls = w.host.calls.length;
		const none = await w.run({ dry: true, noClient: true });
		assert.equal(w.host.calls.length, calls);
		assert.equal(none.counts.uploads.toFetch, 4);
		assert.equal(none.counts.head.ok, 0);
	} finally {
		w.s.cleanup();
	}
});

test('a gone, a denied and a failing upload are named, not saved, and the others are saved', async () => {
	const routes = ROUTES();
	routes['/ws/pse1/two'] = { status: 404 };
	routes['/ws/pse1/three'] = { status: 403 };
	const w = world(routes);
	try {
		await importCards(w.s, w.entities);
		const r = await w.run();
		assert.equal(r.stopped, null);
		assert.equal(r.counts.got.downloaded, 2);
		assert.deepEqual(r.failures.map((f) => [f.card, f.upload, f.result, f.status]).sort(), [
			['PSE-1', uploadId(L.three), 'denied', 403],
			['PSE-1', uploadId(L.two), 'gone', 404],
		].sort());
		assert.deepEqual(filesOf(w.s, 'PSE-1'), ['shot-one.png']);
		assert.equal(card(w.s, 'PSE-1').fields.files.length, 1);
		assert.deepEqual(thread(w.s, 'PSE-1').find((e) => e.id === 'cm-1').extra, { files: ['files/PSE-1/shot-one.png'] }, 'a comment lists only the files it has');
		assert.equal(w.host.calls.filter((c) => c.method === 'GET' && /two|three/.test(c.url)).length, 0, 'no GET for an upload whose HEAD said gone or denied');
	} finally {
		w.s.cleanup();
	}
});

test('a 401 stops the run before anything is written', async () => {
	const w = world();
	try {
		await importCards(w.s, w.entities);
		const wrong = fakeUploadHost(ROUTES(), { key: 'lin_api_SOMEOTHERKEY123456789' });
		const client = createUploadClient({ key: KEY, fetchImpl: wrong.fetchImpl, sleep: async () => {}, paceMs: 0 });
		const r = await applyUploads(findUploads(w.entities), w.s.store(), { client, boardDir: w.s.dir, rawDir: w.s.rawDir, guard: async () => ({}) });
		assert.equal(r.stopped.reason, 'unauthorized');
		assert.equal(existsSync(w.s.filesDir), false);
		assert.equal(card(w.s, 'PSE-1').fields.files, undefined);
	} finally {
		w.s.cleanup();
	}
});

test('a name with ../ lands inside the card folder, with a safe name; the original is kept in the entry', async () => {
	const routes = ROUTES();
	routes['/ws/pse1/one'].name = '../../escape/..\\evil:name?.PNG';
	const w = world(routes);
	try {
		await importCards(w.s, w.entities);
		await w.run();
		const names = filesOf(w.s, 'PSE-1');
		const entry = card(w.s, 'PSE-1').fields.files.find((f) => f.upload === uploadId(L.one));
		assert.equal(names.includes(entry.path.split('/')[2]), true);
		for (const name of names) assert.equal(/[\\/:?]|\.\./.test(name), false, name);
		assert.equal(existsSync(join(w.s.dir, 'escape')), false);
		assert.equal(existsSync(join(w.s.root, 'escape')), false);
		assert.deepEqual(readdirSync(w.s.filesDir), ['PSE-1', 'PSE-2'], 'nothing outside the card folders');
		assert.equal(entry.name.includes('evil'), true, 'the entry keeps the name the host gave, for people to read');
	} finally {
		w.s.cleanup();
	}
});

test('two uploads with the same name, or the same name in another case, are numbered', async () => {
	const routes = ROUTES();
	routes['/ws/pse1/one'].name = 'shot.png';
	routes['/ws/pse1/two'].name = 'shot.png';
	routes['/ws/pse1/three'].name = 'SHOT.PNG';
	const w = world(routes);
	try {
		await importCards(w.s, w.entities);
		await w.run();
		assert.deepEqual(filesOf(w.s, 'PSE-1').map((n) => n.toLowerCase()).sort(), ['shot-2.png', 'shot-3.png', 'shot.png']);
		const contents = filesOf(w.s, 'PSE-1').map((n) => readFileSync(join(w.s.filesDir, 'PSE-1', n), 'utf8')).sort();
		assert.deepEqual(contents, ['ONE-BYTES', 'THREE-BYTES', 'TWO'], 'no file overwrote another');
		const again = await w.run();
		assert.equal(again.counts.got.downloaded, 0);
	} finally {
		w.s.cleanup();
	}
});

test('a name with an address in it is redacted in the file name and the entry; the original stays in the local raw folder', async () => {
	const routes = ROUTES();
	routes['/ws/pse1/one'].name = 'from jane@outside.example.invalid.png';
	const w = world(routes);
	try {
		await importCards(w.s, w.entities);
		const r = await w.run();
		assert.equal(r.counts.got.namesFlagged, 1);
		const entry = card(w.s, 'PSE-1').fields.files.find((f) => f.upload === uploadId(L.one));
		assert.equal(entry.name, 'from [email].png');
		assert.equal(entry.path, 'files/PSE-1/from [email].png');
		assert.match(readFileSync(join(w.s.rawDir, 'uploads', `${uploadId(L.one)}.json`), 'utf8'), /jane@outside\.example\.invalid/);
		for (const path of Object.keys(snapshot(w.s.dir))) {
			if (path.startsWith(w.s.rawDir)) continue;
			assert.equal(path.includes('jane@outside'), false, 'no file name has the address');
			if (path.endsWith('.md')) assert.equal(readFileSync(path, 'utf8').includes('jane@outside'), false, path);
		}
	} finally {
		w.s.cleanup();
	}
});

test('a known size over the cap stops the run before anything is written, and says which', async () => {
	const w = world();
	try {
		await importCards(w.s, w.entities);
		const big = await w.run({ maxFileBytes: 8 });
		assert.equal(big.stopped.reason, 'file-cap');
		assert.equal(big.stopped.count, 2, 'the 9-byte and the 11-byte upload');
		assert.equal(existsSync(w.s.filesDir), false);
		const total = await w.run({ maxTotalBytes: 20 });
		assert.equal(total.stopped.reason, 'total-cap');
		assert.equal(existsSync(w.s.filesDir), false);
		assert.equal(w.host.calls.some((c) => c.method === 'GET'), false);
		const ok = await w.run({ maxFileBytes: 11, maxTotalBytes: 27 });
		assert.equal(ok.stopped, null, 'at the cap is fine');
	} finally {
		w.s.cleanup();
	}
});

test('a body that grows past the cap stops the run, leaves no partial file and no entry for it', async () => {
	const routes = { '/ws/pse1/one': { body: 'x'.repeat(50), type: 'image/png', name: 'big.png', noLength: true } };
	const e = buildExport();
	e.issues[0].description = `![](${L.one})`;
	const w = world(routes, e);
	try {
		await importCards(w.s, e);
		const r = await w.run({ maxFileBytes: 20 });
		assert.equal(r.stopped.reason, 'file-cap');
		assert.equal(r.stopped.card, 'PSE-1');
		assert.equal(existsSync(join(w.s.filesDir, 'PSE-1')), false, 'no folder, no file');
		assert.deepEqual(readdirSync(join(w.s.rawDir, 'files', '.tmp')), [], 'and no temp file left');
		assert.equal(card(w.s, 'PSE-1').fields.files, undefined);
	} finally {
		w.s.cleanup();
	}
});

test('ten failures in a row stop the run', async () => {
	const routes = {};
	const e = buildExport();
	const links = Array.from({ length: 12 }, (_, i) => link(`many/${i}`));
	for (const l of links) routes[new URL(l).pathname] = { status: 500 };
	e.issues[0].description = links.map((l) => `![](${l})`).join(' ');
	const w = world(routes, e);
	try {
		await importCards(w.s, e);
		const r = await w.run();
		assert.equal(r.stopped.reason, 'many-failures');
		assert.equal(r.counts.got.failed, 10);
	} finally {
		w.s.cleanup();
	}
});

test('a file left by a killed run is adopted when name and bytes agree; a different file of that name is not touched', async () => {
	const w = world();
	try {
		await importCards(w.s, w.entities);
		mkdirSync(join(w.s.filesDir, 'PSE-1'), { recursive: true });
		writeFileSync(join(w.s.filesDir, 'PSE-1', 'shot-one.png'), 'ONE-BYTES');
		writeFileSync(join(w.s.filesDir, 'PSE-1', 'report.pdf'), 'TWX');
		const inode = statSync(join(w.s.filesDir, 'PSE-1', 'shot-one.png')).ino;
		const r = await w.run();
		assert.equal(statSync(join(w.s.filesDir, 'PSE-1', 'shot-one.png')).ino, inode, 'the adopted file itself stays; the new copy is thrown away');
		assert.equal(r.counts.got.adopted, 1);
		assert.equal(r.counts.got.downloaded, 3);
		assert.deepEqual(filesOf(w.s, 'PSE-1'), ['photo.jpg', 'report-2.pdf', 'report.pdf', 'shot-one.png']);
		assert.equal(readFileSync(join(w.s.filesDir, 'PSE-1', 'report.pdf'), 'utf8'), 'TWX', 'same size, other bytes: not the same upload');
		assert.equal(readFileSync(join(w.s.filesDir, 'PSE-1', 'report-2.pdf'), 'utf8'), 'TWO');
		assert.equal(card(w.s, 'PSE-1').fields.files.length, 3);
	} finally {
		w.s.cleanup();
	}
});

test('an old temp file of a killed run is removed, a fresh one is left; downloads never touch a temp file in the synced folder', async () => {
	const w = world();
	try {
		await importCards(w.s, w.entities);
		const tempDir = join(w.s.rawDir, 'files', '.tmp');
		mkdirSync(tempDir, { recursive: true });
		const stale = join(tempDir, '.up-1-aaaa.tmp');
		const fresh = join(tempDir, '.up-2-bbbb.tmp');
		writeFileSync(stale, 'x');
		writeFileSync(fresh, 'y');
		const old = new Date(Date.now() - 3600_000);
		utimesSync(stale, old, old);
		await w.run();
		assert.equal(existsSync(stale), false);
		assert.equal(existsSync(fresh), true);
		for (const card of readdirSync(w.s.filesDir)) assert.equal(readdirSync(join(w.s.filesDir, card)).some((n) => n.startsWith('.up-')), false, 'nothing temporary in the synced folder');
	} finally {
		w.s.cleanup();
	}
});

test('a text file with an outside address or a phone number stays local-only, listed in the card; other files go to Drive', async () => {
	const routes = ROUTES();
	routes['/ws/pse1/two'] = { body: 'name,email\nOne,one@outside.example.invalid\n', type: 'text/csv', name: 'signups.csv' };
	routes['/ws/pse1/three'] = { body: 'just notes, no one to call', type: 'text/plain', name: 'notes.txt' };
	const w = world(routes);
	try {
		await importCards(w.s, w.entities);
		const r = await w.run();
		assert.equal(r.counts.got.keptLocal, 1);
		assert.deepEqual(filesOf(w.s, 'PSE-1'), ['notes.txt', 'shot-one.png'], 'the csv is not in the synced folder');
		assert.equal(readFileSync(join(w.s.rawDir, 'files', 'PSE-1', 'signups.csv'), 'utf8').includes('outside.example'), true, 'it is kept, local only');
		const entry = card(w.s, 'PSE-1').fields.files.find((f) => f.upload === uploadId(L.two));
		assert.equal(entry.path, 'raw/files/PSE-1/signups.csv');
		assert.equal(entry.local, true);
		assert.equal(card(w.s, 'PSE-1').fields.files.filter((f) => f.local).length, 1);
		for (const path of Object.keys(snapshot(w.s.filesDir))) assert.equal(readFileSync(path).includes('outside.example'), false, 'no address in any synced file');
		assert.deepEqual(thread(w.s, 'PSE-1').find((e) => e.id === 'cm-1').extra, { files: ['files/PSE-1/notes.txt', 'files/PSE-1/shot-one.png'] }, 'the comment that used the csv is not linked to it: the csv sits in the description');
		const before = snapshot(w.s.dir);
		const calls = w.host.calls.length;
		const again = await w.run();
		assert.equal(w.host.calls.length, calls, 'the local file counts as present: no request');
		assert.deepEqual(snapshot(w.s.dir), before);
		assert.equal(again.counts.checks.filesBroken, 0);
	} finally {
		w.s.cleanup();
	}
});

test('a phone-shaped number in a text file keeps it local; a text too big to look at is treated the same; a picture is never looked at', async () => {
	const routes = ROUTES();
	routes['/ws/pse1/two'] = { body: 'call 555-010-0199 tomorrow', type: 'text/plain', name: 'call.txt' }; // 26 bytes: under the scan limit, flagged for the number
	routes['/ws/pse1/three'] = { body: 'plain words only, but quite long for the limit', type: 'application/json', name: 'data.json' };
	routes['/ws/pse1/one'] = { body: 'one@outside.example.invalid in a picture', type: 'image/png', name: 'shot.png' };
	const w = world(routes);
	try {
		await importCards(w.s, w.entities);
		const r = await w.run({ maxScanBytes: 40 });
		assert.equal(r.counts.got.keptLocal, 2);
		assert.deepEqual(filesOf(w.s, 'PSE-1'), ['shot.png']);
		assert.deepEqual(readdirSync(join(w.s.rawDir, 'files', 'PSE-1')).sort(), ['call.txt', 'data.json']);
	} finally {
		w.s.cleanup();
	}
});

test('a file deleted by hand, or cut short, is fetched again on the next run, into the same name', async () => {
	const w = world();
	try {
		await importCards(w.s, w.entities);
		await w.run();
		rmSync(join(w.s.filesDir, 'PSE-1', 'report.pdf'));
		writeFileSync(join(w.s.filesDir, 'PSE-1', 'shot-one.png'), 'ONE');
		const r = await w.run();
		assert.equal(r.counts.uploads.present, 2);
		assert.equal(r.counts.got.downloaded, 2);
		assert.deepEqual(filesOf(w.s, 'PSE-1'), ['photo.jpg', 'report.pdf', 'shot-one.png'], 'no numbered copy beside the short one');
		assert.equal(readFileSync(join(w.s.filesDir, 'PSE-1', 'shot-one.png'), 'utf8'), 'ONE-BYTES');
		assert.equal(card(w.s, 'PSE-1').fields.files.length, 3);
		assert.equal(r.counts.checks.filesBroken, 0);
	} finally {
		w.s.cleanup();
	}
});

test('a key with no card on the board is counted and its links are not placed; a card whose files field is not a list is left alone', async () => {
	const e = exportWithUploads();
	e.issues.push({ id: 'i-9', key: 'XYZ-9', teamKey: 'PSE', number: 9, title: 'Not imported', description: `![](${link('other/nine')})`, createdAt: '2025-01-22T10:00:00.000Z', stateId: 's-1', labelIds: [], previousKeys: [] });
	const w = world({ ...ROUTES(), '/ws/other/nine': { body: 'NINE', type: 'image/png', name: 'nine.png' } }, e);
	try {
		await importCards(w.s, exportWithUploads()); // XYZ-9 is not imported
		const path = join(w.s.dir, 'issues', 'PSE', 'PSE-2.md');
		const text = readFileSync(path, 'utf8').replace('\n---\n', '\nfiles: "edited by hand"\n---\n');
		writeFileSync(path, text);
		const r = await w.run();
		assert.equal(r.counts.cards.missing, 1);
		assert.equal(r.counts.uploads.notPlaced, 1);
		assert.equal(r.counts.cards.damaged, 1);
		assert.equal(readFileSync(path, 'utf8'), text, 'the hand-edited card is byte for byte as it was');
		assert.equal(existsSync(join(w.s.filesDir, 'PSE-2')), false);
		assert.deepEqual(filesOf(w.s, 'PSE-1'), ['photo.jpg', 'report.pdf', 'shot-one.png']);
	} finally {
		w.s.cleanup();
	}
});

test('a card with comments but no thread file still gets its files; the missing thread is counted', async () => {
	const w = world();
	try {
		await importCards(w.s, w.entities);
		rmSync(join(w.s.dir, 'issues', 'PSE', 'PSE-1.thread.md'));
		const r = await w.run();
		assert.equal(r.counts.threads.missing, 1);
		assert.equal(r.counts.got.downloaded, 4);
		assert.equal(existsSync(join(w.s.dir, 'issues', 'PSE', 'PSE-1.thread.md')), false, 'no thread is invented');
	} finally {
		w.s.cleanup();
	}
});

test('a real run needs the client, the raw folder and the guard; a guard that refuses writes nothing', async () => {
	const w = world();
	try {
		await importCards(w.s, w.entities);
		const found = findUploads(w.entities);
		await assert.rejects(() => applyUploads(found, w.s.store(), { client: w.client, boardDir: w.s.dir }), (err) => err instanceof BoardError && err.code === 'no-guard');
		await assert.rejects(() => applyUploads(found, w.s.store(), { client: null, boardDir: w.s.dir, rawDir: w.s.rawDir, guard: async () => ({}) }), (err) => err instanceof BoardError && err.code === 'no-guard');
		await assert.rejects(() => w.run({ guard: async () => { throw new Error('the filter would sync the raw folder'); } }), /would sync/);
		assert.equal(existsSync(w.s.filesDir), false);
	} finally {
		w.s.cleanup();
	}
});

test('a raw folder that is not the board raw folder is refused: a held-back file could not be found by its path', async () => {
	const w = world();
	try {
		await importCards(w.s, w.entities);
		await assert.rejects(() => applyUploads(findUploads(w.entities), w.s.store(), { client: w.client, boardDir: w.s.dir, rawDir: join(w.s.root, 'elsewhere'), guard: async () => ({}) }), (err) => err instanceof BoardError && err.code === 'bad-raw');
		assert.equal(existsSync(w.s.filesDir), false);
	} finally {
		w.s.cleanup();
	}
});

test('the summary has counts, issue keys, upload ids and statuses, and no name, link or key', async () => {
	const routes = ROUTES();
	routes['/ws/pse1/two'] = { status: 404 };
	const w = world(routes);
	try {
		await importCards(w.s, w.entities);
		const dry = await w.run({ dry: true });
		const real = await w.run();
		const text = formatUploadsSummary(real.found, real, { dryRun: false, filesSync: 'synced (reaches Drive)', headDone: true });
		const dryText = formatUploadsSummary(dry.found, dry, { dryRun: true, filesSync: 'synced (reaches Drive)', headDone: true });
		assert.match(dryText, /DRY RUN, nothing written/);
		assert.match(text, /downloaded 3 /);
		assert.match(text, new RegExp(`PSE-1 +${uploadId(L.two)} gone 404`));
		for (const out of [text, dryText]) {
			for (const secret of ['shot-one', 'report.pdf', 'photo.jpg', 'moved.png', 'uploads.linear.app', KEY, 'ws/pse1', 'ONE-BYTES']) assert.equal(out.includes(secret), false, `"${secret}" is not printed`);
		}
	} finally {
		w.s.cleanup();
	}
});

test('failures that come with successes in between do not add up to a stop', async () => {
	const routes = {};
	const e = buildExport();
	const links = Array.from({ length: 24 }, (_, i) => link(`mix/${i}`));
	links.forEach((l, i) => {
		routes[new URL(l).pathname] = i % 2 === 0 ? { status: 500 } : { body: `B${i}`, type: 'image/png', name: `f${i}.png` };
	});
	e.issues[0].description = links.map((l) => `![](${l})`).join(' ');
	const w = world(routes, e);
	try {
		await importCards(w.s, e);
		const r = await w.run();
		assert.equal(r.stopped, null);
		assert.equal(r.counts.got.downloaded, 12);
		assert.equal(r.counts.got.failed, 12, 'a 500 on the size request is still tried with GET, which fails the same way');
		assert.equal(r.counts.head.failed, 12);
	} finally {
		w.s.cleanup();
	}
});

test('an entry whose path leaves the folder is not trusted: the upload is fetched again and the entry replaced', async () => {
	const w = world();
	try {
		await importCards(w.s, w.entities);
		writeFileSync(join(w.s.root, 'outside.txt'), 'ONE-BYTES');
		const path = join(w.s.dir, 'issues', 'PSE', 'PSE-1.md');
		const bad = { upload: uploadId(L.one), path: 'files/../../../outside.txt', name: 'x', bytes: 9, sha256: sha('ONE-BYTES') };
		writeFileSync(path, readFileSync(path, 'utf8').replace('\n---\n', `\nfiles: ${JSON.stringify([bad])}\n---\n`));
		const r = await w.run();
		assert.equal(r.counts.uploads.present, 0, 'a file that happens to have the size is not the upload');
		assert.equal(r.counts.got.downloaded, 4);
		const entry = card(w.s, 'PSE-1').fields.files.find((f) => f.upload === uploadId(L.one));
		assert.equal(entry.path, 'files/PSE-1/shot-one.png');
		assert.equal(card(w.s, 'PSE-1').fields.files.length, 3, 'the bad entry is replaced, not kept beside the good one');
		assert.equal(readFileSync(join(w.s.root, 'outside.txt'), 'utf8'), 'ONE-BYTES');
	} finally {
		w.s.cleanup();
	}
});

test('a card write that is refused is counted and leaves the file for the next run to adopt; one retry covers a card changed meanwhile', async () => {
	const w = world();
	try {
		await importCards(w.s, w.entities);
		let refuse = 0;
		class Flaky extends BoardStore {
			async writeIssue(...args) {
				if (refuse > 0) {
					refuse--;
					throw new BoardError('changed', 'changed since it was read');
				}
				return super.writeIssue(...args);
			}
		}
		const flaky = () => new Flaky({ dir: w.s.dir, lockDir: join(w.s.root, 'team', '.logs', 'board') });
		const found = findUploads(w.entities);
		const opts = { client: w.client, boardDir: w.s.dir, rawDir: w.s.rawDir, guard: async () => ({}) };
		refuse = 1;
		const once = await applyUploads(found, flaky(), opts);
		assert.equal(once.counts.cards.failed, 0, 'the second try went through');
		assert.equal(once.counts.got.downloaded, 4);
		assert.equal(card(w.s, 'PSE-1').fields.files.length, 3);
		// every write refused: files are on disk, no entry, every upload counted and named
		rmSync(w.s.filesDir, { recursive: true });
		const text = readFileSync(join(w.s.dir, 'issues', 'PSE', 'PSE-1.md'), 'utf8');
		writeFileSync(join(w.s.dir, 'issues', 'PSE', 'PSE-1.md'), text.split('\n').filter((l) => !l.startsWith('files: ')).join('\n'));
		writeFileSync(join(w.s.dir, 'issues', 'PSE', 'PSE-2.md'), readFileSync(join(w.s.dir, 'issues', 'PSE', 'PSE-2.md'), 'utf8').split('\n').filter((l) => !l.startsWith('files: ')).join('\n'));
		refuse = Infinity;
		const never = await applyUploads(found, flaky(), opts);
		assert.equal(never.counts.cards.failed, 4);
		assert.deepEqual(never.failures.map((f) => f.result), ['card-changed', 'card-changed', 'card-changed', 'card-changed']);
		assert.equal(never.counts.got.downloaded, 4, 'the files are there');
		assert.deepEqual(filesOf(w.s, 'PSE-1'), ['photo.jpg', 'report.pdf', 'shot-one.png']);
		assert.equal(card(w.s, 'PSE-1').fields.files, undefined);
		refuse = 0;
		const next = await applyUploads(found, w.s.store(), opts);
		assert.equal(next.counts.got.adopted, 4, 'the next run takes the files it left');
		assert.equal(next.counts.got.downloaded, 0);
		assert.deepEqual(filesOf(w.s, 'PSE-1'), ['photo.jpg', 'report.pdf', 'shot-one.png'], 'no numbered copies');
		assert.equal(card(w.s, 'PSE-1').fields.files.length, 3);
	} finally {
		w.s.cleanup();
	}
});
