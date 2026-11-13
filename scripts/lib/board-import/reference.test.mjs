import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImportError, buildPeople, loadExisting, planReference, slugify } from './index.mjs';
import { MEMBERS, buildExport, buildInventorySizedExport } from './fixture.mjs';

const plan = (entities, options = {}) => planReference(entities, { members: MEMBERS, ...options });

test('slugify: accents, symbols, empty and long names', () => {
	assert.equal(slugify('Renewals automation (2026)'), 'renewals-automation-2026');
	assert.equal(slugify(`  Caf${String.fromCharCode(233)} -- Ops!  `), 'cafe-ops');
	assert.equal(slugify('???'), 'project');
	assert.equal(slugify(''), 'project');
	const long = slugify('a'.repeat(100));
	assert.equal(long.length, 60);
	assert.equal(slugify(`${'a'.repeat(59)} b`), 'a'.repeat(59), 'a cut never leaves a trailing dash');
});

// ─── people ─────────────────────────────────────────────────────────────────────

test('people: matched by e-mail (any case), the rest as linear:<first name>, former and app flags', () => {
	const { file, counts } = buildPeople(buildExport().users, MEMBERS);
	assert.equal(file.people['u-1'].name, 'alice', 'matched ignoring case');
	assert.equal(file.people['u-1'].former, undefined);
	assert.equal(file.people['u-2'].name, 'linear:Test');
	assert.equal(file.people['u-2'].former, true, 'inactive and unmatched is former');
	assert.equal(file.people['u-3'].app, true);
	assert.deepEqual(counts, { matched: 1, unmatched: 2, former: 1, apps: 1 });
	assert.equal(JSON.stringify(file).includes('example.invalid'), false, 'no e-mail address in the file');
});

test('people: an inactive user who matches a member keeps the member name and is former (Van bt5a)', () => {
	const users = [{ id: 'x-1', name: 'Bob Invented', email: 'BOB@example.invalid', active: false, app: false }];
	const { file } = buildPeople(users, MEMBERS);
	assert.deepEqual(file.people['x-1'], { name: 'bob', former: true });
});

test('people: two users with the same first name stay two names; the order does not depend on the input order', () => {
	const a = { id: 'a-1', name: 'Dana One', email: 'd1@example.invalid', active: true, createdAt: '2025-01-01T00:00:00.000Z' };
	const b = { id: 'a-2', name: 'Dana Two', email: 'd2@example.invalid', active: true, createdAt: '2025-02-01T00:00:00.000Z' };
	const one = buildPeople([a, b], []).file.people;
	const two = buildPeople([b, a], []).file.people;
	assert.deepEqual(one, two);
	assert.equal(one['a-1'].name, 'linear:Dana');
	assert.equal(one['a-2'].name, 'linear:Dana#2');
});

test('people: a name that is an address or a phone number never reaches the file', () => {
	const users = [
		{ id: 'z-1', name: 'someone@outside.example.invalid', email: 'q@example.invalid', active: true },
		{ id: 'z-2', name: '555-010-0199', email: 'r@example.invalid', active: true },
		{ id: 'z-3', name: '', displayName: 'handle.x', email: 's@example.invalid', active: true },
		{ id: 'z-4', name: '', email: 't@example.invalid', active: true },
	];
	const { file } = buildPeople(users, []);
	const text = JSON.stringify(file);
	assert.equal(text.includes('outside'), false);
	assert.equal(text.includes('0199'), false);
	assert.equal(file.people['z-3'].name, 'linear:handle.x');
	assert.match(file.people['z-1'].name, /^linear:unknown/);
	assert.match(file.people['z-4'].name, /^linear:unknown/);
});

test('people: user ids that are also property names (constructor, __proto__) are plain keys and are not taken for overrides', () => {
	const users = [
		{ id: 'constructor', name: 'Ctor Person', email: 'c@example.invalid', active: true },
		{ id: '__proto__', name: 'Proto Person', email: 'p@example.invalid', active: true },
		{ id: 'toString', name: 'Str Person', email: 'bob@example.invalid', active: false },
	];
	const { file, counts } = buildPeople(users, MEMBERS, {});
	assert.deepEqual(Object.keys(file.people).sort(), ['__proto__', 'constructor', 'toString']);
	assert.equal(file.people.constructor.name, 'linear:Ctor');
	assert.equal(Object.getPrototypeOf(file.people), Object.prototype, 'the file object was not re-parented');
	assert.equal(file.people.toString.name, 'bob');
	assert.equal(counts.matched, 1);
	const text = JSON.stringify(file);
	assert.equal(JSON.parse(text).people['__proto__'].name, 'linear:Proto', 'survives a write and read');
});

test('a lead or author whose id is a property name but is not a user is counted as dangling', () => {
	const e = buildExport();
	e.projects[0].leadId = 'constructor';
	assert.equal(plan(e).counts.dangling['projects.lead'], 1);
});

test('people: an override wins over the address; one that names no member is refused', () => {
	const users = [{ id: 'o-1', name: 'Odd Mail', email: 'different@example.invalid', active: true }];
	assert.equal(buildPeople(users, MEMBERS, { 'o-1': 'bob' }).file.people['o-1'].name, 'bob');
	assert.throws(() => buildPeople(users, MEMBERS, { 'o-1': 'nobody' }), (e) => e instanceof ImportError && e.code === 'bad-override');
});

// ─── the plan ───────────────────────────────────────────────────────────────────

test('teams: states sorted by position, archived state marked, cycle settings kept, native false', () => {
	const p = plan(buildExport());
	const pse = p.teams.find((t) => t.key === 'PSE');
	assert.equal(pse.native, false);
	assert.deepEqual(pse.states.map((s) => s.name), ['Todo', 'Done']);
	assert.deepEqual(pse.cycles, { enabled: true, duration: 1 });
	const ins = p.teams.find((t) => t.key === 'INS');
	assert.equal(ins.states[0].archived, '2025-06-01T00:00:00.000Z');
	assert.deepEqual(ins.cycles, { enabled: false });
	assert.equal(pse.nextNumber, undefined, 'the allocator is the issues importer\'s');
});

test('cycles: number, team, dates and completion; a cycle of an unknown team is counted, not written', () => {
	const e = buildExport();
	e.cycles.push({ id: 'c-9', teamKey: 'ZZZ', number: 1, startsAt: '2025-01-01', endsAt: '2025-01-08' });
	const p = plan(e);
	assert.equal(p.cycles.length, 2);
	assert.equal(p.cycles[0].completed, '2025-02-10T08:00:00.000Z');
	assert.equal(p.cycles[1].completed, undefined);
	assert.equal(p.counts.dangling['cycles.team'], 1);
});

test('labels: a label in a group is group/name; a group stays a group; a missing parent is counted', () => {
	const e = buildExport();
	e.labels.push({ id: 'l-3', name: 'Lonely', teamKey: null, parentId: 'l-missing', isGroup: false });
	const { labels } = plan(e).labels;
	assert.deepEqual(labels.map((l) => l.name), ['Area', 'Area/Portal', 'Lonely']);
	assert.equal(labels[0].group, true);
	assert.equal(plan(e).counts.dangling['labels.parent'], 1);
});

test('projects: code from the name, lead and update author as board names, milestones sorted, status type kept', () => {
	const p = plan(buildExport());
	const first = p.projects.find((x) => x.fields.linearId === 'p-1');
	assert.equal(first.fields.code, 'test-project');
	assert.equal(first.fields.lead, 'alice');
	assert.deepEqual(first.fields.teams, ['PSE']);
	assert.equal(first.fields.statusType, 'started');
	assert.deepEqual(first.fields.milestones.map((m) => m.name), ['Alpha milestone', 'First milestone', 'Zeta milestone']);
	assert.equal(first.fields.updates[0].author, 'alice');
	assert.equal(first.body, 'An invented project.\n\nLonger invented text.');
	assert.deepEqual(plan(buildExport()).projects.find((x) => x.fields.linearId === 'p-2').fields.teams, ['PSE', 'INS']);
});

test('projects: two names with one slug get different codes; an earlier code is kept after a rename', async () => {
	const e = buildExport();
	e.projects.push({ id: 'p-3', name: 'Test Project!', teamKeys: ['PSE'], createdAt: '2025-04-01T00:00:00.000Z' });
	const codes = plan(e).projects.map((p) => p.fields.code);
	assert.equal(new Set(codes.map((c) => c.toLowerCase())).size, codes.length);
	assert.ok(codes.includes('test-project') && codes.includes('test-project-2'));

	const existing = { codeByLinearId: new Map([['p-1', 'old-name']]), taken: new Set(['old-name']), projectMap: null };
	const renamed = plan(buildExport(), { existing });
	assert.equal(renamed.projects.find((x) => x.fields.linearId === 'p-1').fields.code, 'old-name', 'the code does not follow the new name');
	assert.equal(renamed.projects.find((x) => x.fields.linearId === 'p-2').fields.code, 'second-project');
});

test('projects: dangling team, lead, milestone and update parents are counted; the project is still written', () => {
	const e = buildExport();
	e.projects[0].teamKeys = ['PSE', 'GONE'];
	e.projects[0].leadId = 'u-missing';
	e.milestones.push({ id: 'm-9', projectId: 'p-missing', name: 'Orphan' });
	e.projectUpdates.push({ id: 'pu-9', projectId: 'p-missing', body: 'Orphan update', createdAt: '2025-01-01T00:00:00.000Z' });
	e.projectUpdates[0].authorId = 'u-missing';
	const p = plan(e);
	assert.deepEqual(p.counts.dangling, { 'projects.team': 1, 'projects.lead': 1, 'milestones.project': 1, 'projectUpdates.project': 1, 'projectUpdates.author': 1 });
	const first = p.projects.find((x) => x.fields.linearId === 'p-1');
	assert.deepEqual(first.fields.teams, ['PSE']);
	assert.equal(first.fields.lead, undefined);
});

test('documents: under their project code; an unknown project is counted; a bad id is skipped and counted', () => {
	const e = buildExport();
	e.documents.push({ id: 'd-2', title: 'Loose', content: 'x', projectId: 'p-missing' });
	e.documents.push({ id: '../escape', title: 'Bad id', content: 'x' });
	const p = plan(e);
	assert.equal(p.documents.length, 2);
	assert.equal(p.documents.find((d) => d.fields.id === 'd-1').fields.project, 'test-project');
	assert.equal(p.documents.find((d) => d.fields.id === 'd-2').fields.project, undefined);
	assert.equal(p.counts.dangling['documents.project'], 1);
	assert.equal(p.counts.dangling['documents.id'], 1);
	assert.equal(JSON.stringify(p.documents).includes('escape'), false);
});

// ─── person data (rule A) ───────────────────────────────────────────────────────

test('rule A: an outside address in a project text is redacted in the synced record and kept in raw', () => {
	const e = buildExport();
	e.projects[0].description = 'Write to stranger@outside.example.invalid about it.';
	e.projectUpdates[0].body = 'Call 555-010-0199 tomorrow.';
	const p = plan(e);
	const synced = JSON.stringify(p.projects.find((x) => x.fields.linearId === 'p-1'));
	assert.equal(synced.includes('stranger@'), false);
	assert.equal(synced.includes('0199'), false);
	assert.match(synced, /\[email\]/);
	assert.match(synced, /\[phone\]/);
	assert.equal(p.counts.flagged.projects, 1);
	assert.equal(p.raw.length, 1);
	assert.equal(p.raw[0].type, 'projects');
	assert.equal(p.raw[0].id, 'test-project');
	assert.match(JSON.stringify(p.raw[0].record), /stranger@outside/, 'the original text is in the raw record');
});

test('rule A: our own domain is not redacted and makes no raw record', () => {
	const e = buildExport();
	e.projects[0].description = 'Ask someone@pollensense.com.';
	const p = plan(e);
	assert.match(p.projects.find((x) => x.fields.linearId === 'p-1').body, /van@pollensense\.com/);
	assert.equal(p.raw.length, 0);
});

test('rule A: an address in the project name does not leak into the file name (the code)', () => {
	const e = buildExport();
	e.projects[0].name = 'outsider@outside.example.invalid plan';
	const p = plan(e);
	const first = p.projects.find((x) => x.fields.linearId === 'p-1');
	assert.equal(first.fields.code, 'email-plan');
	assert.equal(JSON.stringify(first).includes('outsider@'), false);
});

test('rule A: a document title or body with a phone number is redacted and raw is kept', () => {
	const e = buildExport();
	e.documents[0].title = 'Hotline +1 555 010 0199';
	const p = plan(e);
	assert.equal(JSON.stringify(p.documents[0]).includes('0199'), false);
	assert.equal(p.counts.flagged.documents, 1);
	assert.equal(p.raw[0].type, 'documents');
});

test('rule A: a long opaque id is never changed by the scan (ids are not scanned)', () => {
	const e = buildExport();
	e.projects[0].id = '12345678-1234-1234-1234-123456789012';
	e.milestones[0].projectId = e.projects[0].id;
	e.milestones[0].id = '98765432-1098-7654-3210-987654321098';
	const p = plan(e);
	const first = p.projects.find((x) => x.fields.linearId === e.projects[0].id);
	assert.equal(first.fields.linearId, '12345678-1234-1234-1234-123456789012');
	assert.equal(first.fields.milestones.find((m) => m.id === e.milestones[0].id)?.id, '98765432-1098-7654-3210-987654321098');
	assert.equal(p.counts.flagged.projects, 0);
});

test('rule A: the person-data report counts texts and prints no value', () => {
	const e = buildExport();
	e.projects[0].description = 'Reach stranger@outside.example.invalid please.';
	const text = plan(e).report.format();
	assert.match(text, /project/);
	assert.equal(text.includes('stranger'), false);
});

// ─── the tag map ────────────────────────────────────────────────────────────────

test('tag map: a project code equal to the tag, or a hint naming the project; the rest stay null and are counted', () => {
	const e = buildExport();
	e.projects.push({ id: 'p-4', name: 'Ops', teamKeys: ['PSE'] });
	e.projects.push({ id: 'p-5', name: 'Renewals automation', teamKeys: ['PSE'] });
	const p = plan(e, { tagHints: { renewals: 'renewals AUTOMATION' } });
	assert.equal(p.projectMap.tags.ops, 'ops');
	assert.equal(p.projectMap.tags.renewals, 'renewals-automation');
	assert.equal(p.projectMap.tags.sensor, null);
	assert.deepEqual(p.counts.tags, { total: 7, mapped: 2, unmapped: 5, missingProject: 0 });
});

test('tag map: a value already in the file is never changed; a null one can fill in later', () => {
	const e = buildExport();
	e.projects.push({ id: 'p-4', name: 'Ops', teamKeys: ['PSE'] });
	const existing = { codeByLinearId: new Map(), taken: new Set(), projectMap: { version: 1, tags: { ops: 'something-by-hand', sensor: null, handmade: 'x' } } };
	const p = plan(e, { existing });
	assert.equal(p.projectMap.tags.ops, 'something-by-hand');
	assert.equal(p.projectMap.tags.handmade, 'x', 'a tag the importer does not know stays');
	assert.equal(p.counts.tags.missingProject, 2, 'both hand entries name a project that is not there');
});

// ─── sizes ──────────────────────────────────────────────────────────────────────

test('counts read from an export of the inventory\'s size equal the inventory (63, 15, 17, 18, 4)', () => {
	const p = plan(buildInventorySizedExport());
	assert.equal(p.counts.read.projects, 63);
	assert.equal(p.counts.read.labels, 15);
	assert.equal(p.counts.read.documents, 17);
	assert.equal(p.counts.read.users, 18);
	assert.equal(p.counts.read.teams, 4);
	assert.equal(p.projects.length, 63);
	assert.equal(p.documents.length, 17);
	assert.equal(p.labels.labels.length, 15);
	assert.equal(Object.keys(p.people.people).length, 18);
	assert.equal(p.teams.length, 4);
	assert.equal(p.counts.people.former, 9);
	assert.deepEqual(p.counts.dangling, {});
});

test('the plan is the same twice, in any input order', () => {
	const e = buildInventorySizedExport();
	const reversed = Object.fromEntries(Object.entries(e).map(([k, v]) => [k, [...v].reverse()]));
	const a = JSON.stringify(plan(e), (k, v) => (k === 'report' ? undefined : v));
	const b = JSON.stringify(plan(reversed), (k, v) => (k === 'report' ? undefined : v));
	assert.equal(a, b);
});

test('loadExisting on an empty store finds nothing', async () => {
	const fake = { listProjects: async () => [], readProject: async () => null, readSingle: async () => null };
	const ex = await loadExisting(fake);
	assert.equal(ex.codeByLinearId.size, 0);
	assert.equal(ex.projectMap, null);
});
