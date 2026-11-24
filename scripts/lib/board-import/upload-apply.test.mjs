import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardError, BoardStore, parseDocument, parseThread } from '../board/index.mjs';
import { applyIssues, applyUploads, createUploadClient, findUploads, formatUploadsSummary, loadExisting, planIssues, planLinks, planReference, withLinks } from './index.mjs';
import { fakeUploadHost } from './fake-uploads.mjs';
import { MEMBERS, buildExport } from './fixture.mjs';
import { UPLOAD_HOST, uploadId } from './uploads.mjs';
import { publishFile } from './upload-apply.mjs';

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

test('ten failures in a row stop the run, in the size pass and in the download pass', async () => {
	const e = buildExport();
	const links = Array.from({ length: 12 }, (_, i) => link(`many/${i}`));
	e.issues[0].description = links.map((l) => `![](${l})`).join(' ');
	const broken = {};
	for (const l of links) broken[new URL(l).pathname] = { status: 500 };
	const w = world(broken, e);
	try {
		await importCards(w.s, e);
		const r = await w.run();
		assert.equal(r.stopped.reason, 'many-failures');
		assert.equal(r.counts.head.failed, 10, 'the size pass stops at ten, it does not wait out two more dead links');
		assert.equal(r.counts.got.failed, 0);
		assert.equal(existsSync(w.s.filesDir), false);
	} finally {
		w.s.cleanup();
	}
	const getOnly = {};
	for (const l of links) getOnly[new URL(l).pathname] = (call) => (call.method === 'HEAD' ? { body: 'x', type: 'image/png' } : { status: 500 });
	const v = world(getOnly, e);
	try {
		await importCards(v.s, e);
		const r = await v.run();
		assert.equal(r.stopped.reason, 'many-failures');
		assert.equal(r.counts.head.ok, 12);
		assert.equal(r.counts.got.failed, 10);
	} finally {
		v.s.cleanup();
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
		assert.equal(r.counts.got.bytes, 3 + 11 + 4, 'the adopted file was not written, so its bytes are not counted');
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

test('a file deleted by hand is fetched again; a file somebody edited is never overwritten: the new copy is numbered and the entry follows it', async () => {
	const w = world();
	try {
		await importCards(w.s, w.entities);
		await w.run();
		rmSync(join(w.s.filesDir, 'PSE-1', 'report.pdf'));
		writeFileSync(join(w.s.filesDir, 'PSE-1', 'shot-one.png'), 'ONE annotated by hand');
		const r = await w.run();
		assert.equal(r.counts.uploads.present, 2);
		assert.equal(r.counts.got.downloaded, 2);
		assert.deepEqual(filesOf(w.s, 'PSE-1'), ['photo.jpg', 'report.pdf', 'shot-one-2.png', 'shot-one.png']);
		assert.equal(readFileSync(join(w.s.filesDir, 'PSE-1', 'shot-one.png'), 'utf8'), 'ONE annotated by hand', 'the edited file is as it was');
		assert.equal(readFileSync(join(w.s.filesDir, 'PSE-1', 'shot-one-2.png'), 'utf8'), 'ONE-BYTES');
		const entry = card(w.s, 'PSE-1').fields.files.find((f) => f.upload === uploadId(L.one));
		assert.equal(entry.path, 'files/PSE-1/shot-one-2.png');
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

test('an address that ends the name is redacted too: the file name, the entry and the thread line hold none of it', async () => {
	const routes = ROUTES();
	routes['/ws/pse1/one'].name = 'jane.roe@outside.example.org';
	const w = world(routes);
	try {
		await importCards(w.s, w.entities);
		const r = await w.run();
		assert.equal(r.counts.got.namesFlagged, 1);
		const entry = card(w.s, 'PSE-1').fields.files.find((f) => f.upload === uploadId(L.one));
		assert.equal(entry.name, '[email]');
		assert.equal(entry.path, 'files/PSE-1/[email].png');
		assert.match(readFileSync(join(w.s.rawDir, 'uploads', `${uploadId(L.one)}.json`), 'utf8'), /jane\.roe@outside\.example\.org/);
		for (const path of Object.keys(snapshot(w.s.dir))) {
			if (path.startsWith(w.s.rawDir)) continue;
			assert.equal(path.includes('jane.roe'), false, 'no file name has the address');
			if (path.endsWith('.md')) assert.equal(readFileSync(path, 'utf8').includes('jane.roe'), false, path);
		}
	} finally {
		w.s.cleanup();
	}
});

test('text in another encoding or another type is still looked at: UTF-16 text and an octet-stream contacts file stay local; a picture is not read', async () => {
	const bom = String.fromCharCode(0xfeff);
	const routes = ROUTES();
	routes['/ws/pse1/one'] = { body: Buffer.from(`${bom}name,email\r\nOne,one@outside.example.org\r\n`, 'utf16le'), type: 'application/octet-stream', name: 'export.csv' };
	routes['/ws/pse1/two'] = { body: 'BEGIN:VCARD\nEMAIL:two@outside.example.org\nEND:VCARD\n', type: 'application/octet-stream', name: 'contacts.vcf' };
	routes['/ws/pse1/three'] = { body: 'three@outside.example.org inside a picture', type: 'image/png', name: 'picture.bin' }; // the type says picture, the extension says nothing
	const w = world(routes);
	try {
		await importCards(w.s, w.entities);
		const r = await w.run();
		assert.equal(r.counts.got.keptLocal, 2);
		assert.equal(r.counts.got.unscanned, 2, 'the picture and the moved.png are counted as not scanned');
		assert.deepEqual(readdirSync(join(w.s.rawDir, 'files', 'PSE-1')).sort(), ['contacts.vcf', 'export.csv']);
		assert.deepEqual(filesOf(w.s, 'PSE-1'), ['picture.bin']);
	} finally {
		w.s.cleanup();
	}
});

test('the total cap holds for files whose size is not known beforehand', async () => {
	const e = buildExport();
	const three = [link('nosize/a'), link('nosize/b'), link('nosize/c')];
	e.issues[0].description = three.map((l) => `![](${l})`).join(' ');
	const routes = {};
	for (const l of three) routes[new URL(l).pathname] = { body: 'x'.repeat(4000), type: 'image/png', noLength: true };
	const w = world(routes, e);
	try {
		await importCards(w.s, e);
		const r = await w.run({ maxTotalBytes: 5000 });
		assert.equal(r.stopped.reason, 'total-cap');
		assert.equal(r.counts.got.downloaded, 1, 'the second would have gone past 5000');
		assert.deepEqual(readdirSync(join(w.s.rawDir, 'files', '.tmp')), []);
	} finally {
		w.s.cleanup();
	}
});

test('a link used on two cards is downloaded twice, so it counts twice against the total cap', async () => {
	const e = buildExport();
	e.issues[0].description = `![](${L.one})`;
	e.issues[2].description = `![](${L.one})`;
	e.comments = [];
	const w = world(ROUTES(), e);
	try {
		await importCards(w.s, e);
		const r = await w.run({ maxTotalBytes: 15 });
		assert.equal(r.stopped.reason, 'total-cap');
		assert.equal(r.stopped.bytes, 18);
		assert.equal(existsSync(w.s.filesDir), false);
		const ok = await w.run({ maxTotalBytes: 18 });
		assert.equal(ok.stopped, null);
		assert.equal(ok.counts.got.downloaded, 2);
		assert.equal(ok.counts.threads.missing, 0, 'cards with no comment links do not miss a thread');
	} finally {
		w.s.cleanup();
	}
});

test('a very long name with many-byte characters is cut to a size the file system takes; the run goes on', async () => {
	const routes = ROUTES();
	// a header value is Latin-1 on the wire, so the host sends many-byte names in the extended form
	routes['/ws/pse1/one'].disposition = `inline; filename*=UTF-8''${encodeURIComponent(`${String.fromCodePoint(0x1f600).repeat(79)}.png`)}`;
	const w = world(routes);
	try {
		await importCards(w.s, w.entities);
		const r = await w.run();
		assert.equal(r.stopped, null);
		assert.equal(r.counts.got.downloaded, 4);
		for (const name of filesOf(w.s, 'PSE-1')) assert.ok(Buffer.byteLength(name) <= 200, `${Buffer.byteLength(name)} bytes`);
		assert.equal(r.counts.checks.filesBroken, 0);
	} finally {
		w.s.cleanup();
	}
});

test('a file that appears in the card folder while a download runs is never replaced: the new file takes the next free name', async () => {
	const routes = ROUTES();
	const w = world(routes);
	try {
		await importCards(w.s, w.entities);
		// Each download, when it is asked for, also puts a file of the name it will be saved under into the card folder (a hand
		// edit, or a sync from another machine); the folder was listed once at the first download, so the later ones are a race.
		const names = { '/ws/pse1/one': 'shot-one.png', '/ws/pse1/two': 'report.pdf', '/ws/pse1/three': 'photo.jpg' };
		for (const [path, name] of Object.entries(names)) {
			const route = routes[path];
			routes[path] = (call) => {
				if (call.method === 'GET') {
					mkdirSync(join(w.s.filesDir, 'PSE-1'), { recursive: true });
					writeFileSync(join(w.s.filesDir, 'PSE-1', name), `HAND-${name}`);
				}
				return route;
			};
		}
		const r = await w.run();
		assert.equal(r.counts.got.downloaded, 4);
		for (const name of Object.values(names)) assert.equal(readFileSync(join(w.s.filesDir, 'PSE-1', name), 'utf8'), `HAND-${name}`, `${name} is still the hand-made file`);
		const downloaded = filesOf(w.s, 'PSE-1').filter((n) => !readFileSync(join(w.s.filesDir, 'PSE-1', n), 'utf8').startsWith('HAND-'));
		assert.equal(downloaded.length, 3, 'all three downloads are in the folder under other names');
		const contents = downloaded.map((n) => readFileSync(join(w.s.filesDir, 'PSE-1', n), 'utf8')).sort();
		assert.deepEqual(contents, ['ONE-BYTES', 'THREE-BYTES', 'TWO']);
		const listed = card(w.s, 'PSE-1').fields.files.map((e) => e.path.split('/').pop()).sort();
		assert.deepEqual(listed, downloaded, 'the card lists the names the files really have');
		assert.deepEqual(readdirSync(join(w.s.rawDir, 'files', '.tmp')), [], 'no temp name is left');
	} finally {
		w.s.cleanup();
	}
});

test('publishFile: links into place, numbers a name that is taken, and without hard links copies exclusively, never replacing (CodeRabbit on #23, round 5)', async () => {
	const root = mkdtempSync(join(tmpdir(), 'board-publish-'));
	try {
		const dir = join(root, 'dir');
		mkdirSync(dir);
		const make = (name, text) => {
			const p = join(root, name);
			writeFileSync(p, text);
			return p;
		};
		// a free name, then a name taken by a file the cache does not know about
		assert.equal(await publishFile(make('t1', 'one'), dir, 'a.png', new Set()), 'a.png');
		const taken = new Set();
		assert.equal(await publishFile(make('t2', 'two'), dir, 'a.png', taken), 'a-2.png');
		assert.deepEqual([...taken].sort(), ['a.png']);
		assert.equal(readFileSync(join(dir, 'a.png'), 'utf8'), 'one');
		assert.equal(readFileSync(join(dir, 'a-2.png'), 'utf8'), 'two');
		assert.equal(existsSync(join(root, 't2')), false, 'the temp name is gone');
		// a different error is not swallowed
		await assert.rejects(publishFile(make('t3', 'x'), join(root, 'no-such-dir'), 'b.png', new Set()), (e) => e.code === 'ENOENT');
		// no hard links: a name that is there is still not replaced, a free one is copied into place and the temp name removed
		const fsp = await import('node:fs/promises');
		const noLink = async () => {
			throw Object.assign(new Error('no links here'), { code: 'EPERM' });
		};
		const ops = { link: noLink, copyFile: fsp.copyFile, unlink: fsp.unlink };
		assert.equal(await publishFile(make('t4', 'four'), dir, 'a.png', new Set(), ops), 'a-3.png');
		const t5 = make('t5', 'five');
		assert.equal(await publishFile(t5, dir, 'c.png', new Set(), ops), 'c.png');
		assert.equal(existsSync(t5), false, 'the temp name is gone after a copy too');
		assert.equal(readFileSync(join(dir, 'a.png'), 'utf8'), 'one');
		assert.equal(readFileSync(join(dir, 'c.png'), 'utf8'), 'five');
		// whatever a mount answers instead of a link (Windows volumes say EISDIR, some mounts EINVAL or EACCES), the same fallback
		for (const [i, code] of ['EISDIR', 'EINVAL', 'EACCES', 'ENOSYS', 'EXDEV'].entries()) {
			const failing = { ...ops, link: async () => { throw Object.assign(new Error('refused'), { code }); } };
			assert.equal(await publishFile(make(`u${i}`, `bytes ${code}`), dir, `d${i}.png`, new Set(), failing), `d${i}.png`, code);
			assert.equal(readFileSync(join(dir, `d${i}.png`), 'utf8'), `bytes ${code}`);
		}
		// the window the old fallback had (look, then rename): a file created by somebody else at the very moment of the copy.
		// The exclusive copy fails with EEXIST, the name counts as taken, and the other file is untouched.
		let raced = false;
		const racing = {
			...ops,
			copyFile: async (from, to, mode) => {
				if (!raced) {
					raced = true; // once: the next name is free
					writeFileSync(to, 'made by someone else, just now');
				}
				return fsp.copyFile(from, to, mode);
			},
		};
		const t7 = make('t7', 'seven');
		const racedTaken = new Set();
		assert.equal(await publishFile(t7, dir, 'race.png', racedTaken, racing), 'race-2.png');
		assert.equal(readFileSync(join(dir, 'race.png'), 'utf8'), 'made by someone else, just now', 'the file that appeared meanwhile is intact');
		assert.equal(readFileSync(join(dir, 'race-2.png'), 'utf8'), 'seven');
		assert.deepEqual([...racedTaken], ['race.png']);
		// a copy that fails for another reason publishes nothing and keeps the temp file (it is not a free name)
		const broken = { ...ops, copyFile: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } };
		const t6 = make('t6', 'six');
		await assert.rejects(publishFile(t6, dir, 'e.png', new Set(), broken), (e) => e.code === 'ENOSPC');
		assert.equal(existsSync(join(dir, 'e.png')), false);
		assert.equal(readFileSync(t6, 'utf8'), 'six', 'the temp file is still there for the stale sweep');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('the temp folder inside raw/files that is a link is refused: no download is written where it points', async () => {
	const w = world();
	try {
		await importCards(w.s, w.entities);
		const outside = join(w.s.root, 'outside');
		mkdirSync(outside);
		mkdirSync(join(w.s.rawDir, 'files'), { recursive: true });
		symlinkSync(outside, join(w.s.rawDir, 'files', '.tmp'));
		await assert.rejects(() => w.run(), (err) => err instanceof BoardError && err.code === 'bad-folder');
		assert.deepEqual(readdirSync(outside), []);
		assert.equal(existsSync(w.s.filesDir) ? readdirSync(w.s.filesDir).length : 0, 0, 'nothing was saved');
	} finally {
		w.s.cleanup();
	}
});

test('a card folder that is a link is refused: nothing is written where it points', async () => {
	const w = world();
	try {
		await importCards(w.s, w.entities);
		const outside = join(w.s.root, 'outside');
		mkdirSync(outside);
		mkdirSync(w.s.filesDir, { recursive: true });
		symlinkSync(outside, join(w.s.filesDir, 'PSE-1'));
		await assert.rejects(() => w.run(), (err) => err instanceof BoardError && err.code === 'bad-folder');
		assert.deepEqual(readdirSync(outside), []);
		const real = join(w.s.root, 'elsewhere');
		mkdirSync(real);
		rmSync(w.s.filesDir, { recursive: true });
		symlinkSync(real, w.s.filesDir);
		await assert.rejects(() => w.run(), (err) => err instanceof BoardError && err.code === 'bad-folder');
		assert.deepEqual(readdirSync(real), []);
	} finally {
		w.s.cleanup();
	}
});

test('a second run asks only about the uploads that are gone, one size request each, and downloads nothing', async () => {
	const routes = ROUTES();
	routes['/ws/pse1/two'] = { status: 404 };
	const w = world(routes);
	try {
		await importCards(w.s, w.entities);
		await w.run();
		const before = w.host.calls.length;
		const again = await w.run();
		const asked = w.host.calls.slice(before);
		assert.deepEqual(asked.map((c) => c.method), ['HEAD']);
		assert.equal(again.counts.got.downloaded, 0);
		assert.deepEqual(again.failures.map((f) => f.result), ['gone']);
	} finally {
		w.s.cleanup();
	}
});

test('a comment edited in Linear until it holds no upload link loses its file list', async () => {
	const w = world();
	try {
		await importCards(w.s, w.entities);
		await w.run();
		assert.equal(thread(w.s, 'PSE-1').find((e) => e.id === 'cm-1').extra.files.length, 2);
		w.entities.comments[0].body = 'Edited: no link any more.';
		await importCards(w.s, w.entities);
		assert.equal(thread(w.s, 'PSE-1').find((e) => e.id === 'cm-1').extra.files.length, 2, 'the issue importer carries what it was given');
		const r = await w.run();
		const entry = thread(w.s, 'PSE-1').find((e) => e.id === 'cm-1');
		assert.equal(entry.extra, undefined);
		assert.match(entry.body, /Edited/);
		assert.equal(r.counts.threads.written, 1);
		assert.equal(card(w.s, 'PSE-1').fields.files.length, 3, 'the files themselves stay: nothing is deleted');
	} finally {
		w.s.cleanup();
	}
});
