import { BoardError, PersonDataReport, assertDocumentId, isProjectCode, redactText, redactValue, scanText } from '../board/index.mjs';

/**
 * Reference data of the Linear import (ticket A4): users, teams and workflow states, labels, cycles, projects with
 * milestones and updates, documents. Two steps, so the first one can be tested and run without touching a file:
 *
 *   planReference(entities, options)   pure: what the board files should say, plus counts
 *   applyReference(plan, store, opts)  writes the plan through the store (a store made with `dryRun` writes nothing)
 *
 * Rule A (Van, 2026-11-12): no outside e-mail address or phone number reaches a synced file. Every text that goes
 * into one is redacted first (`[email]`, `[phone]`); when a text was changed, the original goes to the local-only
 * `raw/` folder, written before the synced file. Reports hold counts and names of kinds, never a value.
 *
 * Nothing here has a time of its own: running the same export twice writes the same bytes, so a second run changes
 * no file. `source` says `linear`, nothing more.
 */

export const DEFAULT_TAGS = ['renewals', 'ops', 'sensor', 'pollen-wise', 'airevoSite', 'teamos', 'triage'];
export const PEOPLE_VERSION = 1;
export const SOURCE = { system: 'linear' };

/** Error with a stable `code`; the message never holds a record value. */
export class ImportError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'ImportError';
		this.code = code;
	}
}

function compact(object) {
	const out = {};
	for (const [key, value] of Object.entries(object)) if (value !== undefined && value !== null) out[key] = value;
	return out;
}

/** Plain code-unit order: the same on every machine (localeCompare depends on the ICU data and the locale). */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byDateThenId = (a, b) => cmp(String(a.createdAt ?? ''), String(b.createdAt ?? '')) || cmp(String(a.id), String(b.id));

/** `Renewals automation (2026)` becomes `renewals-automation-2026`: a project's file name (letters, digits, `-`; at most 60). */
export function slugify(text) {
	const slug = String(text ?? '')
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+/, '')
		.slice(0, 60)
		.replace(/-+$/, '');
	return slug === '' ? 'project' : slug;
}

function uniqueCode(base, taken) {
	let code = base;
	for (let n = 2; taken.has(code.toLowerCase()); n++) code = `${base.slice(0, 55)}-${n}`;
	taken.add(code.toLowerCase());
	return code;
}

/** First word of a name, letters and digits only; an address or phone-shaped word becomes `unknown`. */
function firstName(user) {
	const source = typeof user.name === 'string' && user.name.trim() !== '' ? user.name : user.displayName;
	const token = String(source ?? '').trim().split(/\s+/)[0] ?? '';
	// the whole name is scanned too: `+1 555 010 0199` has the harmless first word `+1`
	if (token.includes('@') || scanText(token).flagged || scanText(String(source ?? '')).flagged) return 'unknown';
	const clean = token.replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 30);
	return clean === '' ? 'unknown' : clean;
}

// ─── People ─────────────────────────────────────────────────────────────────────

/**
 * Linear users to board names (design 2.5): a TeamOS member's name when the e-mail matches (compared in memory, never
 * written), otherwise `linear:<first name>`. An inactive user is `former: true`, matched or not (Van `bt5a`); an app
 * user is `app: true`. Disabled users stay in the file, so old issues still show an assignee.
 * `overrides` maps a Linear user id to a member name for the user whose address differs between the two systems.
 */
export function buildPeople(users, members, overrides = {}) {
	// An entry that is not a member with a name (`null`, a bare string) is a wrong file, not an empty list.
	for (const m of members) {
		if (m === null || typeof m !== 'object' || typeof m.name !== 'string' || m.name === '') throw new ImportError('bad-members', 'members.json has an entry that is not a member with a name');
	}
	const memberNames = new Set(members.map((m) => m.name));
	const byEmail = new Map();
	for (const m of members) {
		if (typeof m.email === 'string' && m.email.trim() !== '' && !byEmail.has(m.email.trim().toLowerCase())) byEmail.set(m.email.trim().toLowerCase(), m.name);
	}
	for (const member of Object.values(overrides)) {
		if (!memberNames.has(member)) throw new ImportError('bad-override', 'a people override names a member that is not in members.json');
	}
	const entries = [];
	const used = new Set();
	const counts = { matched: 0, unmatched: 0, former: 0, apps: 0 };
	for (const user of [...users].sort(byDateThenId)) {
		const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
		let name = Object.hasOwn(overrides, user.id) ? overrides[user.id] : email === '' ? undefined : byEmail.get(email);
		if (name !== undefined) counts.matched++;
		else {
			counts.unmatched++;
			const base = `linear:${firstName(user)}`;
			name = base;
			for (let n = 2; used.has(name); n++) name = `${base}#${n}`;
			used.add(name);
		}
		if (user.active === false) counts.former++;
		if (user.app === true) counts.apps++;
		entries.push([user.id, compact({ name, former: user.active === false ? true : undefined, app: user.app === true ? true : undefined })]);
	}
	const sorted = Object.fromEntries(entries.sort(([a], [b]) => cmp(a, b))); // fromEntries: an id such as `constructor` or `__proto__` is just a key
	return { file: { version: PEOPLE_VERSION, people: sorted }, counts };
}

// ─── The plan ───────────────────────────────────────────────────────────────────

function group(list, key) {
	const map = new Map();
	for (const item of list) {
		const k = item[key];
		if (!map.has(k)) map.set(k, []);
		map.get(k).push(item);
	}
	return map;
}

/**
 * What an earlier run left in the board, read from the store: the project codes already given (kept for ever, even
 * when the project is renamed in Linear) and the hand-editable `project-map.json`.
 */
export async function loadExisting(store) {
	const codeByLinearId = new Map();
	const taken = new Set();
	let damaged = 0;
	for (const code of await store.listProjects()) {
		let project;
		try {
			project = await store.readProject(code);
		} catch (err) {
			if (!(err instanceof BoardError) || err.code !== 'damaged') throw err;
			damaged++; // not taken: a project that lands on this name will try it, fail as `damaged` and be counted; the file is never overwritten
			continue;
		}
		taken.add(code.toLowerCase());
		const id = project?.fields?.linearId;
		if (typeof id === 'string') codeByLinearId.set(id, code);
	}
	const map = await store.readSingle('project-map');
	// `projectMapHash` is the hash of the file this snapshot came from ('new' when there is none): the write of the plan
	// expects exactly it, so a hand edit made after the snapshot is refused (changed), not silently replaced.
	return { codeByLinearId, taken, projectMap: map?.data ?? null, projectMapHash: map ? map.hash : 'new', damaged };
}

/**
 * Turns the export's reference types into the board files they become. `entities` is what `readExport` returned.
 * `members` is `members.json`'s list (`name`, `email`). `existing` is `loadExisting`'s answer (or empty).
 * Returns `{ people, teams, cycles, labels, projects, documents, projectMap, projectMapExpect, raw, counts, report }`
 * (`projectMapExpect` is the hash of the project-map file the plan was made from); `counts` are
 * numbers by kind (read, dangling, flagged), `report` is a `PersonDataReport` (texts per kind and team).
 */
export function planReference(entities, { members = [], overrides = {}, tags = DEFAULT_TAGS, tagHints = {}, existing } = {}) {
	const ex = existing ?? { codeByLinearId: new Map(), taken: new Set(), projectMap: null };
	const get = (type) => entities[type] ?? [];
	const counts = {
		read: Object.fromEntries(['users', 'teams', 'states', 'labels', 'cycles', 'projects', 'milestones', 'projectUpdates', 'documents'].map((t) => [t, get(t).length])),
		dangling: {},
		flagged: { projects: 0, documents: 0, names: 0 },
		damagedProjectFiles: ex.damaged ?? 0,
	};
	const dangle = (what) => {
		counts.dangling[what] = (counts.dangling[what] ?? 0) + 1;
	};
	const report = new PersonDataReport();
	const raw = [];
	// Names of teams, states, labels and cycles are typed text too (rule A): redacted in the synced file, the
	// original in the local raw folder (one record, `names/reference.json`).
	const flaggedNames = [];
	const nameOf = (kind, id, value) => {
		if (typeof value !== 'string') return value;
		report.add('none', 'name', value);
		const r = redactValue(value);
		if (r.flagged) flaggedNames.push({ kind, id, name: value });
		return r.value;
	};

	const { file: people, counts: peopleCounts } = buildPeople(get('users'), members, overrides);
	counts.people = peopleCounts;
	const personName = (id, what) => {
		if (id === undefined || id === null) return undefined;
		const entry = Object.hasOwn(people.people, id) ? people.people[id] : undefined;
		if (!entry) dangle(what);
		return entry?.name;
	};

	// teams and workflow states
	const teamKeys = new Set(get('teams').map((t) => t.key));
	if (teamKeys.size !== get('teams').length) throw new ImportError('duplicate', 'two teams in the export have the same key; one would overwrite the other');
	const statesByTeam = group(get('states'), 'teamKey');
	for (const key of statesByTeam.keys()) if (!teamKeys.has(key)) for (let i = 0; i < statesByTeam.get(key).length; i++) dangle('states.team');
	const teams = [...get('teams')].sort((a, b) => cmp(String(a.key), String(b.key))).map((t) => {
		const states = (statesByTeam.get(t.key) ?? [])
			.slice()
			.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || cmp(String(a.name), String(b.name)) || cmp(String(a.id), String(b.id)))
			.map((s) => compact({ id: s.id, name: nameOf('state', s.id, s.name), type: s.type, position: s.position, archived: s.archivedAt }));
		return compact({
			key: t.key,
			name: nameOf('team', t.id, t.name),
			linearId: t.id,
			native: false,
			private: t.private === true ? true : undefined,
			archived: t.archivedAt,
			states,
			cycles: compact({ enabled: t.cyclesEnabled === true, duration: t.cycleDuration }),
			source: SOURCE,
		});
	});

	// cycles
	const cycles = [];
	const cycleSeen = new Set();
	for (const c of [...get('cycles')].sort((a, b) => cmp(String(a.teamKey), String(b.teamKey)) || a.number - b.number)) {
		if (!teamKeys.has(c.teamKey)) {
			dangle('cycles.team');
			continue;
		}
		const cycleKey = `${c.teamKey}#${c.number}`;
		if (cycleSeen.has(cycleKey)) throw new ImportError('duplicate', 'two cycles in the export have the same team and number; one would overwrite the other');
		cycleSeen.add(cycleKey);
		cycles.push(compact({ number: c.number, team: c.teamKey, name: nameOf('cycle', c.id, c.name), startsAt: c.startsAt, endsAt: c.endsAt, completed: c.completedAt, linearId: c.id, source: SOURCE }));
	}

	// labels: a label in a group is `group/name`
	const labelById = new Map(get('labels').map((l) => [l.id, l]));
	const labels = get('labels')
		.map((l) => {
			let name = l.name;
			if (l.parentId !== undefined && l.parentId !== null) {
				const parent = labelById.get(l.parentId);
				if (parent) name = `${parent.name}/${l.name}`;
				else dangle('labels.parent');
			}
			if (l.teamKey && !teamKeys.has(l.teamKey)) dangle('labels.team');
			return compact({ id: l.id, name: nameOf('label', l.id, name), team: l.teamKey, group: l.isGroup === true ? true : undefined, retired: l.retiredAt });
		})
		.sort((a, b) => cmp(a.name, b.name) || cmp(String(a.id), String(b.id)));

	// projects with milestones and updates
	const milestonesByProject = group(get('milestones'), 'projectId');
	const updatesByProject = group(get('projectUpdates'), 'projectId');
	const projectIds = new Set(get('projects').map((p) => p.id));
	for (const pid of milestonesByProject.keys()) if (!projectIds.has(pid)) for (let i = 0; i < milestonesByProject.get(pid).length; i++) dangle('milestones.project');
	for (const pid of updatesByProject.keys()) if (!projectIds.has(pid)) for (let i = 0; i < updatesByProject.get(pid).length; i++) dangle('projectUpdates.project');

	const taken = new Set(ex.taken);
	const codeOf = new Map();
	const projects = [];
	const hintNames = []; // [original project name, code]: only for matching --tag-hints, in memory, never written
	for (const p of [...get('projects')].sort(byDateThenId)) {
		const teamsOfProject = p.teamKeys.filter((k) => {
			if (teamKeys.has(k)) return true;
			dangle('projects.team');
			return false;
		});
		const lead = personName(p.leadId, 'projects.lead');
		// Only the words a person typed go through the scan; ids, dates and codes are not text.
		let flagged = false;
		const red = (value) => {
			const r = redactValue(value);
			if (r.flagged) flagged = true;
			return r.value;
		};
		const team = teamsOfProject[0] ?? 'none';
		const milestoneRecords = (milestonesByProject.get(p.id) ?? [])
			.slice()
			.sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity) || cmp(String(a.name), String(b.name)) || cmp(String(a.id), String(b.id)));
		const updateRecords = (updatesByProject.get(p.id) ?? []).slice().sort(byDateThenId);
		const milestones = milestoneRecords.map((m) => compact({ id: m.id, name: red(m.name), description: red(m.description), targetDate: m.targetDate }));
		const updates = updateRecords.map((u) => compact({ id: u.id, createdAt: u.createdAt, health: u.health, author: personName(u.authorId, 'projectUpdates.author'), body: red(u.body) }));
		const body = red([p.description, p.content].filter((s) => typeof s === 'string' && s.trim() !== '').join('\n\n'));
		const name = red(p.name);
		const status = red(p.status);
		report.add(team, 'project', [p.name, p.status, p.description, p.content]);
		for (const m of milestoneRecords) report.add(team, 'milestone', [m.name, m.description]);
		for (const u of updateRecords) report.add(team, 'update', u.body);
		const known = ex.codeByLinearId.get(p.id);
		const code = known ?? uniqueCode(slugify(redactText(p.name).text), taken);
		if (known) taken.add(known.toLowerCase());
		codeOf.set(p.id, code);
		hintNames.push([p.name, code]);
		const fields = compact({
			code,
			name,
			linearId: p.id,
			teams: teamsOfProject,
			status,
			statusType: p.statusType,
			lead,
			startDate: p.startDate,
			targetDate: p.targetDate,
			milestones,
			updates,
			created: p.createdAt,
			archived: p.archivedAt,
			completed: p.completedAt,
			canceled: p.canceledAt,
			source: SOURCE,
		});
		if (flagged) {
			counts.flagged.projects++;
			raw.push({ type: 'projects', id: code, record: { project: p, milestones: milestoneRecords, updates: updateRecords } });
		}
		projects.push({ fields, body });
	}
	for (const p of projects) {
		if (!isProjectCode(p.fields.code)) throw new ImportError('bad-code', 'a project code is not letters, digits, _ or -');
	}

	// documents: read-only text, under the project they belong to (below: the names record)
	const documents = [];
	for (const d of [...get('documents')].sort((a, b) => cmp(String(a.id), String(b.id)))) {
		try {
			assertDocumentId(d.id);
		} catch (err) {
			if (!(err instanceof BoardError)) throw err;
			dangle('documents.id');
			continue;
		}
		let project;
		if (d.projectId !== undefined && d.projectId !== null) {
			project = codeOf.get(d.projectId);
			if (!project) dangle('documents.project');
		}
		const title = redactValue(d.title);
		const body = redactValue(d.content ?? '');
		report.add('none', 'document', [d.title, d.content]);
		if (title.flagged || body.flagged) {
			counts.flagged.documents++;
			raw.push({ type: 'documents', id: d.id, record: { document: d } });
		}
		documents.push({ fields: compact({ id: d.id, linearId: d.id, title: title.value, project, issue: d.issueKey, created: d.createdAt, updated: d.updatedAt, source: SOURCE }), body: body.value });
	}

	// message tags to board projects: an entry that is already set is never changed (it may be a hand edit)
	const codes = new Set(projects.map((p) => p.fields.code));
	// A hint names the project as it is in Linear, so match the original name; the stored name may have been redacted.
	const codeByName = new Map();
	for (const [name, code] of hintNames) if (typeof name === 'string') codeByName.set(name.toLowerCase(), code);
	for (const p of projects) if (!codeByName.has(String(p.fields.name).toLowerCase())) codeByName.set(String(p.fields.name).toLowerCase(), p.fields.code);
	const previous = ex.projectMap?.tags && typeof ex.projectMap.tags === 'object' ? ex.projectMap.tags : {};
	const mapTags = { ...previous };
	for (const tag of tags) {
		if (typeof mapTags[tag] === 'string') continue;
		const hinted = typeof tagHints[tag] === 'string' ? codeByName.get(tagHints[tag].toLowerCase()) : undefined;
		const bySlug = [...codes].find((c) => c.toLowerCase() === slugify(tag));
		mapTags[tag] = hinted ?? bySlug ?? null;
	}
	const projectMap = { version: 1, tags: Object.fromEntries(Object.entries(mapTags).sort(([a], [b]) => cmp(a, b))) };
	counts.tags = { total: Object.keys(projectMap.tags).length, mapped: Object.values(projectMap.tags).filter((v) => typeof v === 'string').length };
	counts.tags.unmapped = counts.tags.total - counts.tags.mapped;
	counts.tags.missingProject = Object.values(projectMap.tags).filter((v) => typeof v === 'string' && !codes.has(v)).length;

	counts.flagged.names = flaggedNames.length;
	if (flaggedNames.length > 0) {
		flaggedNames.sort((a, b) => cmp(a.kind, b.kind) || cmp(String(a.id), String(b.id)));
		raw.push({ type: 'names', id: 'reference', record: { names: flaggedNames } });
	}

	return { people: people, teams, cycles, labels: { version: 1, labels }, projects, documents, projectMap, projectMapExpect: ex.projectMapHash, raw, counts, report };
}
