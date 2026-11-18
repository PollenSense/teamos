import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardStore, parseDocument } from '../board/index.mjs';
import { applyIssues, formatIssuesSummary, loadExisting, planIssues, planLinks, planReference, withLinks } from './index.mjs';
import { MEMBERS, buildExport } from './fixture.mjs';

/** Invented data only (see links.test.mjs). */

function sandbox() {
	const root = mkdtempSync(join(tmpdir(), 'board-links-'));
	const dir = join(root, 'team', 'board');
	const lockDir = join(root, 'team', '.logs', 'board');
	mkdirSync(dir, { recursive: true });
	return { root, dir, rawDir: join(dir, 'raw'), store: (dryRun = false) => new BoardStore({ dir, lockDir, dryRun }), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function snapshot(dir) {
	const out = {};
	const walk = (d) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else out[p] = `${st.size}:${st.mtimeMs}`;
		}
	};
	if (existsSync(dir)) walk(dir);
	return out;
}

const rel = (id, type, issueKey, relatedIssueKey) => ({ id, type, issueKey, relatedIssueKey });
const com = (id, issueKey, body, extra = {}) => ({ id, issueKey, body, createdAt: '2025-02-01T09:00:00.000Z', authorId: 'u-1', ...extra });

function exportWith(extra = {}) {
	const e = buildExport();
	e.relations = [rel('r1', 'blocks', 'PSE-1', 'PSE-2'), rel('r2', 'related', 'PSE-1', 'INS-9')];
	e.attachments = [
		{ id: 'a1', issueKey: 'PSE-1', sourceType: 'github', url: 'https://github.com/example-org/example-repo/pull/12', metadata: { status: 'merged' } },
		{ id: 'a2', issueKey: 'PSE-1', sourceType: 'jira', url: 'https://tracker.example.invalid/browse/X-1', title: 'Call 555-010-0199' },
	];
	e.comments = [com('c1', 'PSE-1', 'First.'), com('c2', 'PSE-1', 'Second, to jane@outside.example.invalid.', { createdAt: '2025-02-02T09:00:00.000Z', parentId: 'c1' }), com('c3', 'INS-5', 'On the moved card.')];
	return Object.assign(e, extra);
}

async function runLinks(s, entities, { dry = false, guard = async () => ({ where: 'test' }) } = {}) {
	const store = s.store(dry);
	const existing = await loadExisting(store);
	const reference = planReference(entities, { members: MEMBERS, existing });
	const issues = planIssues(entities, reference);
	const links = planLinks(entities, issues, reference, { report: issues.report });
	const plan = withLinks(issues, links);
	const result = await applyIssues(plan, store, { rawDir: s.rawDir, guard });
	return { plan, ...result };
}
const fieldsOf = (s, id) => parseDocument(readFileSync(join(s.dir, 'issues', id.split('-')[0], `${id}.md`), 'utf8')).fields;
const threadText = (s, id) => readFileSync(join(s.dir, 'issues', id.split('-')[0], `${id}.thread.md`), 'utf8');

test('a real run writes the relations, pull requests and links into the issue file and the comments into the thread file', async () => {
	const s = sandbox();
	try {
		const r = await runLinks(s, exportWith());
		assert.deepEqual(r.failures, {});
		assert.deepEqual(fieldsOf(s, 'PSE-1').relations, { blocks: ['PSE-2'], related: ['INS-9'] });
		assert.deepEqual(fieldsOf(s, 'PSE-2').relations, { blockedBy: ['PSE-1'] });
		assert.deepEqual(fieldsOf(s, 'PSE-1').prs, [{ url: 'https://github.com/example-org/example-repo/pull/12', repo: 'example-repo', number: 12, state: 'merged' }]);
		assert.deepEqual(fieldsOf(s, 'PSE-1').links, [{ url: 'https://tracker.example.invalid/browse/X-1', title: 'Call [phone]', sourceType: 'jira' }]);
		const thread = threadText(s, 'PSE-1');
		assert.match(thread, /^### 2025-02-01T09:00:00\.000Z alice\n<!-- \{"id":"c1","source":"linear"\} -->\n> First\.\n\n### 2025-02-02T09:00:00\.000Z alice\n<!-- \{"id":"c2","source":"linear","replyTo":"c1"\} -->\n> Second, to \[email\]\.\n$/);
		assert.equal(readFileSync(join(s.dir, 'issues', 'PSE', 'PSE-1.md'), 'utf8').includes('First.'), false, 'no comment text in the issue file');
		assert.match(threadText(s, 'PSE-2'), /On the moved card\./, 'a comment on an earlier key is in the thread of the card that holds it');
		assert.equal(r.applied.threads.created, 2);
		assert.equal(existsSync(join(s.dir, 'issues', 'INS', 'INS-9.thread.md')), false, 'no comments, no thread file');
		assert.deepEqual(r.checks, { cardsChecked: 3, cardsMissing: 0, aliasesChecked: 1, aliasesBroken: 0, parentsChecked: 1, parentsBroken: 0, relationsChecked: 4, relationsBroken: 0, threadsChecked: 2, threadsBroken: 0 });
		// the originals of redacted texts are local only, written before the synced files
		assert.match(readFileSync(join(s.rawDir, 'comments', 'c2.json'), 'utf8'), /jane@outside\.example\.invalid/);
		assert.match(readFileSync(join(s.rawDir, 'links', 'PSE-1.json'), 'utf8'), /555-010-0199/);
		for (const f of ['issues/PSE/PSE-1.md', 'issues/PSE/PSE-1.thread.md']) assert.equal(/outside\.example|555-010-0199/.test(readFileSync(join(s.dir, f), 'utf8')), false, f);
	} finally {
		s.cleanup();
	}
});

test('a second run writes nothing and touches no file', async () => {
	const s = sandbox();
	try {
		await runLinks(s, exportWith());
		const before = snapshot(s.dir);
		const again = await runLinks(s, exportWith());
		assert.deepEqual(again.failures, {});
		assert.equal(again.applied.threads.unchanged, 2);
		assert.equal(again.applied.threads.created + again.applied.threads.changed, 0);
		assert.deepEqual(snapshot(s.dir), before);
	} finally {
		s.cleanup();
	}
});

test('a dry run writes nothing and counts the files that would be new', async () => {
	const s = sandbox();
	try {
		const r = await runLinks(s, exportWith(), { dry: true });
		assert.equal(r.applied.threads.created, 2);
		assert.equal(existsSync(join(s.dir, 'issues')), false);
		assert.equal(existsSync(s.rawDir), false);
		const text = formatIssuesSummary(r.plan, r, { dryRun: true });
		assert.match(text, /relations: read 2; kept blocks 1, duplicate 0, related 1/);
		assert.match(text, /pull requests: read 1, kept 1 \(merged 1, closed 0, open 0\)/);
		assert.match(text, /links: read 1, kept 1 \(jira 1\)/);
		assert.match(text, /comments: read 3; 3 on issues, 3 written to threads/);
		assert.match(text, /thread files: 2 new, 0 changed, 0 same, 0 failed/);
		assert.doesNotMatch(text, /First\.|jane@|555-010|example-repo/, 'the report holds counts, never a text');
	} finally {
		s.cleanup();
	}
});

test('what Linear removed goes: a relation, a pull request, a link and a comment; a field of a later ticket (deleted) stays', async () => {
	const s = sandbox();
	try {
		await runLinks(s, exportWith());
		// somebody marked the card deleted in the board; that field belongs to a later ticket
		const path = join(s.dir, 'issues', 'PSE', 'PSE-1.md');
		const { fields, body } = parseDocument(readFileSync(path, 'utf8'));
		writeFileSync(path, readFileSync(path, 'utf8').replace('\n---\n', '\ndeleted: "2025-03-01T00:00:00Z"\n---\n'));
		assert.equal(parseDocument(readFileSync(path, 'utf8')).fields.deleted, '2025-03-01T00:00:00Z');
		assert.ok(fields && body !== undefined);
		const e = exportWith({ relations: [], attachments: [], comments: [com('c1', 'PSE-1', 'First.')] });
		const r = await runLinks(s, e);
		assert.deepEqual(r.failures, {});
		const now = fieldsOf(s, 'PSE-1');
		assert.equal(now.relations, undefined);
		assert.equal(now.prs, undefined);
		assert.equal(now.links, undefined);
		assert.equal(now.deleted, '2025-03-01T00:00:00Z');
		assert.equal(fieldsOf(s, 'PSE-2').relations, undefined);
		assert.equal((threadText(s, 'PSE-1').match(/^### /gm) ?? []).length, 1, 'the comment Linear no longer has is gone');
		assert.equal(r.applied.threads.changed, 2, 'PSE-1 lost an entry, PSE-2 lost all of its entries');
		assert.equal(threadText(s, 'PSE-2'), '');
	} finally {
		s.cleanup();
	}
});

test('a comment from another source stays when the import runs again, and Linear\'s entries around it are replaced', async () => {
	const s = sandbox();
	try {
		await runLinks(s, exportWith());
		const store = s.store();
		const current = await store.readThread('PSE-1');
		const native = { time: '2025-02-01T12:00:00.000Z', author: 'bob', id: 'n1', source: 'teamos', body: 'A native comment.' };
		await store.writeThread('PSE-1', [...current.entries, native], { expect: current.hash });
		const r = await runLinks(s, exportWith({ comments: [com('c1', 'PSE-1', 'First, edited in Linear.'), com('c3', 'INS-5', 'On the moved card.')] }));
		assert.deepEqual(r.failures, {});
		const entries = (await s.store().readThread('PSE-1')).entries;
		assert.deepEqual(entries.map((e) => [e.id, e.source]), [['c1', 'linear'], ['n1', 'teamos']], 'c2 is gone, the native comment stays, order by time');
		assert.equal(entries[0].body, 'First, edited in Linear.');
	} finally {
		s.cleanup();
	}
});

test('a thread file that is not a thread (a conflict marker) is counted as failed and left alone; the other files go on', async () => {
	const s = sandbox();
	try {
		await runLinks(s, exportWith());
		const damagedPath = join(s.dir, 'issues', 'PSE', 'PSE-1.thread.md');
		writeFileSync(damagedPath, '<<<<<<< conflict\nsomebody typed here\n');
		const r = await runLinks(s, exportWith({ comments: [com('c1', 'PSE-1', 'First.'), com('c3', 'INS-5', 'Changed on the moved card.')] }));
		assert.equal(r.failures.damaged, 1);
		assert.equal(r.applied.threads.failed, 1);
		assert.equal(r.applied.threads.changed, 1, 'the other thread was rewritten');
		assert.equal(readFileSync(damagedPath, 'utf8'), '<<<<<<< conflict\nsomebody typed here\n');
		assert.equal(r.checks.threadsBroken, 1, 'the check on the files says so too');
	} finally {
		s.cleanup();
	}
});

test('a card that moved teams keeps its thread and gets the relations the plan says, not the old file\'s', async () => {
	const s = sandbox();
	try {
		// first run: the card is still PSE-2 (INS-5 was its earlier key) ... the export of an earlier day had it as INS-5 = a card of its own
		const earlier = exportWith();
		earlier.issues = earlier.issues.map((i) => (i.id === 'i-2' ? { ...i, key: 'INS-5', teamKey: 'INS', number: 5, previousKeys: [] } : i));
		earlier.relations = [rel('r1', 'blocks', 'PSE-1', 'INS-5')];
		earlier.comments = [com('c3', 'INS-5', 'On the card before it moved.')];
		earlier.attachments = [];
		earlier.issues = earlier.issues.map((i) => (i.id === 'i-2' ? { ...i, stateId: 's-3' } : i));
		const first = await runLinks(s, earlier);
		assert.deepEqual(first.failures, {});
		assert.match(threadText(s, 'INS-5'), /before it moved/);
		const second = await runLinks(s, exportWith({ relations: [rel('r1', 'related', 'PSE-1', 'INS-5')], comments: [com('c3', 'INS-5', 'On the card before it moved.')], attachments: [] }));
		assert.deepEqual(second.failures, {});
		assert.equal(existsSync(join(s.dir, 'issues', 'INS', 'INS-5.md')), false, 'the old file is retired');
		assert.match(threadText(s, 'PSE-2'), /before it moved/);
		assert.deepEqual(fieldsOf(s, 'PSE-2').relations, { related: ['PSE-1'] });
		assert.equal(fieldsOf(s, 'PSE-1').relations.blocks, undefined, 'the old "blocks" is gone, the plan says "related"');
	} finally {
		s.cleanup();
	}
});

test('an A5 plan (no thread step) still carries the fields of a later ticket over, as before', async () => {
	const s = sandbox();
	try {
		await runLinks(s, exportWith());
		const store = s.store();
		const e = exportWith();
		const reference = planReference(e, { members: MEMBERS, existing: await loadExisting(store) });
		const issuesOnly = planIssues(e, reference);
		assert.equal(issuesOnly.threads, undefined);
		const r = await applyIssues(issuesOnly, store, { rawDir: s.rawDir, guard: async () => ({}) });
		assert.deepEqual(r.failures, {});
		assert.deepEqual(fieldsOf(s, 'PSE-1').relations, { blocks: ['PSE-2'], related: ['INS-9'] }, 'an issues-only run does not clear them');
		assert.equal(r.applied.threads, undefined);
		assert.equal(r.checks.relationsChecked, undefined);
	} finally {
		s.cleanup();
	}
});

test('a card whose write was refused (a damaged file) gets no thread written', async () => {
	const s = sandbox();
	try {
		await runLinks(s, exportWith());
		writeFileSync(join(s.dir, 'issues', 'PSE', 'PSE-2.md'), 'not a card at all\n');
		const threadBefore = threadText(s, 'PSE-2');
		const r = await runLinks(s, exportWith({ comments: [com('c1', 'PSE-1', 'First.'), com('c3', 'INS-5', 'Edited on the moved card.')] }));
		assert.equal(r.failures.damaged, 1, 'one failure: the card');
		assert.equal(r.applied['issues PSE'].failed, 1);
		assert.equal(r.applied.threads.failed ?? 0, 0);
		assert.equal(threadText(s, 'PSE-2'), threadBefore, 'its thread was not touched');
		assert.equal(r.applied.threads.changed ?? 0, 1, 'only PSE-1 lost its second comment');
	} finally {
		s.cleanup();
	}
});

test('dangling links, relations and comments are in the report, next to the issue plan\'s', async () => {
	const s = sandbox();
	try {
		const e = exportWith({
			relations: [rel('r1', 'blocks', 'PSE-1', 'ZZZ-77')],
			attachments: [{ id: 'a9', issueKey: 'ZZZ-77', sourceType: 'jira', url: 'https://tracker.example.invalid/x' }],
			comments: [com('c1', 'ZZZ-77', 'Lost.'), com('c2', 'PSE-1', 'Author unknown.', { authorId: 'u-missing' })],
		});
		const r = await runLinks(s, e, { dry: true });
		const text = formatIssuesSummary(r.plan, r, { dryRun: true });
		assert.match(text, /dangling references: .*relations\.issue 1/);
		assert.match(text, /attachments\.issue 1/);
		assert.match(text, /comments\.issue 1/);
		assert.match(text, /comments\.author 1/);
		assert.doesNotMatch(text, /dangling references: none/);
		const clean = await runLinks(s, exportWith(), { dry: true });
		assert.match(formatIssuesSummary(clean.plan, clean, { dryRun: true }), /dangling references: none/);
	} finally {
		s.cleanup();
	}
});

test('a native entry whose id a Linear comment now uses stops that thread (counted, exit-worthy), and nothing is lost', async () => {
	const s = sandbox();
	try {
		await runLinks(s, exportWith());
		const store = s.store();
		const current = await store.readThread('PSE-1');
		await store.writeThread('PSE-1', [...current.entries, { time: '2025-02-03T09:00:00.000Z', author: 'bob', id: 'n1', source: 'teamos', body: 'Native.' }], { expect: current.hash });
		const before = threadText(s, 'PSE-1');
		const r = await runLinks(s, exportWith({ comments: [com('n1', 'PSE-1', 'A Linear comment that reuses the id.')] }));
		assert.equal(r.failures['bad-value'], 1);
		assert.equal(threadText(s, 'PSE-1'), before, 'the thread is as it was');
	} finally {
		s.cleanup();
	}
});

test('a dry run says the same about a moved card\'s thread as the real run does', async () => {
	const s = sandbox();
	try {
		const earlier = exportWith();
		earlier.issues = earlier.issues.map((i) => (i.id === 'i-2' ? { ...i, key: 'INS-5', teamKey: 'INS', number: 5, previousKeys: [], stateId: 's-3' } : i));
		earlier.relations = [];
		earlier.attachments = [];
		earlier.comments = [com('c3', 'INS-5', 'On the card before it moved.')];
		await runLinks(s, earlier);
		const store = s.store();
		const old = await store.readThread('INS-5');
		await store.writeThread('INS-5', [...old.entries, { time: '2025-02-03T09:00:00.000Z', author: 'bob', id: 'n1', source: 'teamos', body: 'Native.' }], { expect: old.hash });
		const e = exportWith({ relations: [], attachments: [], comments: [com('c3', 'INS-5', 'On the card before it moved.')] });
		const dry = await runLinks(s, e, { dry: true });
		assert.deepEqual(dry.applied.threads, { created: 0, changed: 0, unchanged: 1, failed: 0 }, 'the thread exists already under the old key, native entry included: nothing new');
		const real = await runLinks(s, e);
		assert.deepEqual(real.applied.threads, dry.applied.threads, 'the real run says the same');
		assert.match(threadText(s, 'PSE-2'), /"id":"n1","source":"teamos"/);
		assert.equal(existsSync(join(s.dir, 'issues', 'INS', 'INS-5.thread.md')), false);
	} finally {
		s.cleanup();
	}
});

test('the check after a real run reads a comment with CRLF or U+2028 line ends as the file stores it, not as broken', async () => {
	const s = sandbox();
	try {
		const e = exportWith();
		e.comments.push(com('c9', 'PSE-1', `first line\r\nsecond${String.fromCodePoint(0x2028)}third\rfourth`, { createdAt: '2025-02-05T09:00:00.000Z' }));
		const r = await runLinks(s, e);
		assert.deepEqual(r.failures, {});
		assert.equal(r.checks.threadsBroken, 0);
		assert.match(threadText(s, 'PSE-1'), /> first line\n> second\n> third\n> fourth/);
	} finally {
		s.cleanup();
	}
});

test('the check after a real run compares whole thread entries: the same comment ids with another text or author is broken', async () => {
	const s = sandbox();
	try {
		const real = s.store();
		let tamper = null;
		const store = new Proxy(real, {
			get(target, key) {
				if (key === 'readThread') return async (id) => {
					const file = await target.readThread(id);
					if (!tamper || !file || id !== 'PSE-1') return file;
					return { ...file, entries: file.entries.map((entry, i) => (i === 0 ? { ...entry, ...tamper } : entry)) };
				};
				const value = target[key];
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		const e = exportWith();
		const reference = planReference(e, { members: MEMBERS });
		const issues = planIssues(e, reference);
		const plan = withLinks(issues, planLinks(e, issues, reference, { report: issues.report }));
		// the run itself is clean ...
		const clean = await applyIssues(plan, store, { rawDir: s.rawDir, guard: async () => ({}) });
		assert.equal(clean.checks.threadsBroken, 0);
		// ... and the same files read back with one comment's text, then its author, then its time changed are each broken, ids unchanged
		for (const change of [{ body: 'Another text.' }, { author: 'someone-else' }, { time: '2025-03-01T09:00:00.000Z' }, { replyTo: 'c9' }, { extra: { added: 1 } }]) {
			tamper = change;
			const r = await applyIssues(plan, store, { rawDir: s.rawDir, guard: async () => ({}) });
			assert.equal(r.checks.threadsBroken, 1, JSON.stringify(change));
		}
		tamper = null;
		assert.equal((await applyIssues(plan, store, { rawDir: s.rawDir, guard: async () => ({}) })).checks.threadsBroken, 0);
	} finally {
		s.cleanup();
	}
});

test('the check after a real run notices an issue file that does not say what the plan said about relations', async () => {
	const s = sandbox();
	try {
		const real = s.store();
		let tamper = false;
		const store = new Proxy(real, {
			get(target, key) {
				if (key === 'writeIssue') return async (...args) => {
					const result = await target.writeIssue(...args);
					if (args[0].fields.id === 'PSE-1') tamper = true;
					return result;
				};
				if (key === 'readIssue') return async (id) => {
					const card = await target.readIssue(id);
					return tamper && card && card.id === 'PSE-1' ? { ...card, fields: { ...card.fields, relations: { blocks: ['PSE-9999'] } } } : card;
				};
				const value = target[key];
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		const e = exportWith();
		const reference = planReference(e, { members: MEMBERS });
		const issues = planIssues(e, reference);
		const plan = withLinks(issues, planLinks(e, issues, reference, { report: issues.report }));
		const r = await applyIssues(plan, store, { rawDir: s.rawDir, guard: async () => ({}) });
		assert.ok(r.checks.relationsBroken >= 1, JSON.stringify(r.checks));
	} finally {
		s.cleanup();
	}
});
