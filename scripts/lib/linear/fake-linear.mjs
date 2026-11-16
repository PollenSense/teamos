/**
 * A scripted stand-in for Linear's GraphQL endpoint, for tests with no network and no key.
 * All data is invented (the `.invalid` domain never resolves). It answers only documents from the fixed
 * list (found by their text); anything else is recorded in `unknown` and answered with an error.
 */

import { DOCUMENTS } from './documents.mjs';

const byText = new Map(Object.entries(DOCUMENTS).map(([name, spec]) => [spec.doc, name]));

const page = (nodes, hasNextPage = false, endCursor = null) => ({ pageInfo: { hasNextPage, endCursor }, nodes });
const nested = (nodes, hasNextPage = false) => ({ pageInfo: { hasNextPage }, nodes });

/** Invented Linear-shaped nodes, one list per document (issues per team: `issues:<teamId>`). */
export function inventedWorkspace() {
	const issue = (n, team, extra = {}) => ({
		id: `i-${team.key}-${n}`, identifier: `${team.key}-${n}`, number: n, title: `Invented issue ${n}`, description: n === 1 ? 'Invented description.' : null,
		priority: n % 5, estimate: null, dueDate: null, createdAt: '2025-01-20T10:00:00.000Z', updatedAt: '2025-02-01T10:00:00.000Z', archivedAt: null,
		completedAt: null, canceledAt: null, startedAt: null, branchName: `invented/${team.key.toLowerCase()}-${n}`, previousIdentifiers: n === 2 ? ['INS-5'] : [],
		team: { key: team.key }, state: { id: 's-1' }, project: n === 1 ? { id: 'p-1' } : null, projectMilestone: n === 1 ? { id: 'm-1' } : null,
		cycle: null, parent: n === 2 ? { id: `i-${team.key}-1` } : null, assignee: { id: 'u-1' }, creator: { id: 'u-2' },
		labels: nested(n === 1 ? [{ id: 'l-2' }] : []), ...extra,
	});
	const teams = [
		{ id: 't-1', key: 'PSE', name: 'Test Engineering', private: false, archivedAt: null, cyclesEnabled: true, cycleDuration: 1 },
		{ id: 't-2', key: 'INS', name: 'Test Insights', private: false, archivedAt: null, cyclesEnabled: false, cycleDuration: null },
	];
	return {
		teams,
		states: [{ id: 's-1', name: 'Todo', type: 'unstarted', position: 1, archivedAt: null, team: { key: 'PSE' } }, { id: 's-2', name: 'Done', type: 'completed', position: 2, archivedAt: null, team: { key: 'INS' } }],
		users: [
			{ id: 'u-1', name: 'Test Person One', displayName: 'tp1', email: 'one@example.invalid', active: true, guest: false, admin: true, app: false, createdAt: '2025-01-05T10:00:00.000Z' },
			{ id: 'u-2', name: 'Test Person Two', displayName: 'tp2', email: 'two@example.invalid', active: false, guest: false, admin: false, app: false, createdAt: '2025-01-06T10:00:00.000Z' },
			{ id: 'u-3', name: 'Test Agent', displayName: 'agent', email: null, active: true, guest: false, admin: false, app: true, createdAt: null },
		],
		labels: [{ id: 'l-1', name: 'Area', isGroup: true, retiredAt: null, team: null, parent: null }, { id: 'l-2', name: 'Portal', isGroup: false, retiredAt: '2025-06-01T00:00:00.000Z', team: { key: 'PSE' }, parent: { id: 'l-1' } }],
		cycles: [{ id: 'c-1', number: 1, name: null, startsAt: '2025-02-03T08:00:00.000Z', endsAt: '2025-02-10T08:00:00.000Z', completedAt: null, team: { key: 'PSE' } }],
		projects: [{
			id: 'p-1', name: 'Test project', description: 'Invented.', content: 'Invented content.', startDate: '2025-01-15', targetDate: null, archivedAt: null, completedAt: null, canceledAt: null, createdAt: '2025-01-10T09:00:00.000Z',
			status: { name: 'In Progress', type: 'started' }, lead: { id: 'u-1' }, teams: nested([{ key: 'PSE' }]),
			projectMilestones: nested([{ id: 'm-1', name: 'First milestone', description: null, targetDate: '2025-03-01', sortOrder: 1.5 }]),
		}],
		projectUpdates: [{ id: 'pu-1', body: 'Invented update.', health: 'onTrack', createdAt: '2025-02-01T12:00:00.000Z', user: { id: 'u-1' }, project: { id: 'p-1' } }, { id: 'pu-2', body: 'An update on no project.', health: null, createdAt: '2025-02-01T12:00:00.000Z', user: null, project: null }],
		documents: [{ id: 'd-1', title: 'Invented document', content: 'Invented content.', createdAt: '2025-02-02T12:00:00.000Z', updatedAt: null, project: { id: 'p-1' }, issue: null }],
		'issues:t-1': [issue(1, teams[0]), issue(2, teams[0]), issue(3, teams[0])],
		'issues:t-2': [issue(9, teams[1], { archivedAt: '2025-03-01T10:00:00.000Z' })],
		comments: [
			{ id: 'cm-1', body: 'Invented comment.', createdAt: '2025-02-01T09:00:00.000Z', updatedAt: null, user: { id: 'u-1' }, botActor: null, externalUser: null, issue: { identifier: 'PSE-1' }, projectUpdate: null, project: null, parent: null, documentContent: null },
			{ id: 'cm-2', body: 'Invented bot comment.', createdAt: '2025-02-01T09:05:00.000Z', updatedAt: null, user: null, botActor: { name: 'Test Bot' }, externalUser: null, issue: { identifier: 'PSE-1' }, projectUpdate: null, project: null, parent: { id: 'cm-1' }, documentContent: null },
			{ id: 'cm-3', body: 'Invented comment on a project.', createdAt: '2025-02-03T09:00:00.000Z', updatedAt: null, user: { id: 'u-1' }, botActor: null, externalUser: null, issue: null, projectUpdate: null, project: { id: 'p-1' }, parent: null, documentContent: null },
			{ id: 'cm-4', body: 'Invented comment on a document.', createdAt: '2025-02-04T09:00:00.000Z', updatedAt: null, user: null, botActor: null, externalUser: { name: 'Outside Person' }, issue: null, projectUpdate: null, project: null, parent: null, documentContent: { document: { id: 'd-1' } } },
			{ id: 'cm-5', body: 'A comment on nothing the format knows.', createdAt: '2025-02-05T09:00:00.000Z', updatedAt: null, user: null, botActor: null, externalUser: null, issue: null, projectUpdate: null, project: null, parent: null, documentContent: { document: null } },
		],
		relations: [{ id: 'r-1', type: 'blocks', issue: { identifier: 'PSE-1' }, relatedIssue: { identifier: 'PSE-2' } }, { id: 'r-2', type: 'related', issue: { identifier: 'PSE-1' }, relatedIssue: null }],
		attachments: [{ id: 'a-1', sourceType: 'github', url: 'https://example.invalid/pull/1', title: 'Invented pull request', subtitle: null, metadata: { state: 'merged' }, createdAt: null, issue: { identifier: 'PSE-1' } }, { id: 'a-2', sourceType: 'slack', url: 'https://example.invalid/thread', title: null, subtitle: null, metadata: null, createdAt: null, issue: null }],
	};
}

/**
 * @param {Record<string, object[]>} data         from `inventedWorkspace()` (or edited)
 * @param {{pageSize?: number, headers?: (n: number) => Record<string,string>, hook?: (n: number, name: string, vars: object) => (Response|undefined), pageInfoFor?: Function}} [opts]
 */
export function makeFakeLinear(data, opts = {}) {
	const requests = [];
	const unknown = [];
	let n = 0;
	const fetchImpl = async (url, init) => {
		n++;
		const body = JSON.parse(init.body);
		const name = byText.get(body.query);
		requests.push({ n, url, name: name ?? null, query: body.query, variables: body.variables, authorization: init.headers.Authorization, method: init.method, hasSignal: init.signal instanceof AbortSignal });
		const headers = { 'Content-Type': 'application/json', ...(opts.headers?.(n) ?? {}) };
		const hooked = name ? opts.hook?.(n, name, body.variables) : undefined;
		if (hooked) return hooked;
		if (!name) {
			unknown.push(body.query);
			return new Response(JSON.stringify({ errors: [{ message: 'unknown document' }] }), { status: 400, headers });
		}
		const spec = DOCUMENTS[name];
		const key = name === 'issues' ? `issues:${body.variables.team}` : name;
		const all = data[key] ?? [];
		const size = opts.pageSize ?? spec.size;
		const start = body.variables.after ? Number(body.variables.after.slice(1)) : 0;
		const nodes = all.slice(start, start + size);
		const end = start + nodes.length;
		const conn = page(nodes, end < all.length, `c${end}`);
		let payload = { data: {} };
		let cur = payload.data;
		spec.path.slice(0, -1).forEach((step) => { cur[step] = {}; cur = cur[step]; });
		cur[spec.path[spec.path.length - 1]] = conn;
		return new Response(JSON.stringify(payload), { status: 200, headers });
	};
	return { fetchImpl, requests, unknown };
}

export { page, nested };
