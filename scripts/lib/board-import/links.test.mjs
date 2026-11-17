import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImportError, cmpKeys, planIssues, planLinks, planReference, prState, withLinks } from './index.mjs';
import { MEMBERS, buildExport } from './fixture.mjs';
import { serializeThread } from '../board/index.mjs';

/**
 * Invented data only: names, texts, addresses and numbers are made up (`example.invalid` never resolves; the numbers
 * are not real phone numbers). Nothing here comes from a tracker.
 */

function run(e) {
	const reference = planReference(e, { members: MEMBERS });
	const issues = planIssues(e, reference);
	const links = planLinks(e, issues, reference);
	return { reference, issues, links };
}
const fieldsOf = (r, id) => r.links.fields.get(id);
const threadOf = (r, id) => r.links.threads.find((t) => t.id === id)?.entries;

/** An export with more issues, so relations have somewhere to point: PSE-1, PSE-2 (earlier key INS-5), INS-9 and PSE-10. */
function exportWith(extra = {}) {
	const e = buildExport();
	e.issues.push({ id: 'i-10', key: 'PSE-10', teamKey: 'PSE', number: 10, title: 'Tenth', createdAt: '2025-01-23T10:00:00.000Z', stateId: 's-1', labelIds: [], previousKeys: [] });
	e.relations = [];
	e.attachments = [];
	e.comments = [];
	return Object.assign(e, extra);
}
const rel = (id, type, issueKey, relatedIssueKey) => ({ id, type, issueKey, relatedIssueKey });
const att = (id, issueKey, url, extra = {}) => ({ id, issueKey, sourceType: 'github', url, ...extra });
const com = (id, issueKey, body, extra = {}) => ({ id, issueKey, body, createdAt: '2025-02-01T09:00:00.000Z', authorId: 'u-1', ...extra });

// ---------------------------------------------------------------------------------------------------- relations

test('relations: blocks gives blockedBy on the other side, related is on both sides, duplicate names the original', () => {
	const e = exportWith({
		relations: [rel('r1', 'blocks', 'PSE-1', 'PSE-2'), rel('r2', 'related', 'PSE-1', 'PSE-10'), rel('r3', 'duplicate', 'PSE-10', 'INS-9')],
	});
	const r = run(e);
	assert.deepEqual(fieldsOf(r, 'PSE-1').relations, { blocks: ['PSE-2'], related: ['PSE-10'] });
	assert.deepEqual(fieldsOf(r, 'PSE-2').relations, { blockedBy: ['PSE-1'] });
	assert.deepEqual(fieldsOf(r, 'PSE-10').relations, { related: ['PSE-1'], duplicateOf: 'INS-9' });
	assert.equal(fieldsOf(r, 'INS-9'), undefined, 'the original carries nothing for a duplicate (derived later)');
	assert.deepEqual(r.links.counts.relations.written, { blocks: 1, duplicate: 1, related: 1 });
	assert.equal(r.links.counts.relations.read, 3);
});

test('relations: keys sort as numbers, an earlier key finds the moved card, and the arrays do not depend on the input order', () => {
	const many = Array.from({ length: 11 }, (_, i) => {
		const n = i + 1;
		return { id: `i-m${n}`, key: `REV-${n}`, teamKey: 'REV', number: n, title: `Many ${n}`, createdAt: `2025-03-${String(n).padStart(2, '0')}T10:00:00.000Z`, stateId: 's-1', labelIds: [], previousKeys: [] };
	});
	const e = exportWith();
	e.teams.push({ id: 't-3', key: 'REV', name: 'Test Review', private: false, cyclesEnabled: false });
	e.states.push({ id: 's-9', name: 'Todo', type: 'unstarted', teamKey: 'REV' });
	for (const m of many) m.stateId = 's-9';
	e.issues.push(...many);
	e.relations = [rel('r1', 'blocks', 'PSE-1', 'REV-10'), rel('r2', 'blocks', 'PSE-1', 'REV-9'), rel('r3', 'blocks', 'PSE-1', 'INS-5')];
	const a = run(e);
	assert.deepEqual(fieldsOf(a, 'PSE-1').relations.blocks, ['PSE-2', 'REV-9', 'REV-10'], 'INS-5 is the earlier key of PSE-2; REV-9 sorts before REV-10');
	const b = run({ ...e, relations: [...e.relations].reverse() });
	assert.equal(JSON.stringify([...a.links.fields]), JSON.stringify([...b.links.fields]));
	assert.equal(cmpKeys('PSE-9', 'PSE-10'), -1);
	assert.equal(cmpKeys('INS-9', 'PSE-1'), -1);
});

test('relations: a key nobody holds, a relation to the issue itself, a repeat and a type the board does not know are counted and left out', () => {
	const e = exportWith({
		relations: [
			rel('r1', 'blocks', 'PSE-1', 'PSE-404'),
			rel('r2', 'blocks', 'PSE-2', 'PSE-2'),
			rel('r3', 'blocks', 'PSE-1', 'PSE-10'),
			rel('r4', 'blocks', 'PSE-1', 'PSE-10'),
			rel('r5', 'related', 'PSE-1', 'PSE-2'),
			rel('r6', 'related', 'PSE-2', 'PSE-1'),
			rel('r7', 'similar', 'PSE-1', 'PSE-10'),
			rel('r8', 'duplicate', 'ZZZ-1', 'PSE-1'),
		],
	});
	const r = run(e);
	const c = r.links.counts;
	assert.deepEqual(c.dangling, { 'relations.issue': 2 });
	assert.equal(c.relations.selfRelations, 1);
	assert.equal(c.relations.repeated, 2, 'the same blocks twice, and the same related pair from the other side');
	assert.equal(c.relations.unknownType, 1);
	assert.deepEqual(c.relations.written, { blocks: 1, duplicate: 0, related: 1 });
	assert.deepEqual(fieldsOf(r, 'PSE-1').relations, { blocks: ['PSE-10'], related: ['PSE-2'] });
});

test('relations: a second "duplicate of" is kept as a related issue on both sides, never dropped', () => {
	const e = exportWith({ relations: [rel('r1', 'duplicate', 'PSE-10', 'PSE-2'), rel('r2', 'duplicate', 'PSE-10', 'PSE-1')] });
	const r = run(e);
	assert.deepEqual(fieldsOf(r, 'PSE-10').relations, { related: ['PSE-2'], duplicateOf: 'PSE-1' });
	assert.deepEqual(fieldsOf(r, 'PSE-2').relations, { related: ['PSE-10'] });
	assert.equal(r.links.counts.relations.duplicateExtra, 1);
});

test('keys: a real key always wins over an alias, even in a plan that lists the alias twice', () => {
	const issuesPlan = { issues: [{ fields: { id: 'PSE-1', aliases: ['PSE-2', 'INS-5'] } }, { fields: { id: 'PSE-2' } }, { fields: { id: 'PSE-3', aliases: ['INS-5'] } }], raw: [], counts: {}, report: undefined };
	const reference = { people: { people: {} } };
	const e = { relations: [rel('r1', 'blocks', 'PSE-3', 'PSE-2'), rel('r2', 'blocks', 'PSE-3', 'INS-5')] };
	const l = planLinks(e, issuesPlan, reference);
	assert.deepEqual(l.fields.get('PSE-3').relations.blocks, ['PSE-1', 'PSE-2'], 'PSE-2 is the real card PSE-2, not an alias of PSE-1; INS-5 goes to the first issue that lists it');
});

// ---------------------------------------------------------------------------------------------------- pull requests

test('pull requests: the address is rebuilt, the state comes from the status, then the dates; nothing else of the metadata is kept', () => {
	const e = exportWith({
		attachments: [
			att('a1', 'PSE-1', 'https://github.com/example-org/example-repo/pull/12?diff=split#files', { metadata: { status: 'merged', number: 12, repoName: 'example-repo', reviewer: 'someone', branch: 'x/y' } }),
			att('a2', 'PSE-1', 'https://github.com/example-org/other-repo/pull/3', { metadata: { status: 'closed' } }),
			att('a3', 'PSE-2', 'https://github.com/example-org/example-repo/pull/12', { metadata: { mergedAt: '2025-02-01T00:00:00Z' } }),
			att('a4', 'PSE-10', 'https://github.com/example-org/example-repo/pull/99', { metadata: { closedAt: '2025-02-01T00:00:00Z' } }),
			att('a5', 'PSE-10', 'https://github.com/example-org/example-repo/pull/100'),
			att('a6', 'INS-9', 'https://github.com/example-org/example-repo/pull/101', { metadata: { status: 'inReview' } }),
		],
	});
	const r = run(e);
	assert.deepEqual(fieldsOf(r, 'PSE-1').prs, [
		{ url: 'https://github.com/example-org/example-repo/pull/12', repo: 'example-repo', number: 12, state: 'merged' },
		{ url: 'https://github.com/example-org/other-repo/pull/3', repo: 'other-repo', number: 3, state: 'closed' },
	]);
	assert.deepEqual(fieldsOf(r, 'PSE-2').prs, [{ url: 'https://github.com/example-org/example-repo/pull/12', repo: 'example-repo', number: 12, state: 'merged' }], 'the same pull request on another issue is that issue\'s own entry');
	assert.deepEqual(fieldsOf(r, 'PSE-10').prs.map((p) => [p.number, p.state]), [[99, 'closed'], [100, 'open']]);
	assert.equal(fieldsOf(r, 'INS-9').prs[0].state, 'open');
	assert.deepEqual(r.links.counts.prs, { read: 6, written: 6, byState: { open: 2, closed: 2, merged: 2 }, repeated: 0, flagged: 0 });
	assert.equal(JSON.stringify(r.links.fields).includes('someone'), false, 'no reviewer, no branch, no title');
	assert.equal(fieldsOf(r, 'PSE-1').links, undefined);
});

test('pull requests: the state rules', () => {
	assert.equal(prState({ status: 'merged', closedAt: 'x' }), 'merged');
	assert.equal(prState({ status: 'MERGED' }), 'merged');
	assert.equal(prState({ status: 'closed', mergedAt: '2025-01-01T00:00:00Z' }), 'closed', 'the status wins over a date');
	assert.equal(prState({ status: 'open', mergedAt: '2025-01-01T00:00:00Z' }), 'open');
	assert.equal(prState({ status: 'draft' }), 'open');
	assert.equal(prState({ status: 'something new', mergedAt: '2025-01-01T00:00:00Z' }), 'merged');
	assert.equal(prState({ closedAt: '2025-01-01T00:00:00Z' }), 'closed');
	assert.equal(prState({ closedAt: '' }), 'open');
	assert.equal(prState(undefined), 'open');
	assert.equal(prState('text'), 'open');
	assert.equal(prState([]), 'open');
});

test('pull requests: the same address twice on one issue is one entry; a github link that is not a pull request, or another source, is a link', () => {
	const e = exportWith({
		attachments: [
			att('a1', 'PSE-1', 'https://github.com/example-org/example-repo/pull/12'),
			att('a2', 'PSE-1', 'https://github.com/example-org/example-repo/pull/12/files'),
			att('a3', 'PSE-1', 'https://github.com/example-org/example-repo/issues/5'),
			att('a4', 'PSE-1', 'https://github.com/example-org/example-repo/pull/13', { sourceType: 'api' }),
			att('a5', 'PSE-1', 'https://github.com/example-org/example-repo/pull/0'),
		],
	});
	const r = run(e);
	assert.equal(fieldsOf(r, 'PSE-1').prs.length, 1);
	assert.equal(r.links.counts.prs.repeated, 1);
	assert.equal(r.links.counts.prs.read, 2);
	assert.equal(fieldsOf(r, 'PSE-1').links.length, 3);
});

test('pull requests: a pull request on an issue nobody holds is dangling', () => {
	const r = run(exportWith({ attachments: [att('a1', 'PSE-404', 'https://github.com/example-org/example-repo/pull/12'), att('a2', 'PSE-404', 'https://example.invalid/page')] }));
	assert.deepEqual(r.links.counts.dangling, { 'attachments.issue': 2 });
	assert.equal(r.links.fields.size, 0);
});

// ---------------------------------------------------------------------------------------------------- other links

test('links: url, title and source type are kept, sorted, one entry per address', () => {
	const e = exportWith({
		attachments: [
			att('a1', 'PSE-1', 'https://tracker.example.invalid/browse/X-2', { sourceType: 'jira', title: 'Second' }),
			att('a2', 'PSE-1', 'https://tracker.example.invalid/browse/X-1', { sourceType: 'jira', title: 'First', subtitle: 'dropped', metadata: { secret: 'dropped' } }),
			att('a3', 'PSE-1', 'https://tracker.example.invalid/browse/X-1', { sourceType: 'jira', title: 'First again' }),
			att('a4', 'PSE-1', 'http://plain.example.invalid/a', { sourceType: 'api' }),
			att('a5', 'PSE-1', 'https://chat.example.invalid/t/1', { sourceType: 'Microsoft Teams', title: 'Thread' }),
		],
	});
	const r = run(e);
	assert.deepEqual(fieldsOf(r, 'PSE-1').links, [
		{ url: 'http://plain.example.invalid/a', sourceType: 'api' },
		{ url: 'https://chat.example.invalid/t/1', title: 'Thread', sourceType: 'Microsoft Teams' },
		{ url: 'https://tracker.example.invalid/browse/X-1', title: 'First', sourceType: 'jira' },
		{ url: 'https://tracker.example.invalid/browse/X-2', title: 'Second', sourceType: 'jira' },
	]);
	const c = r.links.counts.links;
	assert.equal(c.read, 5);
	assert.equal(c.written, 4);
	assert.equal(c.repeated, 1);
	assert.deepEqual(c.bySource, { jira: 2, api: 1, 'Microsoft Teams': 1 });
	assert.equal(JSON.stringify(r.links.fields).includes('dropped'), false);
});

test('links: only http and https addresses without a password are kept', () => {
	const bad = ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'ftp://example.invalid/x', 'https://user:pw@example.invalid/x', 'https://user@example.invalid/x', 'not a url', '', '   '];
	const e = exportWith({ attachments: bad.map((url, i) => att(`a${i}`, 'PSE-1', url, { sourceType: 'api' })) });
	e.attachments.push({ id: 'a-no-url', issueKey: 'PSE-1', url: 'x' });
	const r = run(e);
	assert.equal(r.links.counts.links.written, 0);
	assert.equal(r.links.counts.links.refused, bad.length + 1);
	assert.equal(r.links.fields.size, 0);
});

test('links: an outside address or phone number in a title or address is redacted, the original goes to the raw record only', () => {
	const e = exportWith({
		attachments: [
			att('a1', 'PSE-1', 'https://tracker.example.invalid/q?owner=jane@outside.example.invalid', { sourceType: 'jira', title: 'Call 555-010-0199 about it' }),
			att('a2', 'PSE-1', 'https://tracker.example.invalid/ok', { sourceType: 'jira', title: 'Mail nobody.invented@pollensense.com' }),
		],
	});
	const r = run(e);
	const links = fieldsOf(r, 'PSE-1').links;
	const flagged = links.find((l) => l.url.includes('/q?'));
	const internal = links.find((l) => l.url.endsWith('/ok'));
	assert.equal(flagged.url.includes('outside.example.invalid'), false);
	assert.match(flagged.url, /\[email\]/);
	assert.equal(flagged.title, 'Call [phone] about it');
	assert.equal(internal.title, 'Mail nobody.invented@pollensense.com', 'a company address is not redacted');
	assert.equal(JSON.stringify(r.links.fields).includes('555-010-0199'), false);
	assert.equal(r.links.counts.links.flagged, 1, 'the internal address alone is not flagged');
	const raw = r.links.raw.filter((x) => x.type === 'links');
	assert.equal(raw.length, 1);
	assert.equal(raw[0].id, 'PSE-1');
	assert.match(JSON.stringify(raw[0].record), /outside\.example\.invalid/, 'the original is kept locally');
});

test('links: a source type that is not a plain word is "(other)", and a name such as __proto__ is an ordinary count', () => {
	const e = exportWith({
		attachments: [att('a1', 'PSE-1', 'https://example.invalid/a', { sourceType: 'weird<type>' }), att('a2', 'PSE-1', 'https://example.invalid/b', { sourceType: '__proto__' }), att('a3', 'PSE-1', 'https://example.invalid/c', { sourceType: 'constructor' })],
	});
	const r = run(e);
	const by = r.links.counts.links.bySource;
	assert.equal(by['(other)'], 1);
	assert.equal(Object.hasOwn(by, '__proto__'), true);
	assert.equal(by.__proto__, 1);
	assert.equal(by.constructor, 1);
	assert.equal(Object.getPrototypeOf(by), Object.prototype);
});

// ---------------------------------------------------------------------------------------------------- comments

test('comments: one thread entry per comment on an issue, oldest first, author from the people map, a bot or an outside user', () => {
	const e = exportWith({
		comments: [
			com('a-late', 'PSE-1', 'Third.', { createdAt: '2025-02-03T09:00:00.000Z' }),
			com('b-mid', 'PSE-1', 'Second, a bot.', { createdAt: '2025-02-02T09:00:00.000Z', authorId: undefined, botName: 'Test Bot' }),
			com('z-first', 'PSE-1', 'First.', { createdAt: '2025-02-01T09:00:00.000Z' }),
			com('zz-same', 'PSE-1', 'Same instant, later id.', { createdAt: '2025-02-01T09:00:00.000Z', authorId: 'u-2' }),
			com('a-offset', 'PSE-1', 'Same instant written with an offset: the instant first, then the text of the time, then the id.', { createdAt: '2025-02-01T11:00:00+02:00', authorId: 'u-2' }),
			com('c4', 'PSE-1', 'Outside.', { createdAt: '2025-02-04T09:00:00.000Z', authorId: undefined, externalUserName: 'Outside Person' }),
			com('c5', 'PSE-1', 'Nobody.', { createdAt: '2025-02-05T09:00:00.000Z', authorId: undefined }),
			com('c6', 'INS-5', 'On the card that moved.', { createdAt: '2025-02-06T09:00:00.000Z' }),
		],
	});
	const r = run(e);
	assert.deepEqual(threadOf(r, 'PSE-1').map((x) => [x.id, x.author]), [
		['z-first', 'alice'], ['zz-same', 'linear:Test'], ['a-offset', 'linear:Test'], ['b-mid', 'bot:Test Bot'], ['a-late', 'alice'], ['c4', 'external:Outside Person'], ['c5', 'unknown'],
	]);
	assert.deepEqual(threadOf(r, 'PSE-2').map((x) => x.id), ['c6'], 'a comment on an earlier key lands on the card that holds it now');
	assert.deepEqual(r.links.counts.comments.byAuthor, { person: 5, bot: 1, external: 1, unknown: 1 });
	assert.equal(r.links.counts.comments.written, 8);
	const first = threadOf(r, 'PSE-1').find((x) => x.id === 'z-first');
	assert.deepEqual(Object.keys(first).sort(), ['author', 'body', 'id', 'source', 'time']);
	assert.equal(first.source, 'linear');
	assert.equal(first.time, '2025-02-01T09:00:00.000Z');
	assert.doesNotThrow(() => serializeThread(threadOf(r, 'PSE-1')), 'every entry the plan makes is one the thread writer accepts');
});

test('comments: a reply names the comment it answers, if that comment is on the same issue; otherwise it is dangling', () => {
	const e = exportWith({
		comments: [
			com('c1', 'PSE-1', 'Question.'),
			com('c2', 'PSE-1', 'Answer.', { parentId: 'c1', createdAt: '2025-02-01T10:00:00.000Z' }),
			com('c3', 'PSE-1', 'Answer to nothing.', { parentId: 'c-gone', createdAt: '2025-02-01T11:00:00.000Z' }),
			com('c4', 'PSE-1', 'Answer to another issue.', { parentId: 'c5', createdAt: '2025-02-01T12:00:00.000Z' }),
			com('c5', 'PSE-2', 'On another issue.'),
			com('c6', 'PSE-1', 'Answer to itself.', { parentId: 'c6', createdAt: '2025-02-01T13:00:00.000Z' }),
		],
	});
	const r = run(e);
	const t = threadOf(r, 'PSE-1');
	assert.equal(t.find((x) => x.id === 'c2').replyTo, 'c1');
	for (const id of ['c1', 'c3', 'c4', 'c6']) assert.equal(t.find((x) => x.id === id).replyTo, undefined, id);
	assert.equal(r.links.counts.comments.replies, 1);
	assert.equal(r.links.counts.dangling['comments.parent'], 3);
});

test('comments: not on an issue (project, document, update) is counted for later; an issue nobody holds, or no target at all, is dangling', () => {
	const e = exportWith({
		comments: [
			{ id: 'p1', projectId: 'p-1', body: 'On a project.', createdAt: '2025-02-01T09:00:00.000Z' },
			{ id: 'd1', documentId: 'd-1', body: 'On a document.', createdAt: '2025-02-01T09:00:00.000Z' },
			{ id: 'u1', projectUpdateId: 'pu-1', body: 'On an update.', createdAt: '2025-02-01T09:00:00.000Z' },
			{ id: 'u2', projectUpdateId: 'pu-1', body: 'On an update.', createdAt: '2025-02-01T09:00:00.000Z' },
			com('x1', 'PSE-404', 'Lost.'),
			{ id: 'n1', body: 'Nowhere.', createdAt: '2025-02-01T09:00:00.000Z' },
		],
	});
	const r = run(e);
	const c = r.links.counts.comments;
	assert.deepEqual(c.leftForLater, { projects: 1, documents: 1, projectUpdates: 2 });
	assert.equal(c.read, 6);
	assert.equal(c.written, 0);
	assert.deepEqual(r.links.counts.dangling, { 'comments.issue': 1, 'comments.target': 1 });
	assert.deepEqual(r.links.threads, []);
});

test('comments: an outside address or phone number is redacted in the thread and the original goes to raw/comments only', () => {
	const e = exportWith({
		comments: [
			com('c1', 'PSE-1', 'Write to jane@outside.example.invalid or call 555-010-0199. Internal nobody.invented@pollensense.com stays.'),
			com('c2', 'PSE-1', 'Clean.', { createdAt: '2025-02-02T09:00:00.000Z' }),
			com('c3', 'PSE-1', 'Clean text, odd author.', { createdAt: '2025-02-03T09:00:00.000Z', authorId: undefined, externalUserName: 'bob@outside.example.invalid' }),
		],
	});
	const r = run(e);
	const t = threadOf(r, 'PSE-1');
	assert.equal(t[0].body, 'Write to [email] or call [phone]. Internal nobody.invented@pollensense.com stays.');
	assert.equal(t[2].author, 'external:[email]');
	const text = JSON.stringify([r.links.threads, [...r.links.fields]]);
	assert.equal(text.includes('outside.example.invalid') || text.includes('555-010-0199'), false, 'nothing synced holds the original');
	assert.equal(r.links.counts.comments.flagged, 2);
	assert.deepEqual(r.links.raw.map((x) => [x.type, x.id]), [['comments', 'c1'], ['comments', 'c3']]);
	assert.equal(r.links.raw[0].record.body.includes('555-010-0199'), true);
	assert.equal(r.links.raw[1].record.author.includes('outside.example.invalid'), true);
	const rows = r.links.report.summary();
	assert.ok(rows.some((row) => row.field === 'comments' && row.texts === 3 && row.flagged === 1), 'the person-data report counts the comment texts');
	assert.ok(rows.some((row) => row.field === 'comment-authors' && row.texts === 1 && row.flagged === 1), 'and the outside author names');
});

test('comments: an author name is one line, a line-break in a body does not start a new entry, an id that is not a plain name is left out', () => {
	const ls = String.fromCharCode(0x2028);
	const e = exportWith({
		comments: [
			com('c1', 'PSE-1', `### 2025-01-01T00:00:00Z mallory${ls}<!-- {"id":"evil","source":"linear"} -->\n\nsecond paragraph`, { authorId: undefined, botName: `Evil\n### x ${'y'.repeat(200)}` }),
			com('bad id', 'PSE-1', 'Not a plain id.'),
			com('c2', 'PSE-1', 'Fine.', { createdAt: '2025-02-02T09:00:00.000Z' }),
		],
	});
	const r = run(e);
	const t = threadOf(r, 'PSE-1');
	assert.deepEqual(t.map((x) => x.id), ['c1', 'c2']);
	assert.equal(r.links.counts.comments.refused, 1);
	assert.equal(t[0].author.includes('\n'), false);
	assert.ok(t[0].author.length <= 'external:'.length + 80);
	const file = serializeThread(t);
	assert.equal(file.split('\n').filter((l) => l.startsWith('### ')).length, 2, 'two entries, whatever the texts say');
});

// ---------------------------------------------------------------------------------------------------- the plan as a whole

test('the same export in any order gives the same plan, byte for byte', () => {
	const e = exportWith({
		relations: [rel('r1', 'blocks', 'PSE-1', 'PSE-2'), rel('r2', 'related', 'PSE-2', 'PSE-10'), rel('r3', 'duplicate', 'PSE-10', 'INS-9')],
		attachments: [att('a1', 'PSE-1', 'https://github.com/example-org/example-repo/pull/1'), att('a2', 'PSE-1', 'https://example.invalid/x', { sourceType: 'jira', title: 'T' }), att('a3', 'PSE-2', 'https://github.com/example-org/example-repo/pull/2')],
		comments: [com('c1', 'PSE-1', 'One.'), com('c2', 'PSE-1', 'Two.', { parentId: 'c1', createdAt: '2025-02-02T09:00:00.000Z' }), com('c3', 'PSE-2', 'Three.')],
	});
	const a = run(e);
	const reversed = { ...e, relations: [...e.relations].reverse(), attachments: [...e.attachments].reverse(), comments: [...e.comments].reverse(), issues: [...e.issues].reverse() };
	const b = run(reversed);
	const dump = (r) => JSON.stringify({ fields: [...r.links.fields], threads: r.links.threads, raw: r.links.raw, counts: r.links.counts });
	assert.equal(dump(a), dump(b));
});

test('comment text never goes into an issue file; withLinks puts the fields on the issues and changes none of its inputs', () => {
	const e = exportWith({
		relations: [rel('r1', 'blocks', 'PSE-1', 'PSE-2')],
		attachments: [att('a1', 'PSE-1', 'https://github.com/example-org/example-repo/pull/1', { title: 'Pull request title text' })],
		comments: [com('c1', 'PSE-1', 'A comment text that must stay in the thread.')],
	});
	const r = run(e);
	const before = JSON.stringify(r.issues);
	const beforeLinks = JSON.stringify([...r.links.fields]);
	const plan = withLinks(r.issues, r.links);
	assert.equal(JSON.stringify(r.issues), before, 'the issue plan is not changed');
	assert.equal(JSON.stringify([...r.links.fields]), beforeLinks);
	const one = plan.issues.find((i) => i.fields.id === 'PSE-1');
	assert.deepEqual(one.fields.relations, { blocks: ['PSE-2'] });
	assert.equal(one.fields.prs.length, 1);
	assert.equal(JSON.stringify(plan.issues).includes('must stay in the thread'), false);
	assert.equal(JSON.stringify(plan.issues).includes('Pull request title text'), false, 'a pull request keeps no title');
	assert.equal(plan.issues.find((i) => i.fields.id === 'INS-9').fields.relations, undefined);
	assert.equal(plan.threads.length, 1);
	assert.equal(plan.counts.links.comments.written, 1);
	assert.equal(plan.counts.read, 4, 'the issue counts stay');
	assert.equal(plan.report, r.issues.report);
});

test('the link plan needs the issue plan and the reference plan of the same export', () => {
	const e = exportWith();
	const reference = planReference(e, { members: MEMBERS });
	const issues = planIssues(e, reference);
	assert.throws(() => planLinks(e, undefined, reference), (err) => err instanceof ImportError && err.code === 'no-issues-plan');
	assert.throws(() => planLinks(e, {}, reference), (err) => err.code === 'no-issues-plan');
	assert.throws(() => planLinks(e, issues, undefined), (err) => err.code === 'no-reference');
	assert.throws(() => planLinks(e, issues, { people: {} }), (err) => err.code === 'no-reference');
	const none = planLinks({}, issues, reference);
	assert.equal(none.fields.size, 0, 'an export without these types has nothing to link');
	assert.deepEqual(none.threads, []);
});
