#!/usr/bin/env node
/**
 * Import the issues of an export folder into the team work board (ticket A5): state, project, milestone, cycle, parent,
 * labels, estimate, branch, dates, and every earlier key as an alias. Relations, pull requests and comments are A6.
 *
 *   node scripts/board-import-issues.mjs --workspace <repo root> --export <export folder> [--apply]
 *        [--members <members.json>] [--people-map <file>] [--filter <filter file>]
 *
 * Without `--apply` this is the dry run: it reads the export and the board, and prints per team what each file would do
 * (new, changed, same). Nothing is written. `--apply` writes, only when `board.importer` is `true` in the config, only
 * after the reference data was imported and still matches this export (`board-import-reference.mjs --apply`: people,
 * projects, labels and cycles the cards name), and only after the
 * sync filter was asked whether `<board>/raw` stays off Drive. The options are those of the reference importer that matter for
 * issues (`--members`, `--people-map`, `--filter`): they feed the same plan, so issues and reference files always agree.
 *
 * Prints counts only: no title, text, name or address. Exit 0 ok, 1 a write failed or the guard refused, 2 usage.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BoardError, BoardStore, boardConfig } from './lib/board/index.mjs';
import { ExportError, assertLocalOnly, readExport } from './lib/board-export/index.mjs';
import { ImportError, applyIssues, formatIssuesSummary, loadExisting, planIssues, planReference, referenceGaps } from './lib/board-import/index.mjs';
import { loadConfig } from './lib/config.mjs';

const TYPES = ['users', 'teams', 'states', 'labels', 'cycles', 'projects', 'milestones', 'projectUpdates', 'documents', 'issues'];

function usage(message) {
	if (message) process.stderr.write(`${message}\n`);
	process.stderr.write('usage: board-import-issues.mjs --workspace <dir> --export <dir> [--apply] [--members <file>] [--people-map <file>] [--filter <file>]\n');
	process.exit(2);
}

function readJson(path, what) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch (err) {
		return usage(`cannot read ${what}: ${err.code ?? 'not valid JSON'}`);
	}
}

function readObject(path, what) {
	const value = readJson(path, what);
	if (value === null || typeof value !== 'object' || Array.isArray(value)) usage(`${what} must be a JSON object`);
	return value;
}

const args = process.argv.slice(2);
const opt = {};
let apply = false;
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === '--apply') apply = true;
	else if (['--workspace', '--export', '--members', '--people-map', '--filter'].includes(a) && args[i + 1]) opt[a.slice(2)] = args[++i];
	else usage(`unknown argument "${a}"`);
}
if (!opt.workspace || !opt.export) usage('--workspace and --export are required');

const workspace = resolve(opt.workspace);
const config = await loadConfig(workspace);
const board = boardConfig(config, workspace);
if (!board.on) usage(`the board module is off: ${board.reason}`);
if (apply && board.importer !== true) usage('board.importer is not true in the config: --apply is refused (a dry run is fine)');

const membersFile = readJson(opt.members ? resolve(opt.members) : join(workspace, 'team', 'members.json'), 'members.json');
if (!Array.isArray(membersFile?.members)) usage('members.json has no "members" list');
const members = membersFile.members;
const overrides = opt['people-map'] ? readObject(resolve(opt['people-map']), 'the people map') : {};
const filterPath = opt.filter ? resolve(opt.filter) : join(workspace, 'scripts', 'rclone-filter.txt');

try {
	const { entities, manifest } = await readExport(resolve(opt.export), { require: TYPES });
	process.stdout.write(`export read: complete ${manifest.complete === true}, ${TYPES.map((t) => `${t} ${entities[t].length}`).join(', ')}\n`);
	const store = new BoardStore({ dir: board.dir, lockDir: board.lockDir, dryRun: !apply });
	if (apply) {
		let people;
		try {
			people = await store.readSingle('people');
		} catch (err) {
			// A file the store refuses to read cannot be compared, and the reference import never overwrites it: same advice
			// as for the other reference files below (exit 2, nothing written).
			if (!(err instanceof BoardError) || err.code === 'locked') throw err;
			usage(`the reference file people.json on the board is damaged or unreadable (${err.code}); repair or remove it by hand, then run board-import-reference.mjs --apply`);
		}
		if (!people) usage('the reference data is not imported yet (no people.json): run board-import-reference.mjs --apply first');
	}
	const existing = await loadExisting(store);
	const reference = planReference(entities, { members, overrides, existing });
	// The cards name people, projects, labels and cycles of this plan: the board must already hold exactly those (a file
	// that is there but older, or made from another export or people map, counts as a gap).
	const gaps = await referenceGaps(reference, store);
	// A reference file this plan names but that cannot be read cannot be compared either, so the cards could name people or
	// projects the board does not have. The reference import never overwrites a damaged file, so running it again does not
	// help: the person has to repair or remove the file first. --apply stops here; a dry run only says so.
	if (gaps.damaged > 0) {
		const text = `${gaps.damaged} reference file(s) on the board are damaged and could not be compared; the reference import leaves a damaged file alone, so repair or remove it by hand, then run board-import-reference.mjs --apply`;
		if (apply) usage(text);
		process.stdout.write(`note: ${text}\n`);
	}
	if (gaps.total > 0) {
		const text = `the reference data on the board does not match what these cards use (people ${gaps.people}, projects ${gaps.projects}, labels ${gaps.labels}, cycles ${gaps.cycles}): run board-import-reference.mjs --apply first`;
		if (apply) usage(text);
		process.stdout.write(`note: ${text}\n`);
	}
	const plan = planIssues(entities, reference);
	const rawDir = join(board.dir, 'raw');
	let filterText = '';
	if (apply) {
		try {
			filterText = readFileSync(filterPath, 'utf8');
		} catch (err) {
			usage(`cannot read the filter file: ${err.code ?? 'error'}`);
		}
	}
	const result = await applyIssues(plan, store, { rawDir, guard: () => assertLocalOnly(rawDir, { workspaceRoot: workspace, filterText }) });
	process.stdout.write(`${formatIssuesSummary(plan, result, { dryRun: !apply })}\n`);
	const broken = result.checks.aliasesBroken + result.checks.parentsBroken;
	process.exit(Object.keys(result.failures).length > 0 || broken > 0 ? 1 : 0);
} catch (err) {
	if (err instanceof ExportError || err instanceof ImportError || err instanceof BoardError) {
		process.stderr.write(`stopped (${err.code}): ${err.message}\n`);
		process.exit(1);
	}
	throw err;
}
