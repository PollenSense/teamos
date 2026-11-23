/**
 * Read a Linear workspace into the records of the board export format (`../board-export/format.mjs`).
 *
 * `pageAll` follows cursors with strict rules (an error is better than a silent short read): a page with
 * fewer nodes than the page size is normal and ends nothing by itself; only `hasNextPage` decides. A
 * `hasNextPage: true` with a missing, empty, repeated or non-advancing cursor stops the run. A nested list
 * (a project's milestones, an issue's labels) that has more than one page also stops it.
 *
 * `fetchWorkspace` returns records and counts; it writes nothing. The caller writes the export folder only
 * when the whole read succeeded, so a run that stops on a budget or an error leaves no half export.
 */

import { FetchError } from './client.mjs';
import { DOCUMENTS } from './documents.mjs';

/** The export types this fetcher can produce, in the order they are read. */
export const FETCH_TYPES = Object.freeze([
	'teams', 'states', 'users', 'labels', 'cycles', 'projects', 'milestones', 'projectUpdates',
	'documents', 'issues', 'comments', 'relations', 'attachments',
]);

const MAX_PAGES = 5000;

function dig(data, path) {
	let cur = data;
	for (const step of path) {
		if (cur === null || typeof cur !== 'object') return undefined;
		cur = cur[step];
	}
	return cur;
}

/** Read every page of a connection. Returns the nodes of all pages, in order. */
export async function pageAll(client, name, variables = {}, { maxPages = MAX_PAGES } = {}) {
	const spec = DOCUMENTS[name];
	if (!spec || spec.size === 0) throw new FetchError('document-not-allowed', `"${String(name).slice(0, 40)}" is not a paged document`);
	const nodes = [];
	const seen = new Set();
	let after = null;
	for (let page = 1; page <= maxPages; page++) {
		const data = await client.run(name, { ...variables, after });
		const conn = dig(data, spec.path);
		if (conn === null || typeof conn !== 'object' || !Array.isArray(conn.nodes) || conn.pageInfo === null || typeof conn.pageInfo !== 'object') {
			throw new FetchError('bad-response', `${name}: page ${page} has no nodes or no pageInfo`);
		}
		if (typeof conn.pageInfo.hasNextPage !== 'boolean') {
			throw new FetchError('bad-response', `${name}: page ${page} has no true or false "hasNextPage"; stopped (${nodes.length} records read, nothing written)`);
		}
		for (const node of conn.nodes) {
			if (node === null || typeof node !== 'object' || Array.isArray(node)) throw new FetchError('bad-response', `${name}: page ${page} has a record that is not an object`);
			nodes.push(node);
		}
		if (conn.pageInfo.hasNextPage !== true) return nodes;
		const cursor = conn.pageInfo.endCursor;
		if (typeof cursor !== 'string' || cursor === '' || seen.has(cursor)) {
			throw new FetchError('cursor', `${name}: page ${page} says there is a next page but gives no new cursor; stopped (${nodes.length} records read, nothing written)`);
		}
		seen.add(cursor);
		after = cursor;
	}
	throw new FetchError('too-many-pages', `${name}: more than ${maxPages} pages; stopped`);
}

function nestedNodes(connection, name, what) {
	// A connection that is missing or null is not an empty list: an answer without it would otherwise read as "no
	// labels" or "no teams" and be written into the export as fact. Only `nodes: []` (and no next page) is empty.
	if (connection === null || connection === undefined || typeof connection !== 'object') throw new FetchError('bad-response', `${name}: ${what} is missing from the answer`);
	if (!Array.isArray(connection.nodes)) throw new FetchError('bad-response', `${name}: ${what} has no node list`);
	if (connection.nodes.some((n) => n === null || typeof n !== 'object' || Array.isArray(n))) throw new FetchError('bad-response', `${name}: ${what} has a record that is not an object`);
	if (typeof connection.pageInfo?.hasNextPage !== 'boolean') throw new FetchError('bad-response', `${name}: ${what} has no true or false "hasNextPage"`);
	if (connection.pageInfo.hasNextPage === true) {
		throw new FetchError('nested-truncated', `${name}: a nested list (${what}) has more items than one page; the fetcher cannot read it whole; stopped`);
	}
	return connection.nodes;
}

const id = (node) => node?.id ?? null;

const MAPPERS = {
	teams: (n) => ({ id: n.id, key: n.key, name: n.name, private: n.private, archivedAt: n.archivedAt ?? null, cyclesEnabled: n.cyclesEnabled, cycleDuration: n.cycleDuration ?? null }),
	states: (n) => ({ id: n.id, name: n.name, type: n.type, teamKey: n.team?.key ?? null, archivedAt: n.archivedAt ?? null, position: n.position ?? null }),
	users: (n) => ({ id: n.id, name: n.name, displayName: n.displayName ?? null, email: n.email ?? null, active: n.active, app: n.app, admin: n.admin, guest: n.guest, createdAt: n.createdAt ?? null }),
	labels: (n) => ({ id: n.id, name: n.name, teamKey: n.team?.key ?? null, parentId: id(n.parent), isGroup: n.isGroup, retiredAt: n.retiredAt ?? null }),
	cycles: (n) => ({ id: n.id, teamKey: n.team?.key ?? null, number: n.number, name: n.name ?? null, startsAt: n.startsAt, endsAt: n.endsAt, completedAt: n.completedAt ?? null }),
	projectUpdates: (n) => (n.project?.id ? { id: n.id, projectId: n.project.id, body: n.body, health: n.health ?? null, authorId: id(n.user), createdAt: n.createdAt } : null),
	documents: (n) => ({ id: n.id, title: n.title, content: n.content ?? null, projectId: id(n.project), issueKey: n.issue?.identifier ?? null, createdAt: n.createdAt ?? null, updatedAt: n.updatedAt ?? null }),
	comments: (n) => {
		const documentId = n.documentContent?.document?.id ?? null;
		const issueKey = n.issue?.identifier ?? null;
		const projectUpdateId = id(n.projectUpdate);
		const projectId = id(n.project);
		if (issueKey === null && projectUpdateId === null && documentId === null && projectId === null) return null;
		return { id: n.id, issueKey, projectUpdateId, documentId, projectId, parentId: id(n.parent), body: n.body, createdAt: n.createdAt, updatedAt: n.updatedAt ?? null, authorId: id(n.user), botName: n.botActor?.name ?? null, externalUserName: n.externalUser?.name ?? null };
	},
	relations: (n) => (n.issue?.identifier && n.relatedIssue?.identifier ? { id: n.id, type: n.type, issueKey: n.issue.identifier, relatedIssueKey: n.relatedIssue.identifier } : null),
	attachments: (n) => (n.issue?.identifier ? { id: n.id, issueKey: n.issue.identifier, sourceType: n.sourceType ?? null, url: n.url, title: n.title ?? null, subtitle: n.subtitle ?? null, metadata: n.metadata ?? null, createdAt: n.createdAt ?? null } : null),
};

function mapIssue(n, name) {
	return {
		id: n.id, key: n.identifier, teamKey: n.team?.key ?? null, number: n.number, title: n.title, description: n.description ?? null,
		priority: n.priority ?? null, estimate: n.estimate ?? null, dueDate: n.dueDate ?? null, createdAt: n.createdAt, updatedAt: n.updatedAt ?? null,
		archivedAt: n.archivedAt ?? null, completedAt: n.completedAt ?? null, canceledAt: n.canceledAt ?? null, startedAt: n.startedAt ?? null,
		stateId: id(n.state), projectId: id(n.project), milestoneId: id(n.projectMilestone), cycleId: id(n.cycle), parentId: id(n.parent),
		assigneeId: id(n.assignee), creatorId: id(n.creator),
		labelIds: nestedNodes(n.labels, name, 'issue labels').map((l) => l.id),
		previousKeys: Array.isArray(n.previousIdentifiers) ? n.previousIdentifiers : [],
		branchName: n.branchName ?? null,
	};
}

function mapProject(n, name) {
	const milestones = nestedNodes(n.projectMilestones, name, 'project milestones').map((m) => ({
		id: m.id, projectId: n.id, name: m.name, description: m.description ?? null, targetDate: m.targetDate ?? null, sortOrder: m.sortOrder ?? null,
	}));
	const project = {
		id: n.id, name: n.name, description: n.description ?? null, content: n.content ?? null, status: n.status?.name ?? null, statusType: n.status?.type ?? null,
		leadId: id(n.lead), teamKeys: nestedNodes(n.teams, name, 'project teams').map((t) => t.key), startDate: n.startDate ?? null, targetDate: n.targetDate ?? null,
		archivedAt: n.archivedAt ?? null, completedAt: n.completedAt ?? null, canceledAt: n.canceledAt ?? null, createdAt: n.createdAt ?? null,
	};
	return { project, milestones };
}

/**
 * Read the workspace.
 *
 * @param {{run: Function}} client
 * @param {{types?: string[], onProgress?: (e: {type: string, count: number}) => void}} [options]
 * @returns {Promise<{entities: Record<string, object[]>, counts: Record<string, number>, skipped: Record<string, number>}>}
 *   `skipped` counts records the board format has no place for (a comment on nothing it knows, a relation to a
 *   missing issue); the caller prints it.
 */
export async function fetchWorkspace(client, { types = FETCH_TYPES, onProgress = () => {} } = {}) {
	for (const t of types) {
		if (!FETCH_TYPES.includes(t)) throw new FetchError('unknown-type', `"${String(t).slice(0, 40)}" is not a type this fetcher reads`);
	}
	const want = new Set(types);
	const entities = {};
	const skipped = {};
	const done = (type, records) => {
		if (want.has(type)) {
			entities[type] = records;
			onProgress({ type, count: records.length });
		}
	};
	const mapAll = (type, nodes) => {
		const out = [];
		for (const node of nodes) {
			const rec = MAPPERS[type](node);
			if (rec === null) skipped[type] = (skipped[type] ?? 0) + 1;
			else out.push(rec);
		}
		return out;
	};

	// Teams are read when issues are wanted even if the caller did not ask for them: issues are read per team.
	let teamNodes = null;
	if (want.has('teams') || want.has('issues')) {
		teamNodes = await pageAll(client, 'teams');
		done('teams', mapAll('teams', teamNodes));
	}
	for (const type of ['states', 'users', 'labels', 'cycles']) {
		if (want.has(type)) done(type, mapAll(type, await pageAll(client, type)));
	}
	if (want.has('projects') || want.has('milestones')) {
		const projects = [];
		const milestones = [];
		for (const node of await pageAll(client, 'projects')) {
			const mapped = mapProject(node, 'projects');
			projects.push(mapped.project);
			milestones.push(...mapped.milestones);
		}
		done('projects', projects);
		done('milestones', milestones);
	}
	for (const type of ['projectUpdates', 'documents']) {
		if (want.has(type)) done(type, mapAll(type, await pageAll(client, type)));
	}
	if (want.has('issues')) {
		const issues = [];
		for (const team of teamNodes) {
			for (const node of await pageAll(client, 'issues', { team: team.id })) issues.push(mapIssue(node, 'issues'));
		}
		done('issues', issues);
	}
	for (const type of ['comments', 'relations', 'attachments']) {
		if (want.has(type)) done(type, mapAll(type, await pageAll(client, type)));
	}

	const counts = Object.fromEntries(Object.entries(entities).map(([type, list]) => [type, list.length]));
	return { entities, counts, skipped };
}
