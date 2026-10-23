import { mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { askedBy, foldAsk, waitingOn } from './questions.mjs';

const HEAD_BYTES = 32 * 1024;
const STAT_PARALLEL = 64;
const READ_PARALLEL = 32;

/** `fn` over `items` with at most `limit` in flight; results in order. */
async function mapLimit(items, limit, fn) {
	const results = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

/**
 * Reads the frontmatter of every message in the master store and folds the questions in them (see
 * questions.mjs). Parsed headers are cached per file and validated by the file's mtime: in memory, and in a
 * cache file (`team/.logs/questions-index.json`, outside the Drive sync, safe to delete) so that a fresh process,
 * such as an agent's MCP server, does not have to read every message to answer. A call costs one `stat` per
 * message (run in parallel) plus a re-read of the few that changed. The cache file only ever holds what the
 * messages say, so any version of it is valid and concurrent writers cannot corrupt the answer (each writes a
 * temporary file and renames it).
 *
 * `parseHeader(text)` turns the head of a message file into a normalized message without its body (the file
 * adapter's own parser, passed in so the two cannot drift apart).
 */
export class QuestionIndex {
	constructor(messagesDir, parseHeader, { cachePath } = {}) {
		this.dir = join(messagesDir);
		this.parseHeader = parseHeader;
		this.cachePath = cachePath;
		this.cache = new Map();
		this.loaded = !cachePath;
	}

	/** The head of a message file: enough to hold the frontmatter, or the whole file when that is longer. */
	async _readHead(path) {
		const handle = await open(path, 'r');
		try {
			const buffer = Buffer.alloc(HEAD_BYTES);
			const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
			const head = buffer.toString('utf-8', 0, bytesRead);
			if (bytesRead < HEAD_BYTES || /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/.test(head)) return head;
		} finally {
			await handle.close();
		}
		return readFile(path, 'utf-8');
	}

	async _loadCacheFile() {
		this.loaded = true;
		try {
			const data = JSON.parse(await readFile(this.cachePath, 'utf-8'));
			if (data?.version !== 1 || typeof data.files !== 'object') return;
			for (const [id, hit] of Object.entries(data.files)) {
				if (hit && typeof hit.m === 'number' && hit.meta) this.cache.set(id, { mtimeMs: hit.m, meta: hit.meta });
			}
		} catch {
			// No cache file, or one we cannot read: start from nothing.
		}
	}

	async _saveCacheFile() {
		if (!this.cachePath) return;
		const files = {};
		for (const [id, hit] of this.cache) files[id] = { m: hit.mtimeMs, meta: hit.meta };
		const tmp = `${this.cachePath}.${process.pid}.tmp`;
		try {
			await mkdir(dirname(this.cachePath), { recursive: true });
			await writeFile(tmp, JSON.stringify({ version: 1, files }), 'utf-8');
			await rename(tmp, this.cachePath);
		} catch {
			// A cache that cannot be written only costs time on the next cold start.
		}
	}

	/** Every message's header, as the adapter normalizes it (no body). */
	async scan() {
		if (!this.loaded) await this._loadCacheFile();
		let names;
		try {
			names = (await readdir(this.dir)).filter((n) => n.endsWith('.md'));
		} catch {
			return [];
		}
		const ids = names.map((n) => n.slice(0, -3));
		const stats = await mapLimit(names, STAT_PARALLEL, (name) => stat(join(this.dir, name)).catch(() => null));
		const seen = new Set();
		const stale = [];
		const out = new Array(ids.length);
		ids.forEach((id, i) => {
			if (!stats[i]) return; // deleted between the listing and now
			seen.add(id);
			const hit = this.cache.get(id);
			if (hit && hit.mtimeMs === stats[i].mtimeMs) out[i] = hit.meta;
			else stale.push(i);
		});
		await mapLimit(stale, READ_PARALLEL, async (i) => {
			try {
				const meta = this.parseHeader(await this._readHead(join(this.dir, names[i])));
				if (!meta.id) meta.id = ids[i];
				this.cache.set(ids[i], { mtimeMs: stats[i].mtimeMs, meta });
				out[i] = meta;
			} catch {
				seen.delete(ids[i]);
			}
		});
		let removed = false;
		for (const id of this.cache.keys()) {
			if (!seen.has(id)) {
				this.cache.delete(id);
				removed = true;
			}
		}
		if (stale.length > 0 || removed) await this._saveCacheFile();
		return out.filter(Boolean);
	}

	/**
	 * The folded state of every ask in the store: `{ entries, byId, folded }` with `folded` a Map from the asking
	 * message's id to `foldAsk`'s result. `isHuman(name)` says whether a member is a person (for dismissals).
	 */
	async snapshot({ isHuman } = {}) {
		const entries = await this.scan();
		const byId = new Map(entries.map((e) => [e.id, e]));
		const repliesByAsk = new Map();
		for (const entry of entries) {
			for (const askId of new Set((entry.answers ?? []).map((a) => a.ask))) {
				if (!repliesByAsk.has(askId)) repliesByAsk.set(askId, []);
				repliesByAsk.get(askId).push(entry);
			}
		}
		const ctx = { lookup: (id) => byId.get(id) ?? null, isHuman };
		const folded = new Map();
		for (const entry of entries) {
			if (entry.questions?.length) folded.set(entry.id, foldAsk(entry, repliesByAsk.get(entry.id) ?? [], ctx));
		}
		return { entries, byId, folded, ctx };
	}

	/** What `member` owes and what `member` is waiting for: `{ waitingOnMe, asked }`. */
	async lists(member, opts) {
		const { entries, byId, folded } = await this.snapshot(opts);
		// A plain reply counts for the question it answers even when it answers a follow-up (at most 12 hops up).
		const askOf = (entry) => {
			let current = entry;
			for (let hops = 0; current && hops < 12; hops++) {
				if (current.replyTo && folded.has(current.replyTo)) return current.replyTo;
				current = current.replyTo ? byId.get(current.replyTo) : null;
			}
			return entry.replyTo;
		};
		const textReplies = entries
			.filter((e) => e.replyTo && !(e.answers?.length))
			.map((e) => ({ id: e.id, askId: askOf(e), from: e.from, sentAt: e.sentAt }));
		const asks = [...folded.values()];
		return { waitingOnMe: waitingOn(member, asks), asked: askedBy(member, asks, textReplies) };
	}
}
