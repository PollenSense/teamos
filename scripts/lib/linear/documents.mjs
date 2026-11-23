/**
 * The only GraphQL documents the Linear fetcher can send.
 *
 * `createClient().run(name, variables)` takes a NAME from this table, never query text, so nothing outside
 * this file can reach Linear: there is no mutation or subscription here, and a test checks that no document
 * has one (and that every document is exactly one query). The key's own read-only scope is the real lock;
 * this list is the second one, in code.
 *
 * Every connection is read with `includeArchived: true` (archived issues, projects, cycles and labels
 * are part of the history) and pages with `pageInfo { hasNextPage endCursor }`. Sizes keep each query far
 * under Linear's 10,000-point complexity limit; the first import is a few hundred requests.
 * `variables` lists what a caller may pass; `path` is where the connection sits in the response.
 *
 * Nested connections (a project's milestones, an issue's labels) carry `pageInfo { hasNextPage }` and the
 * fetcher stops with a clear error if one is truncated, instead of losing records quietly.
 */

const PAGE = 'pageInfo { hasNextPage endCursor }';
const NESTED = 'pageInfo { hasNextPage }';

function def(doc, path, variables, size) {
	return Object.freeze({ doc, path: Object.freeze(path), variables: Object.freeze(variables), size });
}

export const DOCUMENTS = Object.freeze({
	viewer: Object.freeze({
		doc: 'query Viewer { viewer { id admin active } }',
		path: Object.freeze(['viewer']),
		variables: Object.freeze([]),
		size: 0,
	}),
	teams: def(
		`query Teams($after: String) { teams(first: 50, after: $after, includeArchived: true) { ${PAGE} nodes { id key name private archivedAt cyclesEnabled cycleDuration } } }`,
		['teams'], ['after'], 50,
	),
	states: def(
		`query States($after: String) { workflowStates(first: 100, after: $after, includeArchived: true) { ${PAGE} nodes { id name type position archivedAt team { key } } } }`,
		['workflowStates'], ['after'], 100,
	),
	users: def(
		`query Users($after: String) { users(first: 100, after: $after, includeDisabled: true) { ${PAGE} nodes { id name displayName email active guest admin app createdAt } } }`,
		['users'], ['after'], 100,
	),
	labels: def(
		`query Labels($after: String) { issueLabels(first: 100, after: $after, includeArchived: true) { ${PAGE} nodes { id name isGroup retiredAt team { key } parent { id } } } }`,
		['issueLabels'], ['after'], 100,
	),
	cycles: def(
		`query Cycles($after: String) { cycles(first: 100, after: $after, includeArchived: true) { ${PAGE} nodes { id number name startsAt endsAt completedAt team { key } } } }`,
		['cycles'], ['after'], 100,
	),
	projects: def(
		`query Projects($after: String) { projects(first: 20, after: $after, includeArchived: true) { ${PAGE} nodes { id name description content startDate targetDate archivedAt completedAt canceledAt createdAt status { name type } lead { id } teams(first: 10) { ${NESTED} nodes { key } } projectMilestones(first: 25) { ${NESTED} nodes { id name description targetDate sortOrder } } } } }`,
		['projects'], ['after'], 20,
	),
	projectUpdates: def(
		`query ProjectUpdates($after: String) { projectUpdates(first: 50, after: $after, includeArchived: true) { ${PAGE} nodes { id body health createdAt user { id } project { id } } } }`,
		['projectUpdates'], ['after'], 50,
	),
	documents: def(
		`query Documents($after: String) { documents(first: 50, after: $after, includeArchived: true) { ${PAGE} nodes { id title content createdAt updatedAt project { id } issue { identifier } } } }`,
		['documents'], ['after'], 50,
	),
	issues: def(
		`query Issues($after: String, $team: ID!) { issues(first: 25, after: $after, includeArchived: true, orderBy: createdAt, filter: { team: { id: { eq: $team } } }) { ${PAGE} nodes { id identifier number title description priority estimate dueDate createdAt updatedAt archivedAt completedAt canceledAt startedAt branchName previousIdentifiers team { key } state { id } project { id } projectMilestone { id } cycle { id } parent { id } assignee { id } creator { id } labels(first: 25) { ${NESTED} nodes { id } } } } }`,
		['issues'], ['after', 'team'], 25,
	),
	comments: def(
		`query Comments($after: String) { comments(first: 100, after: $after, includeArchived: true) { ${PAGE} nodes { id body createdAt updatedAt user { id } botActor { name } externalUser { name } issue { identifier } projectUpdate { id } project { id } parent { id } documentContent { document { id } } } } }`,
		['comments'], ['after'], 100,
	),
	relations: def(
		`query Relations($after: String) { issueRelations(first: 100, after: $after, includeArchived: true) { ${PAGE} nodes { id type issue { identifier } relatedIssue { identifier } } } }`,
		['issueRelations'], ['after'], 100,
	),
	attachments: def(
		`query Attachments($after: String) { attachments(first: 100, after: $after, includeArchived: true) { ${PAGE} nodes { id sourceType url title subtitle metadata createdAt issue { identifier } } } }`,
		['attachments'], ['after'], 100,
	),
});

export const DOCUMENT_NAMES = Object.freeze(Object.keys(DOCUMENTS));
