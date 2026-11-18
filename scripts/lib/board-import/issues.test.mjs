import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImportError, boardEstimate, boardPriority, planIssues, planReference } from './index.mjs';
import { MEMBERS, buildExport, buildInventorySizedIssues } from './fixture.mjs';

const refOf = (e) => planReference(e, { members: MEMBERS });
const plan = (e) => planIssues(e, refOf(e));
const byId = (p, id) => p.issues.find((i) => i.fields.id === id);

test('an issue becomes a file: state, people, project, milestone, cycle, parent, labels, dates, source', () => {
	const e = buildExport();
	const p = plan(e);
	const f = byId(p, 'PSE-1').fields;
	assert.equal(f.team, 'PSE');
	assert.equal(f.linearId, 'i-1');
	assert.equal(f.title, 'Invented parent issue');
	assert.equal(f.status, 'Todo');
	assert.equal(f.statusType, 'unstarted');
	assert.equal(f.priority, 2);
	assert.equal(f.assignee, 'alice', 'u-1 matches a member by e-mail');
	assert.equal(f.creator, 'linear:Test', 'u-2 matches nobody');
	assert.equal(f.project, 'test-project');
	assert.equal(f.milestone, 'First milestone');
	assert.equal(f.cycle, 'PSE-1');
	assert.deepEqual(f.labels, ['Area/Portal']);
	assert.equal(f.dueDate, '2025-03-01');
	assert.equal(f.created, '2025-01-20T10:00:00.000Z');
	assert.equal(f.updated, '2025-02-05T10:00:00.000Z');
	assert.deepEqual(f.source, { system: 'linear' });
	assert.equal(byId(p, 'PSE-1').body, 'Invented description.');
	const child = byId(p, 'PSE-2').fields;
	assert.equal(child.parent, 'PSE-1');
	assert.equal(child.branch, 'invented/branch');
	assert.equal(child.completed, '2025-02-06T10:00:00.000Z');
	assert.equal(byId(p, 'PSE-2').body, '', 'no description is an empty body (so a cleared text is cleared)');
	assert.equal(byId(p, 'INS-9').fields.archived, '2025-03-01T10:00:00.000Z');
	assert.equal(p.counts.dangling.issues, undefined);
});

test('the order is oldest first and the same whatever the input order; the counts are per team', () => {
	const e = buildExport();
	const a = plan(e);
	const reversed = { ...e, issues: [...e.issues].reverse() };
	const b = plan(reversed);
	assert.deepEqual(a.issues.map((i) => i.fields.id), ['PSE-1', 'PSE-2', 'INS-9']);
	assert.equal(JSON.stringify(a.issues), JSON.stringify(b.issues));
	assert.equal(a.counts.read, 3);
	assert.deepEqual(a.counts.byTeam, { PSE: { read: 2, archived: 0, withAliases: 1, flagged: 0 }, INS: { read: 1, archived: 1, withAliases: 0, flagged: 0 } });
	assert.equal(a.counts.archived, 1);
});

test('a priority or an estimate the board does not know is kept as text, not dropped', () => {
	assert.equal(boardPriority(0), 0);
	assert.equal(boardPriority(4), 4);
	assert.equal(boardPriority(5), '5');
	assert.equal(boardPriority(-1), '-1');
	assert.equal(boardPriority(2.5), '2.5');
	assert.equal(boardPriority(null), undefined);
	assert.equal(boardEstimate(3), 3);
	assert.equal(boardEstimate(0.5), 0.5);
	assert.equal(boardEstimate('XL'), 'XL');
	assert.equal(boardEstimate(Number.NaN), 'NaN');
	assert.equal(boardEstimate(undefined), undefined);
	const e = buildExport();
	e.issues[0].priority = 9;
	e.issues[0].estimate = 13;
	const f = byId(plan(e), 'PSE-1').fields;
	assert.equal(f.priority, '9');
	assert.equal(f.estimate, 13);
});

test('aliases: every earlier key is kept; the card own key, a repeat and a text that is no key are not', () => {
	const e = buildExport();
	e.issues[1].previousKeys = ['INS-5', 'PSE-2', 'INS-5', 'ins-6', 'not a key', 'PSE-02'];
	const p = plan(e);
	assert.deepEqual(byId(p, 'PSE-2').fields.aliases, ['INS-5']);
	assert.equal(p.counts.dangling['issues.alias'], 3, 'lower case, plain text and a leading zero are not keys; the repeat and the own key are skipped quietly');
});

test('aliases: a real key is never an alias; a key two issues claim stays with the older one; the dry run counts what is not kept', () => {
	const e = buildExport();
	e.issues[1].previousKeys = ['INS-9', 'INS-5'];
	const a = plan(e);
	assert.equal(a.counts.aliases.conflicts, 1, 'INS-9 is a real card: not kept');
	assert.deepEqual(byId(a, 'PSE-2').fields.aliases, ['INS-5']);
	const f = buildExport();
	f.issues[0].previousKeys = ['INS-5'];
	const b = plan(f);
	assert.equal(b.counts.aliases.conflicts, 1, 'both claim INS-5: the older issue (PSE-1) keeps it');
	assert.deepEqual(byId(b, 'PSE-1').fields.aliases, ['INS-5']);
	assert.equal(byId(b, 'PSE-2').fields.aliases, undefined);
	assert.equal(b.counts.byTeam.PSE.withAliases, 1);
	// an older issue that claims the key of a newer one does not take it from the real card
	const g = buildExport();
	g.issues[0].previousKeys = ['PSE-2'];
	const c = plan(g);
	assert.equal(byId(c, 'PSE-1').fields.aliases, undefined);
	assert.equal(c.counts.aliases.conflicts, 1);
	// one issue listing a key twice is not a conflict
	const h = buildExport();
	h.issues[1].previousKeys = ['INS-5', 'INS-5'];
	assert.equal(plan(h).counts.aliases.conflicts, 0);
	assert.equal(plan(buildExport()).counts.aliases.conflicts, 0);
	assert.equal(plan(buildExport()).counts.aliases.total, 1);
});

test('aliases come in plain order whatever the order in the export', () => {
	const e = buildExport();
	e.issues[1].previousKeys = ['REV-3', 'INS-5', 'AER-9'];
	assert.deepEqual(byId(plan(e), 'PSE-2').fields.aliases, ['AER-9', 'INS-5', 'REV-3']);
});

test('rule A: a branch name made from a redacted title is left out; so is one that reads as flagged with its hyphens spaced; the original is kept in raw', () => {
	const e = buildExport();
	e.issues[0].title = 'Call Pat on 555 010 0199 or mail pat@outside.example.invalid';
	e.issues[0].branchName = 'me/pse-1-call-pat-on-555-010-0199-or-mail-pat-outside-example-invalid';
	e.issues[1].branchName = 'me/pse-2-ring-555-010-0199'; // the title is clean (it was edited later), the branch is not
	e.issues[2].title = 'Mail x@outside.example.invalid';
	e.issues[2].branchName = 'me/ins-9-mail-x-outside-example-invalid'; // nothing in the branch reads as flagged: the redacted title decides
	const p = plan(e);
	assert.equal(byId(p, 'PSE-1').fields.branch, undefined);
	assert.equal(byId(p, 'PSE-2').fields.branch, undefined);
	assert.equal(JSON.stringify(p.issues).includes('0199'), false);
	assert.equal(JSON.stringify(p.issues).includes('outside-example'), false);
	assert.equal(byId(p, 'INS-9').fields.branch, undefined);
	assert.equal(p.counts.branchesLeftOut, 3);
	assert.equal(p.counts.flagged, 3);
	assert.equal(p.raw.find((r) => r.id === 'PSE-1').record.branch, 'me/pse-1-call-pat-on-555-010-0199-or-mail-pat-outside-example-invalid');
	assert.equal(p.raw.find((r) => r.id === 'PSE-2').record.branch, 'me/pse-2-ring-555-010-0199');
	// a clean one stays, and a flagged DESCRIPTION alone does not take the branch (it is made from the title)
	const f = buildExport();
	f.issues[0].description = 'Call 555-010-0199.';
	f.issues[0].branchName = 'me/pse-1-invented-parent-issue';
	const q = plan(f);
	assert.equal(byId(q, 'PSE-1').fields.branch, 'me/pse-1-invented-parent-issue');
	assert.equal(q.counts.branchesLeftOut, 0);
	assert.equal(q.raw[0].record.branch, undefined);
});

test('rule A: a branch name that holds an address as typed (a hyphen in its domain) is left out too, and kept in raw', () => {
	const e = buildExport();
	const typed = 'me/pse-1-mail-pat@outside-example.invalid'; // the title is clean; read with its hyphens spaced this is no address
	e.issues[0].branchName = typed;
	const p = plan(e);
	assert.equal(byId(p, 'PSE-1').fields.branch, undefined);
	assert.equal(JSON.stringify(p.issues).includes('pat@'), false);
	assert.equal(p.counts.branchesLeftOut, 1);
	assert.equal(p.raw.find((r) => r.id === 'PSE-1').record.branch, typed);
});

test('rule A: an address typed into a branch name and followed by more words is left out too', () => {
	const e = buildExport();
	const typed = ['me/pse-1-reply-to-pat@acme-corp.com-asap', 'pse-2/pat@outside-example.invalid-fix', 'me/ins-9-pat@outside-example.com_later'];
	e.issues[0].branchName = typed[0];
	e.issues[1].branchName = typed[1];
	e.issues[2].branchName = typed[2];
	const p = plan(e);
	for (const id of ['PSE-1', 'PSE-2', 'INS-9']) assert.equal(byId(p, id).fields.branch, undefined, id);
	assert.equal(p.counts.branchesLeftOut, 3);
	assert.equal(JSON.stringify(p.issues).includes('pat@'), false);
	assert.deepEqual(['PSE-1', 'PSE-2', 'INS-9'].map((id) => p.raw.find((r) => r.id === id).record.branch), typed, 'the originals are in raw');
	// ordinary branch names, with a version tag or an at-sign that is no address, stay
	const f = buildExport();
	f.issues[0].branchName = 'me/pse-1-release-notes@2x-draft';
	f.issues[1].branchName = 'me/pse-2-fix-the-login-bug';
	const q = plan(f);
	assert.equal(byId(q, 'PSE-1').fields.branch, 'me/pse-1-release-notes@2x-draft');
	assert.equal(byId(q, 'PSE-2').fields.branch, 'me/pse-2-fix-the-login-bug');
	assert.equal(q.counts.branchesLeftOut, 0);
});

test('the order is by instant, not by text: an offset does not reorder issues; ties go to team, number, key; started and canceled dates are kept', () => {
	const e = buildExport();
	e.issues[0].createdAt = '2025-01-20T10:00:00.000Z';
	e.issues[1].createdAt = '2025-01-20T11:00:00.000+02:00'; // 09:00Z: earlier than the first although the text sorts later
	e.issues[2].createdAt = '2025-01-20T10:00:00.000Z'; // ties with PSE-1: INS before PSE
	e.issues[0].startedAt = '2025-01-21T10:00:00.000Z';
	e.issues[2].canceledAt = '2025-01-22T10:00:00.000Z';
	const p = plan(e);
	assert.deepEqual(p.issues.map((i) => i.fields.id), ['PSE-2', 'INS-9', 'PSE-1']);
	assert.equal(byId(p, 'PSE-1').fields.started, '2025-01-21T10:00:00.000Z');
	assert.equal(byId(p, 'INS-9').fields.canceled, '2025-01-22T10:00:00.000Z');
	const q = plan({ ...e, issues: [...e.issues].reverse() });
	assert.equal(JSON.stringify(q.issues), JSON.stringify(p.issues));
});

test('parents resolve by key whatever the order, the team or the state of the parent; a parent that is not there is counted', () => {
	const e = buildExport();
	e.issues[0].parentId = 'i-3'; // an archived card of another team, listed after it
	e.issues[2].parentId = 'i-nowhere';
	e.issues[1].parentId = 'i-2'; // itself
	const p = plan(e);
	assert.equal(byId(p, 'PSE-1').fields.parent, 'INS-9');
	assert.equal(byId(p, 'INS-9').fields.parent, undefined);
	assert.equal(byId(p, 'PSE-2').fields.parent, undefined);
	assert.equal(p.counts.dangling['issues.parent'], 2);
	assert.equal(p.counts.parents, 1);
});

test('a reference that is not there is counted and the issue is still written; ids that are property names are plain keys', () => {
	const e = buildExport();
	const i = e.issues[0];
	Object.assign(i, { stateId: 's-x', projectId: 'p-x', milestoneId: 'm-x', cycleId: 'c-x', assigneeId: '__proto__', creatorId: 'constructor', labelIds: ['l-x', '__proto__'], teamKey: 'ZZZ' });
	const p = plan(e);
	const f = p.issues.find((x) => x.fields.linearId === 'i-1').fields;
	assert.equal(f.status, undefined);
	assert.equal(f.project, undefined);
	assert.equal(f.assignee, undefined);
	assert.equal(f.labels, undefined);
	for (const what of ['issues.state', 'issues.project', 'issues.milestone', 'issues.cycle', 'issues.assignee', 'issues.creator', 'issues.label', 'issues.team']) assert.ok(p.counts.dangling[what] >= 1, what);
	assert.equal(p.counts.dangling['issues.label'], 2);
});

test('a cycle of an unknown team (not written by the reference import) is not linked', () => {
	const e = buildExport();
	e.cycles.push({ id: 'c-9', teamKey: 'ZZZ', number: 1, startsAt: '2025-01-01', endsAt: '2025-01-08' });
	e.issues[2].cycleId = 'c-9';
	const p = plan(e);
	assert.equal(byId(p, 'INS-9').fields.cycle, undefined);
	assert.equal(p.counts.dangling['issues.cycle'], 1);
});

test('rule A: an outside address or phone number in a title or description is redacted; the original is kept in raw', () => {
	const e = buildExport();
	e.issues[0].title = 'Ask stranger@outside.example.invalid';
	e.issues[0].description = 'Call 555-010-0199 tomorrow.';
	const p = plan(e);
	const synced = JSON.stringify(byId(p, 'PSE-1'));
	assert.equal(synced.includes('stranger@'), false);
	assert.equal(synced.includes('0199'), false);
	assert.match(synced, /\[email\]/);
	assert.match(synced, /\[phone\]/);
	assert.equal(p.counts.flagged, 1);
	assert.equal(p.counts.byTeam.PSE.flagged, 1);
	assert.equal(p.raw.length, 1);
	assert.deepEqual(p.raw.map((r) => [r.type, r.id]), [['issues', 'PSE-1']]);
	assert.match(JSON.stringify(p.raw[0].record), /stranger@outside/);
	assert.match(JSON.stringify(p.raw[0].record), /0199/);
	assert.match(p.report.format(), /PSE +title +2 +1 +0 +1/, 'the report counts texts and holds no value');
	assert.match(p.report.format(), /PSE +description +1 +0 +1 +1/, 'the description is counted too');
	assert.equal(p.report.format().includes('stranger'), false);
});

test('rule A: our own domain is not redacted; clean texts make no raw record; shared names never flag an issue', () => {
	const e = buildExport();
	e.issues[0].description = 'Ask someone@pollensense.com.';
	e.states[0].name = 'Todo or ask@outside.example.invalid';
	e.labels[1].name = 'Portal 555-010-0199';
	const p = plan(e);
	assert.match(byId(p, 'PSE-1').body, /someone@pollensense\.com/);
	assert.equal(p.raw.length, 0, 'the state and label names are A4\'s (their originals are in raw/names)');
	assert.equal(p.counts.flagged, 0);
	assert.equal(JSON.stringify(byId(p, 'PSE-1').fields).includes('ask@'), false, 'but the issue file holds them redacted');
	assert.equal(JSON.stringify(byId(p, 'PSE-1').fields).includes('0199'), false);
});

test('the plan needs the reference plan of the same export', () => {
	const e = buildExport();
	for (const bad of [undefined, null, {}, { people: {}, projects: [], labels: {}, cycles: [] }]) {
		assert.throws(() => planIssues(e, bad), (err) => err instanceof ImportError && err.code === 'no-reference');
	}
});

test('an export of the inventory\'s size gives the inventory\'s counts: 1,464 issues, 573 archived, 600 with an earlier key', () => {
	const e = buildInventorySizedIssues();
	const p = plan(e);
	assert.equal(p.counts.read, 1464);
	assert.deepEqual(Object.fromEntries(Object.entries(p.counts.byTeam).map(([k, v]) => [k, v.read])), { PSE: 1030, INS: 178, REV: 130, AER: 126 });
	assert.deepEqual(Object.fromEntries(Object.entries(p.counts.byTeam).map(([k, v]) => [k, v.archived])), { PSE: 439, INS: 118, REV: 6, AER: 10 });
	assert.equal(p.counts.archived, 573);
	assert.equal(p.counts.aliases.issues, 600);
	assert.equal(p.counts.aliases.conflicts, 0);
	assert.equal(p.counts.parents, e.issues.filter((i) => i.parentId).length);
	assert.deepEqual(p.counts.dangling, {});
});

test('labels are listed in plain order whatever the order in Linear; a milestone name is redacted like A4\'s', () => {
	const e = buildExport();
	e.labels.push({ id: 'l-9', name: 'Zed', teamKey: null, isGroup: false }, { id: 'l-8', name: 'Alpha', teamKey: null, isGroup: false });
	e.issues[0].labelIds = ['l-9', 'l-2', 'l-8'];
	e.milestones[0].name = 'Mail m@outside.example.invalid';
	const p = plan(e);
	const f = byId(p, 'PSE-1').fields;
	assert.deepEqual(f.labels, ['Alpha', 'Area/Portal', 'Zed']);
	assert.equal(f.milestone.includes('m@outside'), false);
	assert.match(f.milestone, /\[email\]/);
	assert.equal(p.counts.flagged, 0, 'the milestone name belongs to the project (A4), not to this issue');
});

test('a dry run is the same plan: no file, no raw record, and the same counts as a real run', () => {
	const e = buildExport();
	e.issues[0].description = 'Call 555-010-0199.';
	const a = plan(e);
	const b = plan(e);
	assert.equal(JSON.stringify(a.counts), JSON.stringify(b.counts));
	assert.equal(JSON.stringify(a.raw), JSON.stringify(b.raw));
});
