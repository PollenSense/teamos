import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BoardError } from './errors.mjs';
import { contentHash, mergeFields, parseDocument, serializeDocument } from './frontmatter.mjs';
import { assertCycleNumber, assertDocumentId, assertId, assertProjectCode, assertTeamKey, normalizeId } from './ids.mjs';
import { IssueIndex } from './issue-index.mjs';
import { withLock } from './lock.mjs';

/**
 * The fields each file type owns (design 2.2, 2.5). A writer replaces these from what it is given, so a field
 * Linear cleared disappears from the file; any other field already in the file is kept on rewrite (a file written
 * by a newer version, or by hand, loses nothing). Order here is the order in the file.
 */
export const ISSUE_FIELDS = [
	'id', 'aliases', 'linearId', 'team', 'title', 'status', 'statusType', 'priority', 'assignee', 'creator',
	'project', 'milestone', 'cycle', 'parent', 'labels', 'estimate', 'dueDate', 'branch', 'relations', 'prs', 'links',
	'created', 'updated', 'started', 'completed', 'canceled', 'archived', 'deleted', 'source',
];
export const PROJECT_FIELDS = [
	'code', 'name', 'linearId', 'teams', 'status', 'statusType', 'lead', 'startDate', 'targetDate', 'milestones', 'updates',
	'created', 'updated', 'archived', 'completed', 'canceled', 'source',
];
// `nextNumber` is not in this list on purpose: it belongs to the allocator and only ever goes up (see writeTeam).
export const TEAM_FIELDS = ['key', 'name', 'linearId', 'native', 'private', 'archived', 'states', 'cycles', 'source'];
export const CYCLE_FIELDS = ['number', 'team', 'name', 'startsAt', 'endsAt', 'completed', 'linearId', 'source'];
/** Read-only text kept beside the projects (Linear documents; ticket A4): `documents/<id>.md`, fields + the text. */
export const DOCUMENT_FIELDS = ['id', 'linearId', 'title', 'project', 'issue', 'created', 'updated', 'source'];
/** One-object files at the top of the board folder: who is who, the label list, which message tag is which project. */
export const SINGLE_FILES = ['people', 'labels', 'project-map'];

/**
 * Reads and writes the board's files under `dir` (`team/board/`): issues, projects, cycles, teams, people.
 *
 * Every write names what it expects to replace: `expect: 'new'` (the file must not exist) or the content hash the
 * caller read earlier. Under the lock the store re-reads the file and compares; a different hash is a `changed`
 * error, never a silent overwrite (design 2.2: before cutover only the importer writes, Linear wins every field,
 * and field-level merge between two writers is phase (c)). A write of identical text is not a write: the file is
 * left alone and `{ changed: false }` comes back, which is what makes a second import run write nothing.
 * Files are written to a temp file in the same folder and renamed into place, so a reader never sees a half-written one.
 *
 * `lockDir` is `team/.logs/board/` (local). `hooks.beforeRename` and `hooks.afterRename` are for tests only.
 */
export class BoardStore {
	constructor({ dir, lockDir, cachePath, lockOptions, hooks, dryRun } = {}) {
		if (!dir || !lockDir) throw new TypeError('BoardStore needs dir and lockDir');
		/** With `dryRun`, every write runs its checks and says `changed` as it would, and writes nothing into the board folder (locks and the index cache under `lockDir` are local and may still be touched). */
		this.dryRun = dryRun === true;
		this.dir = dir;
		this.lockDir = lockDir;
		this.lockOptions = lockOptions ?? {};
		this.hooks = hooks ?? {};
		this.index = new IssueIndex(join(dir, 'issues'), { cachePath: cachePath ?? join(lockDir, 'index.json') });
	}

	// --- paths (every name has passed ids.mjs, so none can leave its folder) ---
	issuePath(id) {
		const { team } = assertId(id);
		return join(this.dir, 'issues', team, `${id}.md`);
	}
	threadPath(id) {
		const { team } = assertId(id);
		return join(this.dir, 'issues', team, `${id}.thread.md`);
	}
	teamPath(key) {
		return join(this.dir, 'teams', `${assertTeamKey(key)}.json`);
	}
	cyclePath(team, number) {
		return join(this.dir, 'cycles', assertTeamKey(team), `${assertCycleNumber(number)}.json`);
	}
	projectPath(code) {
		return join(this.dir, 'projects', `${assertProjectCode(code)}.md`);
	}
	peoplePath() {
		return this.singlePath('people');
	}
	singlePath(name) {
		if (!SINGLE_FILES.includes(name)) throw new BoardError('bad-id', `"${String(name).slice(0, 40)}" is not one of the board's single files (${SINGLE_FILES.join(', ')})`);
		return join(this.dir, `${name}.json`);
	}
	documentPath(id) {
		return join(this.dir, 'documents', `${assertDocumentId(id)}.md`);
	}

	// --- files ---
	async _read(path) {
		try {
			const text = await readFile(path, 'utf-8');
			return { text, hash: contentHash(text) };
		} catch (err) {
			if (err.code === 'ENOENT') return null;
			throw err;
		}
	}

	/**
	 * Write `text` to `path` through a temp file. Returns `{ m, s }`, the mtime and size of the temp file taken just
	 * before the rename; the rename keeps both, so they describe the file we put in place even when a sync replaces
	 * it a moment later (the index stores them with the fields we wrote).
	 */
	async _writeAtomic(path, text) {
		await mkdir(dirname(path), { recursive: true });
		const tmp = join(dirname(path), `.${process.pid}-${Math.random().toString(36).slice(2, 10)}.tmp`);
		try {
			const handle = await open(tmp, 'w');
			try {
				await handle.writeFile(text, 'utf-8');
			} finally {
				await handle.close();
			}
			const st = await stat(tmp);
			if (this.hooks.beforeRename) await this.hooks.beforeRename(path);
			await rename(tmp, path);
			if (this.hooks.afterRename) await this.hooks.afterRename(path);
			return { m: st.mtimeMs, s: st.size };
		} catch (err) {
			await unlink(tmp).catch(() => {});
			throw err;
		}
	}

	_check(current, expect, what) {
		if (expect === 'new') {
			if (current) throw new BoardError('duplicate-id', `${what} already exists`);
		} else if (typeof expect === 'string') {
			if (!current) throw new BoardError('missing', `${what} is not there to replace`);
			if (current.hash !== expect) throw new BoardError('changed', `${what} changed since it was read`);
		} else {
			throw new BoardError('bad-call', `a write of ${what} needs expect: 'new' or the hash that was read`);
		}
	}

	/**
	 * The write step shared by every file type: check, skip when identical, write. `afterWrite(written)` is awaited
	 * after a real write with the `{ m, s }` of `_writeAtomic`; it is not called when nothing was written.
	 */
	async _put(path, text, expect, what, afterWrite) {
		const current = await this._read(path);
		this._check(current, expect, what);
		const hash = contentHash(text);
		if (current && current.hash === hash) return { changed: false, hash };
		if (!this.dryRun) {
			const written = await this._writeAtomic(path, text);
			if (afterWrite) await afterWrite(written);
		}
		return { changed: true, hash };
	}

	async _readDocument(path, what) {
		const file = await this._read(path);
		if (!file) return null;
		try {
			const { fields, body } = parseDocument(file.text);
			return { fields, body, hash: file.hash, path };
		} catch (err) {
			if (err instanceof BoardError) throw new BoardError('damaged', `${what}: ${err.message}`);
			throw err;
		}
	}

	async _readJson(path, what) {
		const file = await this._read(path);
		if (!file) return null;
		let data;
		try {
			data = JSON.parse(file.text);
		} catch {
			throw new BoardError('damaged', `${what} is not JSON`);
		}
		if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new BoardError('damaged', `${what} is not a JSON object`);
		return { data, hash: file.hash, path };
	}

	_jsonText(data) {
		return `${JSON.stringify(data, null, '\t')}\n`;
	}

	// --- issues ---
	/**
	 * The issue for an ID or an alias (`pse-812` opens the card that moved to another team), or null. A canonical ID
	 * that has a file costs one read; anything else refreshes the index to look for an alias.
	 */
	async readIssue(idOrAlias) {
		const id = normalizeId(idOrAlias);
		if (!id) return null;
		const direct = await this._readDocument(this.issuePath(id), `issue ${id}`);
		if (direct) return { id, ...direct };
		await this.index.refresh();
		const owner = this.index.resolve(id);
		if (!owner || owner === id) return null;
		const moved = await this._readDocument(this.issuePath(owner), `issue ${owner}`);
		return moved ? { id: owner, ...moved } : null;
	}

	/**
	 * Write one issue file. `fields.id` is the ID (the file name); `body` is the description (left as it is when
	 * undefined). Throws `bad-id`, `duplicate-id`, `alias-conflict`, `changed`, `missing`, `damaged`, `locked`.
	 * Returns `{ id, changed, hash, retired }`.
	 *
	 * `retire` (a list of IDs) is for a card that moved teams since it was imported: the old files are the SAME Linear
	 * issue under its earlier keys (their `linearId` equals `fields.linearId`; a file of any other card is refused as
	 * `alias-conflict`), and are removed in the same step, after the new file is written. The new card keeps the fields
	 * the old file had that the writer does not own (relations, links, ...), and the old thread file follows it. The
	 * old IDs must be in `fields.aliases`, so they keep opening the card. Nothing is removed in a dry run (`retired`
	 * still says which would be).
	 */
	async writeIssue({ fields, body }, { expect, retire = [] } = {}) {
		const { id, team } = assertId(fields?.id);
		const retireIds = [...new Set(retire.map((r) => assertId(r).id))];
		if (retireIds.includes(id)) throw new BoardError('bad-id', `${id} cannot retire itself`);
		if (fields.team !== undefined && fields.team !== team) throw new BoardError('bad-id', `team ${JSON.stringify(fields.team)} does not match the ID ${id}`);
		let aliases;
		if (fields.aliases !== undefined) {
			if (!Array.isArray(fields.aliases)) throw new BoardError('bad-id', `aliases of ${id} are not a list`);
			aliases = [];
			for (const raw of fields.aliases) {
				const alias = normalizeId(raw);
				if (!alias) throw new BoardError('bad-id', `alias ${JSON.stringify(raw)} of ${id} is not an issue ID`);
				if (alias === id) throw new BoardError('alias-conflict', `alias ${alias} is the card's own ID`);
				if (!aliases.includes(alias)) aliases.push(alias);
			}
		}
		for (const r of retireIds) if (!(aliases ?? []).includes(r)) throw new BoardError('bad-id', `${r} is retired by ${id} but is not one of its aliases`);
		const path = this.issuePath(id);
		return withLock(this.lockDir, 'issues', async () => {
			await this.index.refresh();
			// The files to retire must be the same Linear issue. Read them first: a file of another card is a conflict, whatever the index says.
			const old = [];
			for (const r of retireIds) {
				const doc = await this._readDocument(this.issuePath(r), `issue ${r}`);
				if (!doc) continue;
				if (typeof fields.linearId !== 'string' || doc.fields.linearId !== fields.linearId) {
					throw new BoardError('alias-conflict', `alias ${r} of ${id} is the file of another issue`, { alias: r, owner: r });
				}
				old.push({ id: r, doc });
			}
			const retiring = new Set(old.map((o) => o.id));
			const taken = this.index.aliasOwner.get(id);
			if (taken && taken !== id && !retiring.has(taken)) throw new BoardError('alias-conflict', `${id} is an alias of ${taken}`, { alias: id, owner: taken });
			for (const alias of aliases ?? []) {
				if (retiring.has(alias)) continue;
				if (this.index.byId.has(alias)) throw new BoardError('alias-conflict', `alias ${alias} of ${id} is the real ID of another issue`, { alias, owner: alias });
				const owner = this.index.aliasOwner.get(alias);
				if (owner && owner !== id && !retiring.has(owner)) throw new BoardError('alias-conflict', `alias ${alias} of ${id} already belongs to ${owner}`, { alias, owner });
				// A file with that name is a real issue even when the index cannot read it (damaged, id mismatch).
				if (await stat(this.issuePath(alias)).then(() => true, () => false)) throw new BoardError('alias-conflict', `alias ${alias} of ${id} is the name of an existing issue file`, { alias, owner: alias });
			}
			const current = await this._readDocument(path, `issue ${id}`);
			this._check(current && { hash: current.hash }, expect, `issue ${id}`);
			// The fields the writer does not own come from the new file, or from the oldest retired one (a move keeps them).
			const base = current?.fields ?? old[0]?.doc.fields;
			const merged = mergeFields(base, { ...fields, ...(aliases ? { aliases } : {}), team }, ISSUE_FIELDS);
			const text = serializeDocument(merged, body ?? current?.body ?? old[0]?.doc.body ?? '');
			// The index gets what the file says, not the caller's objects, with the stat of the file we wrote (a dry run writes nothing, so the index hears nothing).
			const result = await this._put(path, text, expect, `issue ${id}`, (written) => this.index.noteWritten(`${team}/${id}.md`, parseDocument(text).fields, written));
			if (!this.dryRun) {
				for (const o of old) {
					const oldTeam = assertId(o.id).team;
					const thread = this.threadPath(o.id);
					if (await stat(thread).then(() => true, () => false)) await rename(thread, this.threadPath(id));
					await unlink(this.issuePath(o.id));
					await this.index.noteRemoved(`${oldTeam}/${o.id}.md`);
				}
			}
			return { id, ...result, retired: old.map((o) => o.id) };
		}, this.lockOptions);
	}

	// --- projects (Markdown: fields + description) ---
	async readProject(code) {
		return this._readDocument(this.projectPath(code), `project ${code}`).then((doc) => doc && { code, ...doc });
	}
	async writeProject({ fields, body }, { expect } = {}) {
		const code = assertProjectCode(fields?.code);
		const path = this.projectPath(code);
		return withLock(this.lockDir, `project-${code}`, async () => {
			const current = await this._readDocument(path, `project ${code}`);
			this._check(current && { hash: current.hash }, expect, `project ${code}`);
			const merged = mergeFields(current?.fields, fields, PROJECT_FIELDS);
			const result = await this._put(path, serializeDocument(merged, body ?? current?.body ?? ''), expect, `project ${code}`);
			return { code, ...result };
		}, this.lockOptions);
	}
	async listProjects() {
		try {
			return (await readdir(join(this.dir, 'projects'))).filter((n) => n.endsWith('.md') && !n.startsWith('.')).map((n) => n.slice(0, -3)).sort();
		} catch {
			return [];
		}
	}

	// --- JSON files: teams, cycles, people ---
	async _writeJsonRecord(path, name, data, known, expect, what, finish) {
		if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new BoardError('bad-value', `${what} must be written as a JSON object`);
		return withLock(this.lockDir, name, async () => {
			const current = await this._readJson(path, what);
			this._check(current && { hash: current.hash }, expect, what);
			const merged = known ? mergeFields(current?.data, data, known) : data;
			if (finish) finish(merged, current?.data);
			return this._put(path, this._jsonText(merged), expect, what);
		}, this.lockOptions);
	}

	async readTeam(key) {
		const file = await this._readJson(this.teamPath(key), `team ${key}`);
		return file && { key, data: file.data, hash: file.hash };
	}
	/**
	 * `nextNumber` is the allocator's: it is kept from the existing file and only ever raised (the larger of the old
	 * value and the one given), so a team rewrite can neither erase it nor hand out an ID twice.
	 */
	async writeTeam(data, { expect } = {}) {
		const key = assertTeamKey(data?.key);
		if (data.nextNumber !== undefined && (!Number.isInteger(data.nextNumber) || data.nextNumber < 1)) throw new BoardError('bad-value', `nextNumber ${JSON.stringify(data.nextNumber)} is not a positive whole number`);
		const finish = (merged, old) => {
			const keep = Number.isInteger(old?.nextNumber) && old.nextNumber >= 1 ? old.nextNumber : 0;
			const next = Math.max(keep, data.nextNumber ?? 0);
			if (next > 0) merged.nextNumber = next;
			else delete merged.nextNumber;
		};
		return { key, ...(await this._writeJsonRecord(this.teamPath(key), `team-${key}`, data, TEAM_FIELDS, expect, `team ${key}`, finish)) };
	}

	async readCycle(team, number) {
		const file = await this._readJson(this.cyclePath(team, number), `cycle ${team}-${number}`);
		return file && { team, number, data: file.data, hash: file.hash };
	}
	async writeCycle(data, { expect } = {}) {
		const team = assertTeamKey(data?.team);
		const number = assertCycleNumber(data?.number);
		return { team, number, ...(await this._writeJsonRecord(this.cyclePath(team, number), `cycle-${team}-${number}`, data, CYCLE_FIELDS, expect, `cycle ${team}-${number}`)) };
	}
	async listCycles(team) {
		try {
			return (await readdir(join(this.dir, 'cycles', assertTeamKey(team)))).map((n) => /^([1-9][0-9]*)\.json$/.exec(n)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
		} catch {
			return [];
		}
	}

	/** people.json is one object whose shape belongs to the importer (A4): the store only reads and replaces it whole. */
	async readPeople() {
		return this.readSingle('people');
	}
	async writePeople(data, { expect } = {}) {
		return this.writeSingle('people', data, { expect });
	}

	/** `people`, `labels`, `project-map`: one JSON object each, read and replaced whole (the shape belongs to the importer). */
	async readSingle(name) {
		return this._readJson(this.singlePath(name), `${name}.json`);
	}
	async writeSingle(name, data, { expect } = {}) {
		return this._writeJsonRecord(this.singlePath(name), `single-${name}`, data, null, expect, `${name}.json`);
	}

	// --- documents (Markdown: fields + the text; read-only text of phase (a)) ---
	async readDocument(id) {
		return this._readDocument(this.documentPath(id), `document ${id}`).then((doc) => doc && { id, ...doc });
	}
	async writeDocument({ fields, body }, { expect } = {}) {
		const id = assertDocumentId(fields?.id);
		const path = this.documentPath(id);
		return withLock(this.lockDir, `document-${id}`, async () => {
			const current = await this._readDocument(path, `document ${id}`);
			this._check(current && { hash: current.hash }, expect, `document ${id}`);
			const merged = mergeFields(current?.fields, fields, DOCUMENT_FIELDS);
			const result = await this._put(path, serializeDocument(merged, body ?? current?.body ?? ''), expect, `document ${id}`);
			return { id, ...result };
		}, this.lockOptions);
	}
	async listDocuments() {
		try {
			return (await readdir(join(this.dir, 'documents'))).filter((n) => n.endsWith('.md') && !n.startsWith('.')).map((n) => n.slice(0, -3)).sort();
		} catch {
			return [];
		}
	}

	// --- the ID allocator (design 2.3): built now, used from phase (c) and by the importer's last step ---
	/**
	 * The next free ID of a team: reads `nextNumber` from the team file, skips any number that already has a file
	 * or is an alias, writes the next one back, and returns `{ id, number }`. The number is saved before it is
	 * returned, so a crash loses a number and never hands it out twice (IDs are not reused).
	 */
	async nextNumber(key) {
		assertTeamKey(key);
		return withLock(this.lockDir, `team-${key}`, async () => {
			const team = await this._readJson(this.teamPath(key), `team ${key}`);
			if (!team) throw new BoardError('missing', `team ${key} has no file`);
			let n = team.data.nextNumber;
			if (!Number.isInteger(n) || n < 1) throw new BoardError('damaged', `team ${key} has no usable nextNumber`);
			await this.index.refresh();
			while (this.index.byId.has(`${key}-${n}`) || this.index.aliasOwner.has(`${key}-${n}`) || (await stat(this.issuePath(`${key}-${n}`)).then(() => true, () => false))) n++;
			await this._put(this.teamPath(key), this._jsonText({ ...team.data, nextNumber: n + 1 }), team.hash, `team ${key}`);
			return { id: `${key}-${n}`, number: n };
		}, this.lockOptions);
	}

	/** The importer's last step: `nextNumber` becomes at least `number` (the highest imported plus one). Never lowers it. */
	async raiseNextNumber(key, number) {
		assertTeamKey(key);
		if (!Number.isInteger(number) || number < 1) throw new BoardError('bad-id', `nextNumber ${JSON.stringify(number)} is not a positive whole number`);
		return withLock(this.lockDir, `team-${key}`, async () => {
			const team = await this._readJson(this.teamPath(key), `team ${key}`);
			if (!team) throw new BoardError('missing', `team ${key} has no file`);
			const next = Math.max(Number.isInteger(team.data.nextNumber) ? team.data.nextNumber : 1, number);
			if (next !== team.data.nextNumber) await this._put(this.teamPath(key), this._jsonText({ ...team.data, nextNumber: next }), team.hash, `team ${key}`);
			return next;
		}, this.lockOptions);
	}
}
