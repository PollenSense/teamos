import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UPLOAD_EXTENSIONS, assertLocalOnly, assertSynced, explain, globToRegexSource, isSynced, matchingRule, parseFilter, probePaths, uploadProbePaths } from './sync-filter.mjs';

// A copy of the rules in pollen-bot's scripts/rclone-filter.txt (comments trimmed), without and with step 0.
const BEFORE = `
# --- Safety net ---
- .git/**
- node_modules/**
# --- Per-machine runtime state ---
- /team/.logs/**
- /team/.stop
- /team/.pause
- /tickets/.logs/**
- /tickets/.runners/*.status
# --- Local-only files ---
- .env
- .DS_Store
`;
const AFTER = `${BEFORE}
- /team/board/raw/**
`;

const synced = (text, p) => isSynced(parseFilter(text), p);

test('step 0: without the line raw/ would sync; with it raw/ is local', () => {
	for (const p of ['team/board/raw/PSE-1.json', 'team/board/raw/a/b/c.json', 'team/board/raw/PSE/PSE-1.json']) {
		assert.equal(synced(BEFORE, p), true, `${p} syncs before the edit`);
		assert.equal(synced(AFTER, p), false, `${p} is local after the edit`);
	}
});

test('uploaded files sync on purpose (Van, 2026-11-13): step 0 does not hide team/board/files', () => {
	for (const p of ['team/board/files/PSE-1/shot.png', 'team/board/files/x', 'team/board/files/PSE-1/a/b.jpg']) {
		assert.equal(synced(BEFORE, p), true, `${p} syncs before the edit`);
		assert.equal(synced(AFTER, p), true, `${p} still syncs after the edit`);
	}
});

test('the line of step 0 does not keep the board itself local', () => {
	for (const p of ['team/board/issues/PSE/PSE-1.md', 'team/board/teams/PSE.json', 'team/board/people.json', 'team/board/projects/ops.md', 'team/board/cycles/PSE/1.json', 'team/board/rawish/x.json', 'team/board/files.json']) {
		assert.equal(synced(AFTER, p), true, p);
	}
});

test('the existing rules keep their meaning: anchored, unanchored, directories', () => {
	assert.equal(synced(AFTER, 'team/.logs/a/b.log'), false);
	assert.equal(synced(AFTER, 'a/b/.git/config'), false);
	assert.equal(synced(AFTER, 'x/node_modules/y/z.js'), false);
	assert.equal(synced(AFTER, 'a/b/.env'), false);
	assert.equal(synced(AFTER, '.env'), false);
	assert.equal(synced(AFTER, 'team/.stop'), false);
	assert.equal(synced(AFTER, 'x/team/.stop'), true, 'an anchored rule does not match deeper');
	assert.equal(synced(AFTER, 'tickets/.runners/a.status'), false);
	assert.equal(synced(AFTER, 'tickets/.runners/sub/a.status'), true, '* does not cross a slash');
	assert.equal(synced(AFTER, 'team/members/cy/state.md'), true);
});

test('glob features: **, ?, classes, alternatives, escapes', () => {
	const t = (rule, p) => isSynced(parseFilter(`- ${rule}`), p);
	assert.equal(t('/a/**', 'a/b/c/d'), false);
	assert.equal(t('/a/*', 'a/b'), false);
	assert.equal(t('/a/*', 'a/b/c'), true, 'a rule with a single star is a file rule: it does not hide what is deeper');
	assert.equal(t('/a/*.txt', 'a/b.txt'), false);
	assert.equal(t('/a/*.txt', 'a/b/c.txt'), true);
	assert.equal(t('/a/b?d', 'a/bcd'), false);
	assert.equal(t('/a/b?d', 'a/b/d'), true, '? does not match a slash');
	assert.equal(t('/a/[bc]x', 'a/bx'), false);
	assert.equal(t('/a/[bc]x', 'a/dx'), true);
	assert.equal(t('/a/[!bc]x', 'a/dx'), false);
	assert.equal(t('/a/[a-c]x', 'a/bx'), false);
	assert.equal(t('/a/{x,y}.md', 'a/y.md'), false);
	assert.equal(t('/a/{x,y}.md', 'a/z.md'), true);
	assert.equal(t('/a/b\\*c', 'a/b*c'), false);
	assert.equal(t('/a/b\\*c', 'a/bzc'), true, 'an escaped star is a plain star');
	assert.equal(t('/a.b', 'aXb'), true, 'a dot is a dot');
});

test('first match wins; an include before an exclude keeps a file; ! clears', () => {
	const text = '+ /a/keep.txt\n- /a/**\n';
	assert.equal(synced(text, 'a/keep.txt'), true);
	assert.equal(synced(text, 'a/other.txt'), false);
	assert.equal(synced('- /a/**\n+ /a/keep.txt\n', 'a/keep.txt'), false, 'the exclude came first');
	assert.equal(synced('- /a/**\n!\n', 'a/x'), true, '! drops the rules before it');
	assert.equal(matchingRule(parseFilter(text), 'a/keep.txt').line, 1);
	assert.equal(matchingRule(parseFilter(text), 'b/c'), null);
});

test('a rule that ends with a slash is the same as dir/** (directory and file rule)', () => {
	const rules = parseFilter('- cache/\n');
	assert.equal(isSynced(rules, 'a/cache/x'), false);
	assert.equal(isSynced(rules, 'cache/x'), false);
	assert.equal(isSynced(rules, 'a/cache/deep/er/x'), false);
	assert.equal(isSynced(rules, 'a/cache'), true, 'a file called cache is not a directory');
});

test('a directory rule stops the walk: nothing below an excluded directory syncs, even with a later include', () => {
	assert.equal(synced('- /a/**\n+ /a/keep.txt\n', 'a/keep.txt'), false);
	assert.equal(synced('- /a/\n+ /a/b/keep.txt\n', 'a/b/keep.txt'), false);
	assert.equal(synced('+ /a/b/keep.txt\n- /a/**\n', 'a/b/keep.txt'), true, 'the include comes first, so rclone enters a/ and a/b/');
	assert.equal(synced('+ /a/b/keep.txt\n- /a/**\n', 'a/b/other.txt'), false);
	assert.equal(synced('+ /a/b/keep.txt\n- /a/**\n', 'a/c/keep.txt'), false);
	assert.equal(synced('+ keep.txt\n- /a/**\n', 'a/keep.txt'), false, 'an include of the file name does not reopen a directory an exclude closed');
	assert.equal(synced('+ keep.txt\n- /a/**\n', 'b/keep.txt'), true);
	assert.equal(explain(parseFilter('+ keep.txt\n- /a/**\n'), 'a/keep.txt').rule.line, 2, 'the directory rule is named');
	const e = explain(parseFilter('- /a/**\n'), 'a/x/y.txt');
	assert.equal(e.synced, false);
	assert.equal(e.rule.line, 1);
});

test('a file rule alone does not hide a deeper file; a star rule does not hide a directory walk', () => {
	assert.equal(synced('- /a/*\n', 'a/b.txt'), false);
	assert.equal(synced('- /a/*\n', 'a/b/c.txt'), true);
	assert.equal(synced('- .env\n', 'x/.env/y'), true, '.env as a directory name is not the file rule .env');
});

test('comments, blank lines, CRLF and indentation are fine', () => {
	const rules = parseFilter('# a\r\n\r\n  ; b\r\n  - /x/**  \r\n');
	assert.equal(rules.fileRules.length, 1);
	assert.equal(isSynced(rules, 'x/y'), false);
});

test('a line that cannot be read is an error, not a skipped rule', () => {
	for (const bad of ['garbage', '-', '- ', '+', '-/x/**', '* /x', '- /x/[ab', '- /x/{a,b', '- /x/trailing\\', '- /x/[]', '- ///']) {
		assert.throws(() => parseFilter(bad), (e) => e.code === 'filter-unreadable', JSON.stringify(bad));
	}
	assert.throws(() => parseFilter(42), (e) => e.code === 'filter-unreadable');
});

test('{{regexp}} patterns are refused (rclone reads them as regular expressions, this module does not); escaped or class braces are plain', () => {
	for (const bad of ['+ /team/board/raw/{{users|issues}}.json', '- /team/board/{{raw}}/**', '- /x/{{a,b}}', '- {{.*}}']) {
		assert.throws(() => parseFilter(bad), (e) => e.code === 'filter-unreadable', bad);
	}
	// The same text, with the braces escaped or inside a class, is an ordinary glob and still parses.
	for (const fine of ['- /x/\\{\\{a\\}\\}', '- /x/[{{]a', '- /x/{a,{b,c}}', '- /x/a{b}']) assert.doesNotThrow(() => parseFilter(fine), fine);
});

test('assertLocalOnly: an include written as {{regexp}} before the raw exclude fails closed, it does not pass', () => {
	const ws = workspace();
	try {
		const filterText = '+ /team/board/raw/{{users|issues}}.json\n- /team/board/raw/**\n';
		assert.throws(() => assertLocalOnly('team/board/raw', { workspaceRoot: ws, filterText }), (e) => e.code === 'filter-unreadable');
	} finally {
		rmSync(ws, { recursive: true, force: true });
	}
});

test('paths that leave the folder or are empty are refused', () => {
	const rules = parseFilter(AFTER);
	for (const bad of ['', '../x', 'a/../../x', '/', './']) {
		assert.throws(() => isSynced(rules, bad), (e) => e.code === 'bad-path', JSON.stringify(bad));
	}
	assert.equal(isSynced(rules, '/team/board/raw/x.json'), false, 'a leading slash is tolerated');
});

test('globToRegexSource escapes everything it does not mean', () => {
	assert.equal(new RegExp(`^${globToRegexSource('a.b(c)+d|e^f$g')}$`).test('a.b(c)+d|e^f$g'), true);
	assert.equal(new RegExp(`^${globToRegexSource('a.b')}$`).test('aXb'), false);
});

test('probePaths cover the top, one level, two levels and a dot name', () => {
	assert.deepEqual(probePaths('team/board/raw'), ['team/board/raw/probe.json', 'team/board/raw/a/probe.json', 'team/board/raw/a/b/probe.png', 'team/board/raw/.probe']);
});

// ---- the guard ----

function workspace() {
	const root = mkdtempSync(join(tmpdir(), 'board-export-ws-'));
	mkdirSync(join(root, 'team', 'board'), { recursive: true });
	return root;
}

test('assertLocalOnly: a folder outside the workspace is fine, with no filter line', () => {
	const ws = workspace();
	const out = mkdtempSync(join(tmpdir(), 'board-export-out-'));
	try {
		assert.deepEqual(assertLocalOnly(out, { workspaceRoot: ws, filterText: BEFORE }), { where: 'outside', rel: null });
	} finally {
		rmSync(ws, { recursive: true, force: true });
		rmSync(out, { recursive: true, force: true });
	}
});

test('assertLocalOnly: inside the workspace needs the filter lines, and says what to add', () => {
	const ws = workspace();
	try {
		assert.throws(
			() => assertLocalOnly('team/board/raw', { workspaceRoot: ws, filterText: BEFORE }),
			(e) => e.code === 'export-synced' && /team\/board\/raw/.test(e.message) && /--resync/.test(e.message) && /- \/team\/board\/raw\/\*\*/.test(e.message),
		);
		assert.deepEqual(assertLocalOnly('team/board/raw', { workspaceRoot: ws, filterText: AFTER }), { where: 'filtered', rel: 'team/board/raw' });
		// uploads are not local on purpose: a writer that asked for local-only there would be refused
		assert.throws(() => assertLocalOnly(join(ws, 'team', 'board', 'files'), { workspaceRoot: ws, filterText: AFTER }), (e) => e.code === 'export-synced');
		assert.throws(() => assertLocalOnly('team/board/issues', { workspaceRoot: ws, filterText: AFTER }), (e) => e.code === 'export-synced');
	} finally {
		rmSync(ws, { recursive: true, force: true });
	}
});

test('assertLocalOnly: a filter that covers only one depth or one extension is not enough', () => {
	const ws = workspace();
	try {
		for (const rule of ['- /team/board/raw/*', '- /team/board/raw/*.json', '- /team/board/raw/a/**', '- /team/board/raw/probe.json']) {
			assert.throws(() => assertLocalOnly('team/board/raw', { workspaceRoot: ws, filterText: rule }), (e) => e.code === 'export-synced', rule);
		}
	} finally {
		rmSync(ws, { recursive: true, force: true });
	}
});

test('assertLocalOnly: the workspace root itself is never local; a folder that does not exist yet is judged by its path', () => {
	const ws = workspace();
	try {
		assert.throws(() => assertLocalOnly(ws, { workspaceRoot: ws, filterText: AFTER }), (e) => e.code === 'export-synced');
		assert.deepEqual(assertLocalOnly('team/board/raw/deeper/still', { workspaceRoot: ws, filterText: AFTER }), { where: 'filtered', rel: 'team/board/raw/deeper/still' });
	} finally {
		rmSync(ws, { recursive: true, force: true });
	}
});

test('assertLocalOnly: a link outside that points into the workspace is judged by where it lands', () => {
	const ws = workspace();
	const holder = mkdtempSync(join(tmpdir(), 'board-export-link-'));
	try {
		mkdirSync(join(ws, 'team', 'board', 'issues'), { recursive: true });
		symlinkSync(join(ws, 'team', 'board', 'issues'), join(holder, 'export'));
		assert.throws(() => assertLocalOnly(join(holder, 'export'), { workspaceRoot: ws, filterText: AFTER }), (e) => e.code === 'export-synced');
		symlinkSync(join(ws, 'team', 'board', 'raw'), join(holder, 'ok'));
		mkdirSync(join(ws, 'team', 'board', 'raw'), { recursive: true });
		assert.equal(assertLocalOnly(join(holder, 'ok'), { workspaceRoot: ws, filterText: AFTER }).where, 'filtered');
		// and the other way: a link inside the workspace that points outside is outside
		const out = mkdtempSync(join(tmpdir(), 'board-export-out-'));
		symlinkSync(out, join(ws, 'team', 'board', 'elsewhere'));
		assert.equal(assertLocalOnly('team/board/elsewhere', { workspaceRoot: ws, filterText: BEFORE }).where, 'outside');
		rmSync(out, { recursive: true, force: true });
	} finally {
		rmSync(ws, { recursive: true, force: true });
		rmSync(holder, { recursive: true, force: true });
	}
});

test('assertLocalOnly: a missing workspace root is an error', () => {
	assert.throws(() => assertLocalOnly('x', { workspaceRoot: '', filterText: AFTER }), (e) => e.code === 'bad-path');
});

test('uploadProbePaths: the real upload shape, every extension, upper case and a deeper path', () => {
	const paths = uploadProbePaths('team/board/files');
	assert.ok(paths.includes('team/board/files/PSE-1/shot.png'));
	assert.ok(paths.includes('team/board/files/PSE-1/shot.mov'));
	assert.ok(paths.includes('team/board/files/PSE-1/shot.PNG'));
	assert.ok(paths.includes('team/board/files/PSE-1/shot'), 'a file with no extension');
	assert.ok(paths.includes('team/board/files/PSE-1/a/b/shot.png'));
	assert.equal(paths.length, 4 + UPLOAD_EXTENSIONS.length);
	assert.ok(uploadProbePaths('').every((p) => !p.startsWith('/')), 'the workspace itself has no leading slash');
});

test('assertSynced: passes only when EVERY upload-shaped path reaches Drive', () => {
	const ws = workspace();
	try {
		assert.deepEqual(assertSynced('team/board/files', { workspaceRoot: ws, filterText: AFTER }), { where: 'synced', rel: 'team/board/files' });
		// each of these hides some uploads and not others; none may pass
		for (const rule of ['- *.png', '- *.mov', '- /team/board/files/*/*', '- /team/board/files/*/*.png', '- /team/board/files/**/*.png', '- /team/board/files/*', '- /team/board/files/**', '- /team/board/files/PSE-1/**', '- shot*']) {
			assert.throws(
				() => assertSynced('team/board/files', { workspaceRoot: ws, filterText: `${AFTER}\n${rule}\n` }),
				(e) => e.code === 'export-hidden' && /filter line/.test(e.message),
				rule,
			);
		}
	} finally {
		rmSync(ws, { recursive: true, force: true });
	}
});

test('assertSynced: a folder outside the synced workspace never reaches Drive; a bad root is an error', () => {
	const ws = workspace();
	const out = mkdtempSync(join(tmpdir(), 'board-export-out-'));
	try {
		assert.throws(() => assertSynced(out, { workspaceRoot: ws, filterText: AFTER }), (e) => e.code === 'export-hidden' && /outside/.test(e.message));
		assert.throws(() => assertSynced('x', { workspaceRoot: '', filterText: AFTER }), (e) => e.code === 'bad-path');
		assert.equal(assertSynced('.', { workspaceRoot: ws, filterText: AFTER }).where, 'synced', 'the workspace root is judged by its own files');
	} finally {
		rmSync(ws, { recursive: true, force: true });
		rmSync(out, { recursive: true, force: true });
	}
});

// The live check: point BOARD_RCLONE_FILTER at the real scripts/rclone-filter.txt of the synced workspace.
// It fails until the step-0 line is in the file, which is the point of it, and it fails if the uploads folder
// is filtered (Van wants every screenshot in Drive).
test('the real filter file keeps raw/ local and lets files/ sync (set BOARD_RCLONE_FILTER to run)', { skip: process.env.BOARD_RCLONE_FILTER ? false : 'BOARD_RCLONE_FILTER is not set' }, () => {
	const rules = parseFilter(readFileSync(process.env.BOARD_RCLONE_FILTER, 'utf8'));
	for (const p of probePaths('team/board/raw')) assert.equal(isSynced(rules, p), false, `${p} would sync`);
	for (const p of uploadProbePaths('team/board/files')) assert.equal(isSynced(rules, p), true, `${p} is hidden from Drive, but uploads are meant to sync`);
	assert.equal(isSynced(rules, 'team/board/issues/PSE/PSE-1.md'), true, 'the board itself still syncs');
});
