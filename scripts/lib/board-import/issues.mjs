import { PersonDataReport, parseId, redactValue } from '../board/index.mjs';
import { ImportError, SOURCE } from './reference.mjs';

/**
 * The issues of the Linear import (ticket A5): state, project, milestone, cycle, parent, labels, estimate, branch, dates,
 * and every earlier key as an alias. Relations, pull requests, links and comments are A6. One pure step, like A4's:
 *
 *   planIssues(entities, reference)   what each issue file should say, plus counts (no file is touched)
 *   applyIssues (apply.mjs)           writes the plan through the store
 *
 * `reference` is the plan `planReference` made from the same export: people, project codes, label names and cycles come
 * from it, so an issue and the reference files always agree, whether or not A4 has been applied yet.
 *
 * Rule A (as in A4): title and description are typed text. An outside e-mail address or phone number is redacted in the
 * synced file; when a text was changed the original goes to the local-only `raw/issues/<KEY>.json`, written first.
 * Nothing here has a time of its own, so a second run writes the same bytes and changes no file.
 *
 * The branch name Linear makes from the title is typed text too (`me/pse-1-call-pat-on-555-010-0199`), and a number glued
 * to words by hyphens is not found by the scan. So it is left out of the synced file when the title was redacted, or when
 * it reads as flagged once its hyphens are spaces; the original is kept in the raw record.
 *
 * An earlier key that is another issue's real key is not kept (the real card wins), and one that two issues claim stays
 * with the older issue: the store would refuse both writes, and the dry run must show what a real run does.
 */

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function compact(object) {
	const out = {};
	for (const [key, value] of Object.entries(object)) if (value !== undefined && value !== null) out[key] = value;
	return out;
}

/** Linear's priority is 0 to 4; anything else it may allow is kept as text, never dropped. */
export function boardPriority(value) {
	if (value === undefined || value === null) return undefined;
	return Number.isInteger(value) && value >= 0 && value <= 4 ? value : String(value);
}

/** An estimate is a number; a value that is not one is kept as text, never dropped. */
export function boardEstimate(value) {
	if (value === undefined || value === null) return undefined;
	return typeof value === 'number' && Number.isFinite(value) ? value : String(value);
}

const own = (map, key) => (typeof key === 'string' && map.has(key) ? map.get(key) : undefined);

/**
 * @param {Record<string, object[]>} entities  what `readExport` returned (issues, states, milestones, cycles, ...)
 * @param {{people: {people: object}, projects: {fields: object}[], labels: {labels: object[]}, cycles: object[]}} reference
 *        the result of `planReference` for the same export
 * @returns {{issues: {fields: object, body: string}[], raw: object[], counts: object, report: PersonDataReport}}
 */
export function planIssues(entities, reference) {
	if (!reference || typeof reference.people?.people !== 'object' || reference.people.people === null || !Array.isArray(reference.projects) || !Array.isArray(reference.labels?.labels) || !Array.isArray(reference.cycles)) {
		throw new ImportError('no-reference', 'the issue plan needs the reference plan of the same export');
	}
	const get = (type) => entities[type] ?? [];
	const issues = get('issues');
	const report = new PersonDataReport();
	const raw = [];
	const counts = {
		read: issues.length,
		byTeam: {},
		dangling: {},
		flagged: 0,
		aliases: { issues: 0, total: 0, conflicts: 0 },
		parents: 0,
		archived: 0,
		branchesLeftOut: 0,
	};
	const dangle = (what) => {
		counts.dangling[what] = (counts.dangling[what] ?? 0) + 1;
	};
	const team = (key) => (counts.byTeam[key] ??= { read: 0, archived: 0, withAliases: 0, flagged: 0 });

	const stateById = new Map(get('states').map((s) => [s.id, s]));
	const milestoneById = new Map(get('milestones').map((m) => [m.id, m]));
	const cycleById = new Map(get('cycles').map((c) => [c.id, c]));
	const teamKeys = new Set(get('teams').map((t) => t.key));
	const keyByIssueId = new Map(issues.map((i) => [i.id, i.key]));
	const codeByProjectId = new Map(reference.projects.filter((p) => typeof p.fields.linearId === 'string').map((p) => [p.fields.linearId, p.fields.code]));
	const labelNameById = new Map(reference.labels.labels.map((l) => [l.id, l.name]));
	const cycleIdsWritten = new Set(reference.cycles.map((c) => c.linearId));
	const personName = (id, what) => {
		if (id === undefined || id === null) return undefined;
		const entry = Object.hasOwn(reference.people.people, id) ? reference.people.people[id] : undefined;
		if (!entry) dangle(what);
		return entry?.name;
	};

	const keys = new Set(issues.map((i) => i.key));
	const when = (issue) => Date.parse(issue.createdAt); // an instant, not a string: offsets may differ
	const planned = [];
	for (const issue of [...issues].sort((a, b) => (when(a) - when(b)) || cmp(String(a.createdAt), String(b.createdAt)) || cmp(a.teamKey, b.teamKey) || a.number - b.number || cmp(a.key, b.key))) {
		const t = team(issue.teamKey);
		t.read++;
		if (!teamKeys.has(issue.teamKey)) dangle('issues.team');

		let flagged = false;
		const red = (value) => {
			const r = redactValue(value);
			if (r.flagged) flagged = true;
			return r.value;
		};
		// The names of states and milestones are shared texts: A4 already redacted them and kept their originals; here they
		// only have to read the same, and they do not make an issue "flagged".
		const shared = (value) => redactValue(value).value;
		const titleRedacted = redactValue(issue.title);
		const title = red(issue.title);
		const body = red(issue.description ?? '');
		report.add(issue.teamKey, 'title', issue.title);
		if (typeof issue.description === 'string') report.add(issue.teamKey, 'description', issue.description);

		const state = own(stateById, issue.stateId);
		if (!state) dangle('issues.state');
		let project;
		if (issue.projectId !== undefined && issue.projectId !== null) {
			project = own(codeByProjectId, issue.projectId);
			if (!project) dangle('issues.project');
		}
		let milestone;
		if (issue.milestoneId !== undefined && issue.milestoneId !== null) {
			const m = own(milestoneById, issue.milestoneId);
			if (m) milestone = shared(m.name);
			else dangle('issues.milestone');
		}
		let cycle;
		if (issue.cycleId !== undefined && issue.cycleId !== null) {
			const c = own(cycleById, issue.cycleId);
			if (c && cycleIdsWritten.has(c.id)) cycle = `${c.teamKey}-${c.number}`;
			else dangle('issues.cycle');
		}
		let parent;
		if (issue.parentId !== undefined && issue.parentId !== null) {
			const key = own(keyByIssueId, issue.parentId);
			if (key && key !== issue.key) {
				parent = key;
				counts.parents++;
			} else dangle('issues.parent');
		}
		const labels = [];
		for (const id of issue.labelIds ?? []) {
			const name = own(labelNameById, id);
			if (name === undefined) dangle('issues.label');
			else labels.push(name); // the reference plan's label names are redacted already
		}
		const aliases = [];
		for (const a of issue.previousKeys ?? []) {
			if (a === issue.key || aliases.includes(a)) continue;
			if (!parseId(a)) {
				dangle('issues.alias');
				continue;
			}
			aliases.push(a);
		}
		let branch = issue.branchName ?? undefined;
		let branchOriginal;
		if (typeof branch === 'string' && (titleRedacted.flagged || redactValue(branch.replace(/[-_/]+/g, ' ')).flagged)) {
			branchOriginal = branch;
			branch = undefined;
			flagged = true;
			counts.branchesLeftOut++;
		}
		if (issue.archivedAt) {
			counts.archived++;
			t.archived++;
		}
		if (flagged) {
			counts.flagged++;
			t.flagged++;
			raw.push({ type: 'issues', id: issue.key, record: { title: issue.title, description: issue.description ?? null, ...(branchOriginal === undefined ? {} : { branch: branchOriginal }) } });
		}
		planned.push({
			fields: compact({
				id: issue.key,
				aliases: undefined, // set below, once every issue's candidates are known

				linearId: issue.id,
				team: issue.teamKey,
				title,
				status: state?.name === undefined ? undefined : shared(state.name),
				statusType: state?.type,
				priority: boardPriority(issue.priority),
				assignee: personName(issue.assigneeId, 'issues.assignee'),
				creator: personName(issue.creatorId, 'issues.creator'),
				project,
				milestone,
				cycle,
				parent,
				labels: labels.length > 0 ? labels.sort(cmp) : undefined,
				estimate: boardEstimate(issue.estimate),
				dueDate: issue.dueDate,
				branch,
				created: issue.createdAt,
				updated: issue.updatedAt,
				started: issue.startedAt,
				completed: issue.completedAt,
				canceled: issue.canceledAt,
				archived: issue.archivedAt,
				source: SOURCE,
			}),
			body,
			candidates: aliases,
		});
	}

	// Earlier keys, oldest issue first: a real key is never an alias, and a key two issues claim stays with the older one.
	const owner = new Map();
	for (const p of planned) {
		const kept = [];
		for (const a of p.candidates) {
			if (keys.has(a) || (owner.has(a) && owner.get(a) !== p.fields.id)) {
				counts.aliases.conflicts++;
				continue;
			}
			owner.set(a, p.fields.id);
			kept.push(a);
		}
		delete p.candidates;
		if (kept.length > 0) {
			p.fields.aliases = kept.sort(cmp);
			counts.aliases.issues++;
			counts.aliases.total += kept.length;
			team(p.fields.team).withAliases++;
		}
	}
	return { issues: planned, raw, counts, report };
}
