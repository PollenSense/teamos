import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertLocalOnly, isSynced, parseFilter, probePaths, exportFilePaths } from './index.mjs';

// Regression tests for the third CodeRabbit review of PR #16 (2026-11-18, round 5): a filter made only of file rules
// can pass every probe path and still leave other files in the folder synced, so the guard now wants one rule that
// excludes the whole folder.

const RAW = 'team/board/raw';

function workspace() {
	const root = mkdtempSync(join(tmpdir(), 'board-export-cr16r5-'));
	mkdirSync(join(root, 'team', 'board'), { recursive: true });
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const guard = (root, lines) => assertLocalOnly(RAW, { workspaceRoot: root, filterText: `${lines.join('\n')}\n` });
const kept = (lines) => [...probePaths(RAW), ...exportFilePaths(RAW)].every((p) => !isSynced(parseFilter(`${lines.join('\n')}\n`), p));

// Filters made of file rules only. Each one keeps every probe path local (that is why the probe check let them through).
const FILE_RULES_ONLY = [
	['one rule per depth and type', ['- /team/board/raw/*.json', '- /team/board/raw/*/*.json', '- /team/board/raw/*/*/*.png', '- /team/board/raw/.*']],
	['the same without an anchor', ['- raw/*.json', '- raw/*/*.json', '- raw/*/*/*.png', '- raw/.*']],
	['a file rule at the top plus one folder', ['- /team/board/raw/*', '- /team/board/raw/a/**']],
	['the same, not anchored', ['- raw/*', '- raw/a/**']],
];

test('a folder kept local only by file rules is refused, though every probe path stays local (R5-5)', () => {
	const w = workspace();
	try {
		for (const [name, lines] of FILE_RULES_ONLY) {
			const text = `${lines.join('\n')}\n`;
			const rules = parseFilter(text);
			// Both preconditions of the failure: the probes are all kept local, and files below the folder still sync.
			assert.equal(kept(lines), true, `${name}: every probe path and export file name is kept local`);
			assert.equal(isSynced(rules, 'team/board/raw/issues/PSE-1.md'), true, `${name}: an issue file really syncs`);
			assert.equal(isSynced(rules, 'team/board/raw/files/PSE-1/signups.csv'), true, `${name}: an upload-shaped file really syncs`);
			assert.throws(
				() => guard(w.root, lines),
				(e) => e.code === 'export-synced' && e.message.includes('no filter line excludes the whole folder') && e.message.includes('- /team/board/raw/**'),
				name,
			);
		}
	} finally {
		w.cleanup();
	}
});

test('one rule that excludes the whole folder is enough, in each form (R5-5)', () => {
	const w = workspace();
	try {
		for (const lines of [
			['- /team/board/raw/**'],
			['- /team/board/raw/'],
			['- /team/board/**'],
			['- /team/**'],
			['- raw/**'],
			['- /team/board/raw/**', '- /team/board/raw/*.json'], // file rules after the whole-folder rule change nothing
			['- .git/**', '- /team/.logs/**', '- /team/board/raw/**'],
		]) {
			assert.deepEqual(guard(w.root, lines), { where: 'filtered', rel: RAW }, lines.join(' | '));
		}
	} finally {
		w.cleanup();
	}
});

test('the workspace filter file of this repository passes the guard (R5-5, live copy of the real rules)', () => {
	const w = workspace();
	try {
		// The real file: scripts/rclone-filter.txt in the synced workspace. Set BOARD_RCLONE_FILTER to run this against it.
		const real = process.env.BOARD_RCLONE_FILTER;
		const text = real ? readFileSync(real, 'utf8') : '- .git/**\n- /team/.logs/**\n- /team/board/raw/**\n';
		assert.deepEqual(assertLocalOnly(RAW, { workspaceRoot: w.root, filterText: text }), { where: 'filtered', rel: RAW });
	} finally {
		w.cleanup();
	}
});
