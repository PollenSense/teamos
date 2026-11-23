import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, FetchError } from './client.mjs';
import { DOCUMENTS } from './documents.mjs';
import { FETCH_TYPES, fetchWorkspace, pageAll } from './fetch.mjs';
import { inventedWorkspace, makeFakeLinear, nested } from './fake-linear.mjs';
import { readExport, validateRecords, writeExport } from '../board-export/index.mjs';

const KEY = 'lin_api_TESTKEYinvented0123456789';
const code = (c) => (e) => e instanceof FetchError && e.code === c;
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function setup(data = inventedWorkspace(), fakeOpts = {}) {
	const fake = makeFakeLinear(data, fakeOpts);
	const client = createClient({ env: { LINEAR_API_KEY: KEY }, fetchImpl: fake.fetchImpl, paceMs: 0, sleep: async () => {} });
	return { fake, client, data };
}
const connection = (nodes, hasNextPage, endCursor) => json(200, { data: { teams: { pageInfo: { hasNextPage, endCursor }, nodes } } });

// ---- paging ----

test('paging: pages of 2 over 5 nodes make 3 requests; the short last page is normal', async () => {
	const data = { teams: Array.from({ length: 5 }, (_, i) => ({ id: `t${i}` })) };
	const { client, fake } = setup(data, { pageSize: 2 });
	const nodes = await pageAll(client, 'teams');
	assert.deepEqual(nodes.map((n) => n.id), ['t0', 't1', 't2', 't3', 't4']);
	assert.equal(fake.requests.length, 3);
	assert.deepEqual(fake.requests.map((r) => r.variables.after), [null, 'c2', 'c4']);
});

test('paging: an exact multiple of the page size ends on hasNextPage false; an empty list is fine', async () => {
	const four = setup({ teams: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] }, { pageSize: 2 });
	assert.equal((await pageAll(four.client, 'teams')).length, 4);
	assert.equal(four.fake.requests.length, 2);
	const none = setup({ teams: [] });
	assert.deepEqual(await pageAll(none.client, 'teams'), []);
});

test('paging: hasNextPage true with a missing, empty, repeated or looping cursor stops the run', async () => {
	const run = async (answers) => {
		let n = 0;
		const { client } = setup({}, { hook: () => answers[Math.min(n++, answers.length - 1)]() });
		return pageAll(client, 'teams');
	};
	await assert.rejects(run([() => connection([{ id: 'a' }], true, null)]), (e) => e.code === 'cursor' && /nothing written/.test(e.message));
	await assert.rejects(run([() => connection([{ id: 'a' }], true, undefined)]), code('cursor'));
	await assert.rejects(run([() => connection([{ id: 'a' }], true, '')]), code('cursor'));
	await assert.rejects(run([() => connection([{ id: 'a' }], true, 'x'), () => connection([{ id: 'b' }], true, 'x')]), code('cursor'));
	await assert.rejects(run([() => connection([{ id: 'a' }], true, 'x'), () => connection([{ id: 'b' }], true, 'y'), () => connection([{ id: 'c' }], true, 'x')]), code('cursor'));
	await assert.rejects(run([() => connection([{ id: 'a' }], true, 7)]), code('cursor'));
	// a cursor that comes back after another one, with a normal last page behind it
	await assert.rejects(run([() => connection([{ id: 'a' }], true, 'x'), () => connection([{ id: 'b' }], true, 'y'), () => connection([{ id: 'c' }], true, 'x'), () => connection([{ id: 'd' }], false, null)]), code('cursor'));
});

test('paging: a page without nodes or pageInfo is an error; a runaway list stops at the page limit', async () => {
	const bad = (body) => { const { client } = setup({}, { hook: () => json(200, body) }); return pageAll(client, 'teams'); };
	await assert.rejects(bad({ data: { teams: { nodes: [] } } }), code('bad-response'));
	await assert.rejects(bad({ data: { teams: { pageInfo: { hasNextPage: false } } } }), code('bad-response'));
	await assert.rejects(bad({ data: { teams: null } }), code('bad-response'));
	await assert.rejects(bad({ data: { other: {} } }), code('bad-response'));
	let n = 0;
	const { client } = setup({}, { hook: () => connection([{ id: 'a' }], true, `k${n++}`) });
	await assert.rejects(pageAll(client, 'teams', {}, { maxPages: 5 }), code('too-many-pages'));
	await assert.rejects(pageAll(client, 'viewer'), code('document-not-allowed'));
});

// ---- the workspace ----

test('a whole workspace reads into valid records with the counts the data has', async () => {
	const { client, fake, data } = setup();
	const progress = [];
	const { entities, counts, skipped } = await fetchWorkspace(client, { onProgress: (e) => progress.push(e.type) });
	assert.deepEqual(Object.keys(entities).sort(), [...FETCH_TYPES].sort());
	for (const [type, list] of Object.entries(entities)) validateRecords(type, list);
	assert.deepEqual(counts, { teams: 2, states: 2, users: 3, labels: 2, cycles: 1, projects: 1, milestones: 1, projectUpdates: 1, documents: 1, issues: 4, comments: 4, relations: 1, attachments: 1 });
	assert.deepEqual(skipped, { projectUpdates: 1, comments: 1, relations: 1, attachments: 1 });
	assert.deepEqual(progress, ['teams', 'states', 'users', 'labels', 'cycles', 'projects', 'milestones', 'projectUpdates', 'documents', 'issues', 'comments', 'relations', 'attachments']);
	const issueRequests = fake.requests.filter((r) => r.name === 'issues');
	assert.deepEqual(issueRequests.map((r) => r.variables.team), ['t-1', 't-2'], 'issues are read per team');
	assert.equal(data.teams.length, 2);
});

test('mapping: ids, keys, moved issues, labels, suspended users, bots, project comments and replies', async () => {
	const { client } = setup();
	const { entities } = await fetchWorkspace(client);
	const issue2 = entities.issues.find((i) => i.key === 'PSE-2');
	assert.deepEqual(issue2.previousKeys, ['INS-5']);
	assert.equal(issue2.parentId, 'i-PSE-1');
	assert.equal(issue2.teamKey, 'PSE');
	const issue1 = entities.issues.find((i) => i.key === 'PSE-1');
	assert.deepEqual(issue1.labelIds, ['l-2']);
	assert.equal(issue1.projectId, 'p-1');
	assert.equal(issue1.milestoneId, 'm-1');
	assert.equal(entities.issues.find((i) => i.key === 'INS-9').archivedAt, '2025-03-01T10:00:00.000Z');
	assert.deepEqual(entities.users.map((u) => [u.active, u.app]), [[true, false], [false, false], [true, true]], 'suspended and app users are read');
	assert.equal(entities.users[0].email, 'one@example.invalid');
	assert.equal(entities.labels[1].parentId, 'l-1');
	assert.equal(entities.labels[1].retiredAt, '2025-06-01T00:00:00.000Z');
	assert.deepEqual(entities.projects[0].teamKeys, ['PSE']);
	assert.equal(entities.milestones[0].projectId, 'p-1');
	const byId = Object.fromEntries(entities.comments.map((c) => [c.id, c]));
	assert.equal(byId['cm-2'].botName, 'Test Bot');
	assert.equal(byId['cm-2'].parentId, 'cm-1');
	assert.equal(byId['cm-3'].projectId, 'p-1');
	assert.equal(byId['cm-4'].documentId, 'd-1');
	assert.equal(byId['cm-4'].externalUserName, 'Outside Person');
	assert.equal(byId['cm-5'], undefined, 'a comment on nothing known is skipped, and counted');
	assert.equal(entities.relations[0].relatedIssueKey, 'PSE-2');
});

test('a subset of types still reads teams for issues but returns only what was asked', async () => {
	const { client, fake } = setup();
	const { entities } = await fetchWorkspace(client, { types: ['issues'] });
	assert.deepEqual(Object.keys(entities), ['issues']);
	assert.equal(entities.issues.length, 4);
	assert.deepEqual([...new Set(fake.requests.map((r) => r.name))], ['teams', 'issues']);
	const m = await fetchWorkspace(setup().client, { types: ['milestones'] });
	assert.deepEqual(Object.keys(m.entities), ['milestones']);
	await assert.rejects(fetchWorkspace(client, { types: ['issues', 'secrets'] }), code('unknown-type'));
});

test('a nested list with more than one page ends the run instead of losing records', async () => {
	const labels = inventedWorkspace();
	labels['issues:t-1'][0].labels = nested([{ id: 'l-2' }], true);
	await assert.rejects(fetchWorkspace(setup(labels).client), (e) => e.code === 'nested-truncated' && !/PSE-1/.test(e.message));
	const miles = inventedWorkspace();
	miles.projects[0].projectMilestones = nested([], true);
	await assert.rejects(fetchWorkspace(setup(miles).client), code('nested-truncated'));
	const teams = inventedWorkspace();
	teams.projects[0].teams = nested([{ key: 'PSE' }], true);
	await assert.rejects(fetchWorkspace(setup(teams).client), code('nested-truncated'));
});

test('a budget stop in the middle returns nothing to write', async () => {
	const { client, fake } = setup(inventedWorkspace(), { headers: (n) => ({ 'X-RateLimit-Requests-Remaining': String(n < 6 ? 2000 : 150) }) });
	await assert.rejects(fetchWorkspace(client), code('budget'));
	assert.equal(fake.requests.length, 6, 'the run stopped before the seventh request');
});

test('everything sent is on the list, none of it is a mutation, and the key is only in the header', async () => {
	const { client, fake } = setup();
	await fetchWorkspace(client);
	assert.equal(fake.unknown.length, 0);
	const allowed = new Set(Object.values(DOCUMENTS).map((d) => d.doc));
	for (const r of fake.requests) {
		assert.ok(allowed.has(r.query), 'a listed document');
		assert.ok(!/\b(mutation|subscription)\b/i.test(r.query));
		assert.ok(!JSON.stringify(r.variables).includes(KEY) && !r.query.includes(KEY));
		assert.equal(r.authorization, KEY);
		assert.equal(r.method, 'POST');
	}
});

test('an export written from a read passes the reader, and no file holds the key', async () => {
	const root = mkdtempSync(join(tmpdir(), 'linear-fetch-'));
	try {
		const workspace = join(root, 'pollen-bot');
		mkdirSync(workspace);
		const out = join(root, 'export');
		const { client } = setup();
		const { entities } = await fetchWorkspace(client);
		await writeExport(out, { source: 'linear-api', entities }, { workspaceRoot: workspace, filterText: '' });
		const back = await readExport(out);
		assert.equal(back.entities.issues.length, 4);
		assert.equal(back.manifest.source, 'linear-api');
		for (const file of readdirSync(out)) assert.ok(!readFileSync(join(out, file), 'utf8').includes(KEY), file);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ---- the independent review of 2026-11-16 ----

test('paging: a missing, null or text hasNextPage is an error, never a quiet end of the list', async () => {
	for (const bad of [undefined, null, 'true', 1, 'false']) {
		const { client } = setup({}, { hook: () => json(200, { data: { teams: { pageInfo: { hasNextPage: bad, endCursor: 'c1' }, nodes: [{ id: 'a' }] } } }) });
		await assert.rejects(pageAll(client, 'teams'), (e) => e instanceof FetchError && e.code === 'bad-response' && /hasNextPage/.test(e.message), String(bad));
	}
});

test('paging: an empty page that says there is more is followed, and a record that is not an object is an error', async () => {
	let n = 0;
	const { client } = setup({}, { hook: () => (++n === 1 ? connection([], true, 'c1') : connection([{ id: 'late' }], false, null)) });
	assert.deepEqual((await pageAll(client, 'teams')).map((x) => x.id), ['late']);
	for (const node of [null, 5, 'x', ['a']]) {
		const bad = setup({}, { hook: () => connection([{ id: 'a' }, node], false, null) });
		await assert.rejects(pageAll(bad.client, 'teams'), (e) => e instanceof FetchError && e.code === 'bad-response' && /not an object/.test(e.message), String(node));
	}
});

test('a nested list with no true-or-false hasNextPage, or a record that is not an object, is an error', async () => {
	const data = inventedWorkspace();
	data['issues:t-1'][0].labels = { nodes: [{ id: 'l-2' }] };
	await assert.rejects(fetchWorkspace(setup(data).client, { types: ['issues'] }), (e) => e.code === 'bad-response' && /hasNextPage/.test(e.message));
	const data2 = inventedWorkspace();
	data2['issues:t-1'][0].labels = nested([null], false);
	await assert.rejects(fetchWorkspace(setup(data2).client, { types: ['issues'] }), (e) => e.code === 'bad-response' && /not an object/.test(e.message));
});

test('a nested list that is missing, null or not an object is an error, not an empty list; an empty one with no next page is fine (round 2)', async () => {
	for (const bad of [null, undefined, 'x', 5]) {
		const labels = inventedWorkspace();
		labels['issues:t-1'][0].labels = bad;
		await assert.rejects(fetchWorkspace(setup(labels).client, { types: ['issues'] }), (e) => e.code === 'bad-response' && /issue labels is missing/.test(e.message) && !/PSE-1/.test(e.message), String(bad));
		const teams = inventedWorkspace();
		teams.projects[0].teams = bad;
		await assert.rejects(fetchWorkspace(setup(teams).client, { types: ['projects'] }), (e) => e.code === 'bad-response' && /project teams is missing/.test(e.message), String(bad));
		const miles = inventedWorkspace();
		miles.projects[0].projectMilestones = bad;
		await assert.rejects(fetchWorkspace(setup(miles).client, { types: ['milestones'] }), (e) => e.code === 'bad-response' && /project milestones is missing/.test(e.message), String(bad));
	}
	const empty = inventedWorkspace();
	empty['issues:t-1'][0].labels = nested([]);
	empty.projects[0].teams = nested([]);
	empty.projects[0].projectMilestones = nested([]);
	const { entities } = await fetchWorkspace(setup(empty).client, { types: ['issues', 'projects', 'milestones'] });
	assert.deepEqual(entities.issues[0].labelIds, []);
	assert.deepEqual(entities.projects[0].teamKeys, []);
	assert.equal(entities.milestones.length, 0);
});
