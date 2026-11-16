import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseHead } from './frontmatter.mjs';
import { isTeamKey, normalizeId, parseId } from './ids.mjs';

const HEAD_BYTES = 32 * 1024;
const STAT_PARALLEL = 64;
const READ_PARALLEL = 32;
const ISSUE_FILE = /^([A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,8})\.md$/;

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

/** Team key first, then the number as a number: PSE-9 comes before PSE-10. */
function compareIds(a, b) {
	const pa = parseId(a);
	const pb = parseId(b);
	return pa.team === pb.team ? pa.number - pb.number : pa.team < pb.team ? -1 : 1;
}

/**
 * The index of issue files: what every list, filter and ID lookup reads instead of opening 1,500 to 2,000 files.
 *
 * Each file's front matter is cached with the file's **mtime and size**; a file counts as unchanged only when both
 * are exactly what was cached. mtime alone is not enough: Drive and rclone can put an older mtime on a changed
 * file, so an `mtime <= cached` rule would miss it, and any difference in either number re-reads. (A change that
 * keeps both the size and the mtime is not seen; nothing in the sync does that.) A call costs one `stat` per file,
 * run in parallel, plus a re-read of the few that changed. The cache is in memory and in `cachePath`
 * (`team/.logs/board/index.json`: local, safe to delete, a temp file and a rename per save), so a fresh process
 * starts warm. It only holds what the files say, so any version of it is valid.
 *
 * Only `<issuesDir>/<TEAM>/<ID>.md` counts. Thread files (`PSE-1.thread.md`), temp files and strays do not match
 * the name rule and are ignored. What is wrong with a file that does match is listed in `problems`, not thrown:
 *   damaged        the front matter is missing or not closed
 *   misplaced      the file name is not in its team's folder
 *   id-mismatch    the `id` field is not the file name
 *   alias-shadowed an alias equal to another issue's real ID (the real ID wins)
 *   alias-taken    an alias two issues claim (the lower ID keeps it)
 */
export class IssueIndex {
	constructor(issuesDir, { cachePath } = {}) {
		this.dir = issuesDir;
		this.cachePath = cachePath;
		this.cache = new Map(); // rel path -> { m, s, fields } | { m, s, bad: true }
		this.loaded = !cachePath;
		this.byId = new Map(); // id -> { id, rel, fields }
		this.aliasOwner = new Map(); // alias -> id
		this.problems = [];
		this.misplaced = []; // rel paths found at the last refresh
		this.dirty = false;
	}

	async _loadCacheFile() {
		this.loaded = true;
		try {
			const data = JSON.parse(await readFile(this.cachePath, 'utf-8'));
			if (data?.version !== 1 || typeof data.files !== 'object' || data.files === null) return;
			for (const [rel, hit] of Object.entries(data.files)) {
				if (hit && typeof hit.m === 'number' && typeof hit.s === 'number' && (hit.bad === true || (hit.f && typeof hit.f === 'object'))) {
					this.cache.set(rel, hit.bad ? { m: hit.m, s: hit.s, bad: true } : { m: hit.m, s: hit.s, fields: hit.f });
				}
			}
		} catch {
			// No cache file, or one we cannot read: start from nothing.
		}
	}

	async _saveCacheFile() {
		this.dirty = false;
		if (!this.cachePath) return;
		const files = {};
		for (const [rel, hit] of this.cache) files[rel] = hit.bad ? { m: hit.m, s: hit.s, bad: true } : { m: hit.m, s: hit.s, f: hit.fields };
		const tmp = `${this.cachePath}.${process.pid}.tmp`;
		try {
			await mkdir(dirname(this.cachePath), { recursive: true });
			await writeFile(tmp, JSON.stringify({ version: 1, files }), 'utf-8');
			await rename(tmp, this.cachePath);
		} catch {
			// The cache is an optimisation: failing to save it must not fail a read.
			await unlink(tmp).catch(() => {});
		}
	}

	async _readFront(path) {
		const handle = await open(path, 'r');
		try {
			const buffer = Buffer.alloc(HEAD_BYTES);
			const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
			const head = buffer.toString('utf-8', 0, bytesRead);
			const parsed = parseHead(head);
			if (parsed || bytesRead < HEAD_BYTES) return parsed;
		} finally {
			await handle.close();
		}
		return parseHead(await readFile(path, 'utf-8'));
	}

	async _listFiles() {
		const files = [];
		this.misplaced = [];
		let teams;
		try {
			teams = await readdir(this.dir, { withFileTypes: true });
		} catch (err) {
			if (err.code === 'ENOENT') return files; // no issues yet
			throw err; // an unreadable folder is not an empty one: do not let the index (and the alias guard) believe that
		}
		for (const team of teams) {
			if (!team.isDirectory() || !isTeamKey(team.name)) continue;
			let names;
			try {
				names = await readdir(join(this.dir, team.name));
			} catch (err) {
				if (err.code === 'ENOENT') continue;
				throw err;
			}
			for (const name of names) {
				const match = ISSUE_FILE.exec(name);
				if (!match) continue;
				if (!match[1].startsWith(`${team.name}-`)) this.misplaced.push(`${team.name}/${name}`);
				else files.push({ rel: `${team.name}/${name}`, team: team.name, id: match[1] });
			}
		}
		return files;
	}

	/**
	 * Bring the index up to date with the files. Returns `{ count, reread }`: how many issues there are and how
	 * many files had to be read this time.
	 */
	async refresh() {
		if (!this.loaded) await this._loadCacheFile();
		const files = await this._listFiles();
		const stats = await mapLimit(files, STAT_PARALLEL, async (file) => {
			try {
				const st = await stat(join(this.dir, file.rel));
				return { m: st.mtimeMs, s: st.size };
			} catch {
				return null; // gone between the listing and the stat
			}
		});
		const live = new Set();
		const toRead = [];
		files.forEach((file, i) => {
			const st = stats[i];
			if (!st) return;
			live.add(file.rel);
			const hit = this.cache.get(file.rel);
			if (!hit || hit.m !== st.m || hit.s !== st.s) toRead.push({ file, st });
		});
		await mapLimit(toRead, READ_PARALLEL, async ({ file, st }) => {
			try {
				const parsed = await this._readFront(join(this.dir, file.rel));
				this.cache.set(file.rel, parsed ? { m: st.m, s: st.s, fields: parsed.fields } : { m: st.m, s: st.s, bad: true });
			} catch {
				live.delete(file.rel);
				this.cache.delete(file.rel);
			}
		});
		let removed = 0;
		for (const rel of [...this.cache.keys()]) {
			if (!live.has(rel)) {
				this.cache.delete(rel);
				removed++;
			}
		}
		this._rebuild(files.filter((f) => live.has(f.rel)));
		if (toRead.length || removed || this.dirty) await this._saveCacheFile();
		return { count: this.byId.size, reread: toRead.length };
	}

	_rebuild(files) {
		this.byId = new Map();
		this.aliasOwner = new Map();
		this.problems = this.misplaced.map((rel) => ({ rel, code: 'misplaced' }));
		for (const file of files) {
			const hit = this.cache.get(file.rel);
			if (!hit) continue;
			if (hit.bad) {
				this.problems.push({ rel: file.rel, code: 'damaged' });
				continue;
			}
			if (hit.fields.id !== file.id) {
				this.problems.push({ rel: file.rel, code: 'id-mismatch' });
				continue;
			}
			this.byId.set(file.id, { id: file.id, rel: file.rel, fields: hit.fields });
		}
		const ids = [...this.byId.keys()].sort(compareIds);
		for (const id of ids) {
			const aliases = Array.isArray(this.byId.get(id).fields.aliases) ? this.byId.get(id).fields.aliases : [];
			for (const raw of aliases) {
				const alias = normalizeId(raw);
				if (!alias || alias === id) continue;
				if (this.byId.has(alias)) this.problems.push({ rel: this.byId.get(id).rel, code: 'alias-shadowed', alias });
				else if (this.aliasOwner.has(alias) && this.aliasOwner.get(alias) !== id) this.problems.push({ rel: this.byId.get(id).rel, code: 'alias-taken', alias });
				else this.aliasOwner.set(alias, id);
			}
		}
	}

	/** After the store wrote `rel` itself: stat it and keep the entry, so the next refresh does not re-read it. */
	async noteWritten(rel, fields) {
		try {
			const st = await stat(join(this.dir, rel));
			this.cache.set(rel, { m: st.mtimeMs, s: st.size, fields });
		} catch {
			this.cache.delete(rel);
		}
		const files = [...this.cache.keys()].map((r) => ({ rel: r, team: r.split('/')[0], id: r.split('/')[1].replace(/\.md$/, '') }));
		this._rebuild(files);
		this.dirty = true;
	}

	/** After the store removed `rel` itself (a card retired by a move): forget it without waiting for the next refresh. */
	noteRemoved(rel) {
		this.cache.delete(rel);
		const files = [...this.cache.keys()].map((r) => ({ rel: r, team: r.split('/')[0], id: r.split('/')[1].replace(/\.md$/, '') }));
		this._rebuild(files);
		this.dirty = true;
	}

	/** Save the cache file if a write of our own changed it since the last save (a batch calls this once at the end). */
	async flush() {
		if (this.dirty) await this._saveCacheFile();
	}

	/** The canonical ID a typed ID or an alias stands for, as of the last refresh; null when none. */
	resolve(text) {
		const id = normalizeId(text);
		if (!id) return null;
		if (this.byId.has(id)) return id;
		return this.aliasOwner.get(id) ?? null;
	}

	get(id) {
		return this.byId.get(id) ?? null;
	}

	/** All issues, sorted by team then number. */
	entries() {
		return [...this.byId.values()].sort((a, b) => compareIds(a.id, b.id));
	}
}
