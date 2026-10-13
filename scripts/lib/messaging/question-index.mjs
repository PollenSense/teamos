import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { askedBy, foldAsk, waitingOn } from './questions.mjs';

const HEAD_BYTES = 32 * 1024;

/**
 * Reads the frontmatter of every message in the master store and folds the questions in them (see
 * questions.mjs). It keeps nothing on disk: parsed headers are cached in memory per file, validated by the
 * file's mtime, so after the first pass a call costs one `stat` per message and a re-read of the few that
 * changed. A fresh process (an agent's MCP server) pays the first pass once, and only when it asks.
 *
 * `parseHeader(text)` turns the head of a message file into a normalized message without its body (the file
 * adapter's own parser, passed in so the two cannot drift apart).
 */
export class QuestionIndex {
	constructor(messagesDir, parseHeader) {
		this.dir = join(messagesDir);
		this.parseHeader = parseHeader;
		this.cache = new Map();
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

	/** Every message's header, as the adapter normalizes it (no body). */
	async scan() {
		let names;
		try {
			names = await readdir(this.dir);
		} catch {
			return [];
		}
		const seen = new Set();
		const out = [];
		for (const name of names) {
			if (!name.endsWith('.md')) continue;
			const id = name.slice(0, -3);
			seen.add(id);
			const path = join(this.dir, name);
			let info;
			try {
				info = await stat(path);
			} catch {
				continue; // deleted between the listing and now
			}
			let hit = this.cache.get(id);
			if (!hit || hit.mtimeMs !== info.mtimeMs) {
				let meta;
				try {
					meta = this.parseHeader(await this._readHead(path));
				} catch {
					continue;
				}
				if (!meta.id) meta.id = id;
				hit = { mtimeMs: info.mtimeMs, meta };
				this.cache.set(id, hit);
			}
			out.push(hit.meta);
		}
		for (const id of this.cache.keys()) if (!seen.has(id)) this.cache.delete(id);
		return out;
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
		const { entries, folded } = await this.snapshot(opts);
		const textReplies = entries
			.filter((e) => e.replyTo && !(e.answers?.length))
			.map((e) => ({ id: e.id, askId: e.replyTo, from: e.from, sentAt: e.sentAt }));
		const asks = [...folded.values()];
		return { waitingOnMe: waitingOn(member, asks), asked: askedBy(member, asks, textReplies) };
	}
}
