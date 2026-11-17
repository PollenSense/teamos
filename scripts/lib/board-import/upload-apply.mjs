import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { BoardError, scanText } from '../board/index.mjs';
import { writeRaw } from './apply.mjs';
import { cmpKeys } from './links.mjs';
import { UploadError } from './upload-client.mjs';
import { dispositionFileName, extensionForType, isFileEntry, isSafeRelativePath, needsTextScan, redactFileName, safeFileName, uniqueName } from './uploads.mjs';

/**
 * Downloads the uploads of the issues of an import (ticket A6b) into `<board>/files/<card id>/` and links them: the
 * card's front matter gets `files: [{ upload, path, name, bytes, sha256, type }]` and a comment's thread entry gets
 * `files: [path, ...]` in its meta line. `found` is what `findUploads` returned for the export; the cards are the
 * board's own (a key is opened through the store, so an earlier key finds the card that moved).
 *
 * Order of writes, so nothing is ever listed before it exists: the local-only raw record of a flagged name, then the
 * file (a temp file in the folder, renamed), then the card's entry, and after a card's files the thread entries.
 * A second run asks for nothing that is already there: an entry whose file exists with the same size is left alone.
 * A file a killed run left before its entry was written is adopted when the name and the SHA-256 agree.
 *
 * Nothing is deleted. A dry run (`store.dryRun`) only asks for sizes (HEAD) and writes nothing; with `client: null` it
 * does not ask at all and only counts.
 */

const MB = 1024 * 1024;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const STALE_TEMP_MS = 10 * 60 * 1000;
const FAILURES_IN_A_ROW = 10;
const SCAN_LIMIT = 5 * MB;

/**
 * True when the file holds an outside e-mail address or a phone-shaped number, or is too big to look at (then it is not
 * trusted). The bytes are read as UTF-8, as one byte per character and as UTF-16 (both byte orders: Excel's "Unicode text"
 * is UTF-16), so an address in any of them is found.
 */
async function holdsPersonData(path, bytes, maxScanBytes) {
	if (bytes > maxScanBytes) return true;
	const buffer = await readFile(path);
	const readings = [buffer.toString('utf8'), buffer.toString('latin1'), buffer.toString('utf16le'), buffer.subarray(1).toString('utf16le')];
	return readings.some((text) => scanText(text).flagged);
}

/** Refuses a folder that is a link or not a folder: a write through it would land somewhere else. */
async function assertPlainFolder(path) {
	const st = await lstat(path).catch((err) => {
		if (err.code === 'ENOENT') return null;
		throw err;
	});
	if (st !== null && (st.isSymbolicLink() || !st.isDirectory())) throw new BoardError('bad-folder', 'a folder the uploads go into is a link or not a folder');
}

async function sha256Of(path) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest('hex');
}

async function sizeOf(path) {
	try {
		return (await stat(path)).size;
	} catch (err) {
		if (err.code === 'ENOENT') return null;
		throw err;
	}
}

const entryList = (fields) => (Array.isArray(fields.files) ? fields.files : []);
const byPath = (a, b) => cmp(String(a?.path ?? ''), String(b?.path ?? '')) || cmp(String(a?.upload ?? ''), String(b?.upload ?? ''));

function emptyCounts() {
	return {
		uploads: { found: 0, notPlaced: 0, present: 0, toFetch: 0 },
		head: { ok: 0, gone: 0, denied: 0, failed: 0, bytesKnown: 0, sizeUnknown: 0, largest: 0 },
		cards: { withUploads: 0, missing: 0, damaged: 0, failed: 0, changed: 0 },
		got: { downloaded: 0, adopted: 0, gone: 0, denied: 0, failed: 0, bytes: 0, namesFlagged: 0, namesChanged: 0, keptLocal: 0, unscanned: 0 },
		threads: { read: 0, missing: 0, entriesLinked: 0, written: 0, failed: 0, commentsNotInThread: 0 },
		checks: { filesChecked: 0, filesBroken: 0 },
	};
}

/**
 * @param {{byKey: Map<string, Map<string, object>>}} found  from `findUploads`
 * @param {import('../board/index.mjs').BoardStore} store
 * @param {{client: ReturnType<import('./upload-client.mjs').createUploadClient> | null, boardDir: string, rawDir?: string,
 *          guard?: () => Promise<unknown>, maxFileBytes?: number, maxTotalBytes?: number}} options
 * @returns {Promise<{counts: object, failures: {card: string, upload: string, result: string, status?: number}[], stopped: object | null}>}
 */
export async function applyUploads(found, store, { client, boardDir, rawDir, guard, maxFileBytes = 100 * MB, maxTotalBytes = 1024 * MB, maxScanBytes = SCAN_LIMIT } = {}) {
	const dryRun = store.dryRun === true;
	const counts = emptyCounts();
	const failures = [];
	let stopped = null;
	if (!dryRun && (typeof guard !== 'function' || !rawDir || !client)) throw new BoardError('no-guard', 'a real run needs the client, the raw folder and the sync-filter check');

	// --- which card holds each upload (a key is opened through the store: an earlier key finds the card that moved) ---
	const cards = new Map(); // card id -> { id, uploads: Map(upload id -> upload) }
	for (const key of [...found.byKey.keys()].sort(cmpKeys)) {
		const uploads = found.byKey.get(key);
		counts.uploads.found += uploads.size;
		let card = null;
		try {
			card = await store.readIssue(key);
		} catch (err) {
			if (!(err instanceof BoardError) || err.code === 'locked') throw err;
			counts.cards.damaged++;
			continue;
		}
		if (!card) {
			counts.cards.missing++;
			counts.uploads.notPlaced += uploads.size;
			continue;
		}
		if (card.fields.files !== undefined && !Array.isArray(card.fields.files)) {
			counts.cards.damaged++; // `files` was edited into something that is not a list: not ours to overwrite
			continue;
		}
		if (!cards.has(card.id)) cards.set(card.id, { id: card.id, uploads: new Map() });
		const slot = cards.get(card.id);
		for (const [id, upload] of uploads) {
			const known = slot.uploads.get(id);
			if (!known) slot.uploads.set(id, { ...upload, labels: [...upload.labels], texts: [...upload.texts] });
			else {
				for (const l of upload.labels) if (!known.labels.includes(l)) known.labels.push(l);
				for (const t of upload.texts) if (!known.texts.some((x) => x.kind === t.kind && x.comment === t.comment)) known.texts.push(t);
			}
		}
	}
	counts.cards.withUploads = cards.size;
	const order = [...cards.keys()].sort(cmpKeys);

	// --- what is there already ---
	const todo = []; // { card, upload }
	const present = new Map(); // card id -> Map(upload id -> entry)
	for (const cardId of order) {
		const slot = cards.get(cardId);
		const card = await store.readIssue(cardId);
		const have = new Map();
		present.set(cardId, have);
		for (const id of [...slot.uploads.keys()].sort()) {
			const entry = entryList(card.fields).find((e) => isFileEntry(e) && e.upload === id && isSafeRelativePath(e.path));
			if (entry && (await sizeOf(join(boardDir, entry.path))) === entry.bytes) {
				have.set(id, entry);
				counts.uploads.present++;
			} else todo.push({ card: cardId, upload: slot.uploads.get(id) });
		}
	}
	counts.uploads.toFetch = todo.length;

	// --- sizes first (HEAD): the dry run stops here; a real run stops here too when a known size is over a cap ---
	const heads = new Map(); // upload id -> head answer
	let headFailures = 0;
	if (client) {
		for (const { card, upload } of todo) {
			if (heads.has(upload.id)) continue;
			let answer;
			try {
				answer = await client.head(upload.url);
			} catch (err) {
				if (err instanceof UploadError && err.fatal) {
					stopped = { reason: err.code, card, upload: upload.id };
					break;
				}
				if (err instanceof UploadError) answer = { result: 'failed', status: 0, bytes: null };
				else throw err;
			}
			heads.set(upload.id, answer);
			counts.head[answer.result]++;
			headFailures = answer.result === 'failed' ? headFailures + 1 : 0;
			if (headFailures >= FAILURES_IN_A_ROW) {
				stopped = { reason: 'many-failures', card, upload: upload.id };
				break;
			}
			if (answer.result === 'gone' || answer.result === 'denied') failures.push({ card, upload: upload.id, result: answer.result, status: answer.status });
			if (answer.result === 'ok') {
				if (answer.bytes === null) counts.head.sizeUnknown++;
				else {
					counts.head.bytesKnown += answer.bytes;
					counts.head.largest = Math.max(counts.head.largest, answer.bytes);
				}
			}
		}
		if (stopped === null) {
			const over = todo.filter(({ upload }) => (heads.get(upload.id)?.bytes ?? 0) > maxFileBytes);
			if (over.length > 0) stopped = { reason: 'file-cap', card: over[0].card, upload: over[0].upload.id, count: over.length, bytes: heads.get(over[0].upload.id).bytes };
			else {
				// A link used on two cards is downloaded twice, so it counts twice.
				const pairs = todo.reduce((sum, { upload }) => sum + (heads.get(upload.id)?.bytes ?? 0), 0);
				if (pairs > maxTotalBytes) stopped = { reason: 'total-cap', bytes: pairs };
			}
		}
	}
	if (dryRun || stopped !== null) return { counts, failures, stopped };

	// --- download and link, card by card ---
	await guard();
	if (join(boardDir, 'raw') !== rawDir) throw new BoardError('bad-raw', 'the raw folder is not <board>/raw: a held-back file could not be listed by its path');
	// A download lands in a local-only folder first (nothing under raw/ is synced), so a half-written file, or one that
	// must stay local, is never visible in Drive; it is renamed into its folder once it is whole and has been looked at.
	const tempDir = join(rawDir, 'files', '.tmp');
	let tempReady = false;
	const prepareTemp = async () => {
		if (tempReady) return;
		tempReady = true;
		await mkdir(tempDir, { recursive: true, mode: 0o700 });
		for (const name of await readdir(tempDir)) {
			const age = Date.now() - (await stat(join(tempDir, name)).then((st) => st.mtimeMs, () => Date.now()));
			if (name.startsWith('.up-') && name.endsWith('.tmp') && age > STALE_TEMP_MS) await unlink(join(tempDir, name)).catch(() => {});
		}
	};
	await assertPlainFolder(join(boardDir, 'files'));
	await assertPlainFolder(join(rawDir, 'files'));
	let inARow = 0;
	let fetched = 0; // bytes asked for in this run, adopted files too: what the total cap is about
	const linked = new Map(); // card id -> Map(upload id -> entry) of what the card lists now
	outer: for (const cardId of order) {
		const mine = todo.filter((t) => t.card === cardId).map((t) => t.upload).sort((a, b) => cmp(a.id, b.id));
		const have = new Map(present.get(cardId));
		linked.set(cardId, have);
		if (mine.length === 0) continue;
		const places = new Map(); // folder (relative to the board) -> { dir, rel, taken }
		const place = async (local) => {
			const rel = local ? `raw/files/${cardId}` : `files/${cardId}`;
			if (!places.has(rel)) {
				const dir = join(boardDir, rel);
				await assertPlainFolder(dir);
				await mkdir(dir, { recursive: true, ...(local ? { mode: 0o700 } : {}) });
				places.set(rel, { dir, rel, taken: new Set((await readdir(dir)).map((n) => n.toLowerCase())) });
			}
			return places.get(rel);
		};
		const listedEntries = entryList((await store.readIssue(cardId)).fields);
		const listed = new Set(listedEntries.map((e) => e?.path));
		for (const upload of mine) {
			const head = heads.get(upload.id);
			if (head && (head.result === 'gone' || head.result === 'denied')) {
				counts.got[head.result]++;
				continue;
			}
			await prepareTemp();
			const tmp = join(tempDir, `.up-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
			let got;
			try {
				got = await client.download(upload.url, tmp, { maxBytes: Math.min(maxFileBytes, Math.max(0, maxTotalBytes - fetched)) });
			} catch (err) {
				if (!(err instanceof UploadError)) throw err;
				if (err.fatal) {
					stopped = { reason: err.code, card: cardId, upload: upload.id };
					break outer;
				}
				got = { result: 'failed', status: 0 };
			}
			if (got.result === 'toobig') {
				stopped = { reason: maxTotalBytes - fetched < maxFileBytes ? 'total-cap' : 'file-cap', card: cardId, upload: upload.id, bytes: got.bytes };
				break outer;
			}
			if (got.result !== 'ok') {
				counts.got[got.result]++;
				failures.push({ card: cardId, upload: upload.id, result: got.result, status: got.status });
				if (++inARow >= FAILURES_IN_A_ROW) {
					stopped = { reason: 'many-failures', card: cardId, upload: upload.id };
					break outer;
				}
				continue;
			}
			inARow = 0;

			// The name: what the host says, else the link text; typed text goes through rule A before it is a name or an entry.
			const original = dispositionFileName(got.disposition) ?? upload.labels[0] ?? '';
			const red = redactFileName(original);
			if (red.flagged) {
				await writeRaw(rawDir, 'uploads', upload.id, { card: cardId, name: original }, { dryRun: false });
				counts.got.namesFlagged++;
			}
			const safe = safeFileName(red.value, { fallbackExt: extensionForType(got.type) });
			if (safe.toLowerCase() !== red.value.toLowerCase()) counts.got.namesChanged++;

			// A text file that holds an outside address or a phone-shaped number is person data that can be read, so rule A
			// applies: it stays in the local-only raw folder (listed in the card all the same). A picture or a PDF cannot be
			// scanned and goes to Drive as Van decided; a text too big to scan counts as flagged.
			const scanned = needsTextScan(got.type, safe);
			const local = scanned && (await holdsPersonData(tmp, got.bytes, maxScanBytes));
			if (local) counts.got.keptLocal++;
			if (!scanned) counts.got.unscanned++;
			const where = await place(local);
			let finalName = safe;
			let adopted = false;
			// A file already under that name is never overwritten: it may have been edited by hand.
			if (where.taken.has(safe.toLowerCase())) {
				// A file of that name that no entry lists is what a killed run left: the same bytes are the same upload.
				const existing = join(where.dir, safe);
				if (!listed.has(`${where.rel}/${safe}`) && (await sizeOf(existing)) === got.bytes && (await sha256Of(existing)) === got.sha256) adopted = true;
				else finalName = uniqueName(safe, where.taken);
			}
			if (adopted) await unlink(tmp).catch(() => {});
			else {
				await rename(tmp, join(where.dir, finalName));
				where.taken.add(finalName.toLowerCase());
			}
			counts.got[adopted ? 'adopted' : 'downloaded']++;
			fetched += got.bytes;
			if (!adopted) counts.got.bytes += got.bytes;
			const entry = { upload: upload.id, path: `${where.rel}/${finalName}`, name: red.value === '' ? finalName : red.value, bytes: got.bytes, sha256: got.sha256, ...(got.type === '' ? {} : { type: got.type }), ...(local ? { local: true } : {}) };

			// The card's entry, written with the hash read just now (a card somebody changed meanwhile is read again once).
			let written = false;
			for (let attempt = 0; attempt < 2 && !written; attempt++) {
				const fresh = await store.readIssue(cardId);
				const list = entryList(fresh.fields).filter((e) => !(isFileEntry(e) && e.upload === upload.id));
				list.push(entry);
				list.sort(byPath);
				try {
					const result = await store.writeIssue({ fields: { ...fresh.fields, files: list }, body: fresh.body }, { expect: fresh.hash });
					if (result.changed) counts.cards.changed++;
					written = true;
				} catch (err) {
					if (!(err instanceof BoardError) || err.code === 'locked') throw err;
					if (err.code !== 'changed' || attempt === 1) {
						counts.cards.failed++;
						failures.push({ card: cardId, upload: upload.id, result: `card-${err.code}` });
						break;
					}
				}
			}
			if (written) {
				have.set(upload.id, entry);
				listed.add(entry.path);
			}
		}
	}
	if (stopped !== null) return { counts, failures, stopped };

	// --- the thread entries: a comment lists the files of its own text ---
	for (const cardId of order) {
		const slot = cards.get(cardId);
		const have = linked.get(cardId) ?? new Map();
		const byComment = new Map();
		for (const upload of slot.uploads.values()) {
			const entry = have.get(upload.id);
			if (!entry) continue;
			for (const text of upload.texts) if (text.kind === 'comment') (byComment.get(text.comment) ?? byComment.set(text.comment, new Set()).get(text.comment)).add(entry.path);
		}
		for (let attempt = 0; attempt < 2; attempt++) {
			let thread;
			try {
				thread = await store.readThread(cardId);
			} catch (err) {
				if (!(err instanceof BoardError) || err.code === 'locked') throw err;
				counts.threads.failed++;
				break;
			}
			if (!thread) {
				if (byComment.size > 0) counts.threads.missing++;
				break;
			}
			if (attempt === 0 && byComment.size === 0 && !thread.entries.some((e) => e.extra?.files !== undefined)) break;
			if (attempt === 0) {
				counts.threads.read++;
				const here = new Set(thread.entries.map((e) => e.id));
				for (const id of byComment.keys()) if (!here.has(id)) counts.threads.commentsNotInThread++;
			}
			let changed = 0;
			const entries = thread.entries.map((e) => {
				const wanted = byComment.get(e.id);
				if (!wanted) {
					// A comment edited in Linear until it holds no upload link has no files to list any more.
					if (e.source !== 'linear' || e.extra?.files === undefined) return e;
					changed++;
					const { files: _gone, ...rest } = e.extra;
					const { extra: _extra, ...bare } = e;
					return Object.keys(rest).length === 0 ? bare : { ...e, extra: rest };
				}
				const files = [...wanted].sort();
				if (JSON.stringify(e.extra?.files) === JSON.stringify(files)) return e;
				changed++;
				return { ...e, extra: { ...e.extra, files } };
			});
			if (changed === 0) break;
			try {
				await store.writeThread(cardId, entries, { expect: thread.hash });
				counts.threads.entriesLinked += changed;
				counts.threads.written++;
				break;
			} catch (err) {
				if (!(err instanceof BoardError) || err.code === 'locked') throw err;
				if (err.code !== 'changed' || attempt === 1) {
					counts.threads.failed++;
					break;
				}
			}
		}
	}

	// --- the promise of the ticket, read back from the files: every listed file is there with the bytes it says ---
	for (const cardId of order) {
		const card = await store.readIssue(cardId);
		for (const entry of entryList(card.fields)) {
			if (!isFileEntry(entry)) continue;
			counts.checks.filesChecked++;
			if (!isSafeRelativePath(entry.path) || (await sizeOf(join(boardDir, entry.path))) !== entry.bytes) counts.checks.filesBroken++;
		}
	}
	return { counts, failures, stopped };
}

const pad = (v, n) => String(v).padStart(n);
const mb = (bytes) => `${(bytes / MB).toFixed(1)} MB`;

/** The counts-only report of a run: no file name, text or address; a failure names the issue key, the upload id and the status. */
export function formatUploadsSummary(found, { counts, failures, stopped }, { dryRun, filesSync, headDone }) {
	const f = found.counts;
	const c = counts;
	const lines = [dryRun ? 'Uploads import: DRY RUN, nothing written' : 'Uploads import: written'];
	lines.push(`found: ${f.distinct} distinct links (${f.inDescriptions} in descriptions, ${f.inComments} in comments) on ${f.cards} issue keys; ${f.refused} refused; ${f.leftForLater} more only in documents, project updates, attachments or comments on projects (left for later)`);
	lines.push(`on the board: ${c.cards.withUploads} cards hold uploads; ${c.cards.missing} keys have no card (${c.uploads.notPlaced} links not placed: import the issues first); ${c.cards.damaged} cards skipped (files field not a list or file unreadable)`);
	lines.push(`already there: ${c.uploads.present}; to fetch: ${c.uploads.toFetch}`);
	if (headDone) {
		lines.push(`sizes asked: ok ${c.head.ok}, gone ${c.head.gone}, denied ${c.head.denied}, failed ${c.head.failed}; known ${mb(c.head.bytesKnown)} (largest ${mb(c.head.largest)}), ${c.head.sizeUnknown} give no size`);
	} else {
		lines.push('sizes not asked (no key in the environment)');
	}
	if (!dryRun) {
		lines.push(`downloaded ${c.got.downloaded} (${mb(c.got.bytes)}), adopted ${c.got.adopted}, gone ${c.got.gone}, denied ${c.got.denied}, failed ${c.got.failed}; names redacted ${c.got.namesFlagged}, names made safe ${c.got.namesChanged}; text files with an address or phone number kept local-only (raw/files, not synced): ${c.got.keptLocal}; not scanned (pictures, video, PDF, archives): ${c.got.unscanned}`);
		lines.push(`card entries written ${c.cards.changed}, refused ${c.cards.failed}; thread entries linked ${c.threads.entriesLinked} in ${c.threads.written} threads (${c.threads.missing} cards without a thread, ${c.threads.commentsNotInThread} comments not in a thread, ${c.threads.failed} failed)`);
		lines.push(`checks: ${c.checks.filesChecked} listed files looked at, ${c.checks.filesBroken} broken`);
	}
	lines.push(`files folder: ${filesSync}`);
	if (failures.length > 0) {
		lines.push(`not saved (${failures.length}):`);
		for (const x of failures) lines.push(`  ${pad(x.card, 9)} ${x.upload} ${x.result}${x.status ? ` ${x.status}` : ''}`);
	}
	if (stopped) lines.push(`STOPPED (${stopped.reason})${stopped.card ? ` at ${stopped.card} ${stopped.upload ?? ''}` : ''}${stopped.bytes !== undefined ? `, ${mb(stopped.bytes)}` : ''}${stopped.count ? `, ${stopped.count} over the cap` : ''}`);
	return lines.join('\n');
}
