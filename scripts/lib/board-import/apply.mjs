import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BoardError } from '../board/index.mjs';
import { ImportError } from './reference.mjs';

/**
 * Writes a reference plan through the board store, counting what each file did. A store made with `dryRun: true`
 * runs every check and writes nothing, which is what the dry run is (counts of files that would be created or changed).
 *
 * Order matters for rule A: the local-only raw copy of a text is written before the synced file that holds its
 * redacted form, and a real run asks the sync-filter guard first, before any file. The guard is the caller's
 * (`assertLocalOnly` bound to the raw folder); a failed guard stops the run with nothing written.
 */

const RAW_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RAW_TYPES = ['projects', 'documents', 'names', 'issues'];

function rawPath(rawDir, type, id) {
	if (!RAW_TYPES.includes(type)) throw new ImportError('bad-raw', 'a raw record has a type the importer does not know');
	if (typeof id !== 'string' || !RAW_NAME.test(id)) throw new ImportError('bad-raw', 'a raw record has an id that is not a plain name');
	return join(rawDir, type, `${id}.json`);
}

/**
 * The folder for one raw type must be a real folder of ours. A link there (say `raw/projects` pointing into the synced
 * workspace) would carry the original texts, which are meant to stay local, to wherever it points: mkdir and open both
 * follow it. Missing is fine (it is created next); a link, a file or anything else that is not a folder is refused
 * before anything is read or written, in a dry run too.
 */
async function assertPlainRawFolder(rawDir, type) {
	let st;
	try {
		st = await lstat(join(rawDir, type));
	} catch (err) {
		if (err.code === 'ENOENT') return;
		throw err;
	}
	if (st.isSymbolicLink() || !st.isDirectory()) {
		throw new ImportError('bad-raw', `the raw folder for "${type}" is a link or is not a folder; refusing to write raw texts through it`);
	}
}

/** One local-only file with the original texts of a record whose synced copy was redacted. `{ changed }`; nothing is written in a dry run. */
export async function writeRaw(rawDir, type, id, record, { dryRun = false } = {}) {
	const path = rawPath(rawDir, type, id);
	await assertPlainRawFolder(rawDir, type);
	const text = `${JSON.stringify({ type, id, record }, null, '\t')}\n`;
	let current = null;
	try {
		current = await readFile(path, 'utf-8');
	} catch (err) {
		if (err.code !== 'ENOENT') throw err;
	}
	if (current === text) return { changed: false };
	if (dryRun) return { changed: true };
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = join(dirname(path), `.${process.pid}-${Math.random().toString(36).slice(2, 10)}.tmp`);
	try {
		const handle = await open(tmp, 'w', 0o600);
		try {
			await handle.writeFile(text, 'utf-8');
		} finally {
			await handle.close();
		}
		await rename(tmp, path);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
	return { changed: true };
}

/**
 * What a run counts: `applied[kind]` = `{ created, changed, unchanged, failed }` (files), `failures` = count per error
 * code. `attempt(kind, read, write)` reads the current file, writes with the hash it read (or `'new'`), and counts the
 * outcome; a write the store refuses (`changed` since read, `damaged`, `alias-conflict`) is counted and the run goes on,
 * anything else throws.
 */
export function recorder() {
	const applied = {};
	const failures = {};
	const tally = (kind, state) => {
		applied[kind] ??= { created: 0, changed: 0, unchanged: 0, failed: 0 };
		applied[kind][state]++;
	};
	// `snapshotExpect`: the hash the plan was made from (a file whose plan merges what was there). It wins over the hash
	// read now, so a change made in between is refused as `changed` and never replaced from a stale plan.
	const attempt = async (kind, read, write, snapshotExpect) => {
		try {
			const current = await read();
			const result = await write(snapshotExpect ?? (current ? current.hash : 'new'));
			tally(kind, !current ? 'created' : result.changed ? 'changed' : 'unchanged');
		} catch (err) {
			// A held lock is not a refusal of one write: every later write would wait for it too (10 s each). Stop.
			if (!(err instanceof BoardError) || err.code === 'locked') throw err;
			tally(kind, 'failed');
			failures[err.code] = (failures[err.code] ?? 0) + 1;
		}
	};
	return { applied, failures, tally, attempt };
}

/**
 * `{ applied, failures }`: `applied[kind]` = `{ created, changed, unchanged, failed }` (files), `failures` = count per
 * error code. A write the store refuses (`changed` since read, `damaged`) is counted and the run goes on; anything else throws.
 */
export async function applyReference(plan, store, { rawDir, guard } = {}) {
	const dryRun = store.dryRun === true;
	if (!dryRun) {
		if (typeof guard !== 'function' || !rawDir) throw new ImportError('no-guard', 'a real run needs the raw folder and the sync-filter check');
		await guard();
	}
	const { applied, failures, tally, attempt } = recorder();

	for (const r of plan.raw) {
		const result = rawDir ? await writeRaw(rawDir, r.type, r.id, r.record, { dryRun }) : { changed: true }; // a dry run without a raw folder counts them as new
		tally(`raw ${r.type}`, result.changed ? 'created' : 'unchanged');
	}
	for (const team of plan.teams) await attempt('teams', () => store.readTeam(team.key), (expect) => store.writeTeam(team, { expect }));
	for (const cycle of plan.cycles) await attempt('cycles', () => store.readCycle(cycle.team, cycle.number), (expect) => store.writeCycle(cycle, { expect }));
	await attempt('people', () => store.readSingle('people'), (expect) => store.writeSingle('people', plan.people, { expect }));
	await attempt('labels', () => store.readSingle('labels'), (expect) => store.writeSingle('labels', plan.labels, { expect }));
	for (const p of plan.projects) await attempt('projects', () => store.readProject(p.fields.code), (expect) => store.writeProject(p, { expect }));
	for (const d of plan.documents) await attempt('documents', () => store.readDocument(d.fields.id), (expect) => store.writeDocument(d, { expect }));
	await attempt('project-map', () => store.readSingle('project-map'), (expect) => store.writeSingle('project-map', plan.projectMap, { expect }), plan.projectMapExpect);
	return { applied, failures };
}

const pad = (v, n) => String(v).padStart(n);

/** The counts-only report of a run (never a name, title or text): what was read, what each file kind did, what was dangling or flagged. */
export function formatSummary(plan, { applied, failures }, { dryRun }) {
	const c = plan.counts;
	const lines = [dryRun ? 'Reference data import: DRY RUN, nothing written' : 'Reference data import: written'];
	lines.push('read = records in the export; new, changed, same, failed = files (people, labels and the tag map are one file each)');
	lines.push(`${'kind'.padEnd(16)}${pad('read', 6)}${pad(dryRun ? 'new' : 'created', 9)}${pad('changed', 9)}${pad('same', 7)}${pad('failed', 8)}`);
	const row = (label, read, kind) => {
		const a = applied[kind];
		lines.push(`${label.padEnd(16)}${pad(read, 6)}${a ? `${pad(a.created, 9)}${pad(a.changed, 9)}${pad(a.unchanged, 7)}${pad(a.failed, 8)}` : `${pad('-', 9)}${pad('-', 9)}${pad('-', 7)}${pad('-', 8)}`}`);
	};
	row('users (people)', c.read.users, 'people');
	row('teams', c.read.teams, 'teams');
	row('  states', c.read.states, 'none');
	row('cycles', c.read.cycles, 'cycles');
	row('labels', c.read.labels, 'labels');
	row('projects', c.read.projects, 'projects');
	row('  milestones', c.read.milestones, 'none');
	row('  updates', c.read.projectUpdates, 'none');
	row('documents', c.read.documents, 'documents');
	row('tag map', c.tags.total, 'project-map');
	for (const kind of Object.keys(applied).filter((k) => k.startsWith('raw '))) {
		const a = applied[kind];
		lines.push(`${kind.padEnd(16)}${pad('', 6)}${pad(a.created, 9)}${pad('', 9)}${pad(a.unchanged, 7)}`);
	}
	lines.push(`people: ${c.people.matched} matched to a member, ${c.people.unmatched} kept as linear:<first name>, ${c.people.former} former, ${c.people.apps} app`);
	lines.push(`tags: ${c.tags.mapped} of ${c.tags.total} mapped to a project (${c.tags.unmapped} not yet${c.tags.missingProject ? `, ${c.tags.missingProject} point at a project that is not there` : ''})`);
	lines.push(`person data: ${c.flagged.projects} projects, ${c.flagged.documents} documents and ${c.flagged.names} team, state, label or cycle names had text redacted (originals only in the local raw folder)`);
	const dangling = Object.entries(c.dangling);
	lines.push(dangling.length === 0 ? 'dangling references: none' : `dangling references: ${dangling.map(([k, n]) => `${k} ${n}`).join(', ')}`);
	if (c.damagedProjectFiles > 0) lines.push(`damaged project files left alone: ${c.damagedProjectFiles}`);
	const failed = Object.entries(failures);
	if (failed.length > 0) lines.push(`FAILED writes: ${failed.map(([k, n]) => `${k} ${n}`).join(', ')}`);
	return lines.join('\n');
}

/** The fields of an issue file that a later ticket (relations, pull requests, links) owns: a rewrite of the text must not clear them. */
const LATER_FIELDS = ['relations', 'prs', 'links', 'deleted'];

/**
 * Writes an issue plan (`planIssues`) through the store. Raw copies of flagged texts first, then the issues oldest
 * first; every issue is written with the hash of the file it read, so a file somebody changed since is refused
 * (`changed`), not overwritten. A real run asks the guard first, as `applyReference` does.
 *
 * A card that moved teams since an earlier run is the same Linear issue under an older key: its old file is retired in
 * the same step as the new one is written (`moved` counts them) and keeps what a later ticket put in it. A file of any
 * other card with that key is a conflict and is refused.
 *
 * After a real run the promises of the ticket are checked against the files, not the plan: every card is there, every
 * alias opens the card that claims it, and every child's file names its parent and the parent is a card. `checks`
 * counts what held and what did not. A dry run has no files to check.
 */
export async function applyIssues(plan, store, { rawDir, guard } = {}) {
	const dryRun = store.dryRun === true;
	if (!dryRun) {
		if (typeof guard !== 'function' || !rawDir) throw new ImportError('no-guard', 'a real run needs the raw folder and the sync-filter check');
		await guard();
	}
	const { applied, failures, tally, attempt } = recorder();
	let moved = 0;
	for (const r of plan.raw) {
		const result = rawDir ? await writeRaw(rawDir, r.type, r.id, r.record, { dryRun }) : { changed: true };
		tally(`raw ${r.type}`, result.changed ? 'created' : 'unchanged');
	}
	for (const issue of plan.issues) {
		const id = issue.fields.id;
		// An old key whose file is the same Linear issue is the card before its move.
		const old = [];
		for (const alias of issue.fields.aliases ?? []) {
			let found = null;
			try {
				found = await store.readIssue(alias);
			} catch (err) {
				if (!(err instanceof BoardError) || err.code === 'locked') throw err; // a damaged file is no card of ours: the write below will say so
			}
			if (found && found.id === alias && found.fields.linearId === issue.fields.linearId) old.push(found);
		}
		let carried = {};
		await attempt(`issues ${issue.fields.team}`, async () => {
			// `readIssue` also answers for an alias; a card that is somebody else's alias is not this issue's file (the store
			// refuses that write as `alias-conflict` either way; this keeps the other card's hash out of the write).
			const current = await store.readIssue(id);
			const own = current && current.id === id ? current : null;
			carried = {};
			for (const source of [...old, ...(own ? [own] : [])]) for (const k of LATER_FIELDS) if (source.fields[k] !== undefined) carried[k] = source.fields[k];
			return own;
		}, async (expect) => {
			const result = await store.writeIssue({ fields: { ...issue.fields, ...carried }, body: issue.body }, { expect, retire: old.map((o) => o.id) });
			moved += result.retired?.length ?? 0;
			return result;
		});
	}
	const checks = { cardsChecked: 0, cardsMissing: 0, aliasesChecked: 0, aliasesBroken: 0, parentsChecked: 0, parentsBroken: 0 };
	if (!dryRun) {
		// A file the store cannot read (damaged: already counted as a failed write) does not open, so its promise is broken too.
		const open = async (key) => {
			try {
				return await store.readIssue(key);
			} catch (err) {
				if (!(err instanceof BoardError) || err.code === 'locked') throw err;
				return null;
			}
		};
		for (const issue of plan.issues) {
			const card = await open(issue.fields.id);
			checks.cardsChecked++;
			if (!card || card.id !== issue.fields.id) checks.cardsMissing++;
			for (const alias of issue.fields.aliases ?? []) {
				checks.aliasesChecked++;
				const found = await open(alias);
				if (!found || found.id !== issue.fields.id) checks.aliasesBroken++;
			}
			if (issue.fields.parent) {
				checks.parentsChecked++;
				const parent = await open(issue.fields.parent);
				if (!card || card.fields.parent !== issue.fields.parent || !parent) checks.parentsBroken++;
			}
		}
	}
	return { applied, failures, checks, moved };
}

/** The counts-only report of an issue run: per team read and what each file did, aliases, parents, dangling, flagged. Never a title, text or name. */
export function formatIssuesSummary(plan, { applied, failures, checks, moved = 0 }, { dryRun }) {
	const c = plan.counts;
	const lines = [dryRun ? 'Issue import: DRY RUN, nothing written' : 'Issue import: written'];
	lines.push(`read = issues in the export; ${dryRun ? 'new' : 'created'}, changed, same, failed = files`);
	lines.push(`${'team'.padEnd(8)}${pad('read', 6)}${pad(dryRun ? 'new' : 'created', 9)}${pad('changed', 9)}${pad('same', 7)}${pad('failed', 8)}${pad('archived', 10)}`);
	for (const team of Object.keys(c.byTeam).sort()) {
		const t = c.byTeam[team];
		const a = applied[`issues ${team}`];
		lines.push(`${team.padEnd(8)}${pad(t.read, 6)}${a ? `${pad(a.created, 9)}${pad(a.changed, 9)}${pad(a.unchanged, 7)}${pad(a.failed, 8)}` : `${pad('-', 9)}${pad('-', 9)}${pad('-', 7)}${pad('-', 8)}`}${pad(t.archived, 10)}`);
	}
	lines.push(`${'all'.padEnd(8)}${pad(c.read, 6)}`);
	lines.push(`aliases: ${c.aliases.issues} issues carry ${c.aliases.total} earlier keys${c.aliases.conflicts ? `; ${c.aliases.conflicts} NOT KEPT (a key that is another issue's real key, or that an older issue already claims)` : ''}`);
	if (moved > 0) lines.push(`moved: ${moved} cards had an earlier file under an old key (same Linear issue); ${dryRun ? 'would be' : 'it is'} retired and the old key kept as an alias`);
	if (checks && checks.cardsChecked > 0) {
		lines.push(`checked on the files: ${checks.cardsChecked - checks.cardsMissing} of ${checks.cardsChecked} cards present, ${checks.aliasesChecked - checks.aliasesBroken} of ${checks.aliasesChecked} aliases open their card, ${checks.parentsChecked - checks.parentsBroken} of ${checks.parentsChecked} children name their parent and the parent is a card`);
	}
	lines.push(`parents: ${c.parents} issues have a parent`);
	lines.push(`person data: ${c.flagged} issues had a title, description or branch name redacted or left out (originals only in the local raw folder; ${c.branchesLeftOut} branch names left out)`);
	const dangling = Object.entries(c.dangling);
	lines.push(dangling.length === 0 ? 'dangling references: none' : `dangling references: ${dangling.map(([k, n]) => `${k} ${n}`).join(', ')}`);
	const failed = Object.entries(failures);
	if (failed.length > 0) lines.push(`FAILED writes: ${failed.map(([k, n]) => `${k} ${n}`).join(', ')}`);
	return lines.join('\n');
}
