#!/usr/bin/env node
/**
 * Import the issues of an export folder into the team work board (tickets A5 and A6): state, project, milestone, cycle,
 * parent, labels, estimate, branch, dates, every earlier key as an alias, then what ties an issue to other things:
 * relations (blocks, blocked by, related, duplicate of), pull requests, other links, and the comments of each issue (one
 * thread file per issue). Comments on projects, documents and project updates are counted and left for later.
 *
 *   node scripts/board-import-issues.mjs --workspace <repo root> --export <export folder> [--apply]
 *        [--members <members.json>] [--people-map <file>] [--filter <filter file>]
 *
 * Without `--apply` this is the dry run: it reads the export and the board, and prints per team what each file would do
 * (new, changed, same). Nothing is written. `--apply` writes, only when `board.importer` is `true` in the config, only
 * after the reference data was imported (`board-import-reference.mjs --apply`: people and projects), and only after the
 * sync filter was asked whether `<board>/raw` stays off Drive. The options are those of the reference importer that matter for
 * issues (`--members`, `--people-map`, `--filter`): they feed the same plan, so issues and reference files always agree.
 *
 * Prints counts only: no title, text, name or address. Exit 0 ok, 1 a write failed or the guard refused, 2 usage.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BoardError, BoardStore, boardConfig } from './lib/board/index.mjs';
import { ExportError, assertLocalOnly, readExport } from './lib/board-export/index.mjs';
import { ImportError, applyIssues, formatIssuesSummary, loadExisting, planIssues, planLinks, planReference, withLinks } from './lib/board-import/index.mjs';
import { loadConfig } from './lib/config.mjs';

const TYPES = ['users', 'teams', 'states', 'labels', 'cycles', 'projects', 'milestones', 'projectUpdates', 'documents', 'issues', 'relations', 'attachments', 'comments'];

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
	if (apply && !(await store.readSingle('people'))) {
		usage('the reference data is not imported yet (no people.json): run board-import-reference.mjs --apply first');
	}
	const existing = await loadExisting(store);
	const reference = planReference(entities, { members, overrides, existing });
	const issuesPlan = planIssues(entities, reference);
	const plan = withLinks(issuesPlan, planLinks(entities, issuesPlan, reference, { report: issuesPlan.report }));
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
	const c = result.checks;
	const broken = c.aliasesBroken + c.parentsBroken + (c.relationsBroken ?? 0) + (c.threadsBroken ?? 0);
	process.exit(Object.keys(result.failures).length > 0 || broken > 0 ? 1 : 0);
} catch (err) {
	if (err instanceof ExportError || err instanceof ImportError || err instanceof BoardError) {
		process.stderr.write(`stopped (${err.code}): ${err.message}\n`);
		process.exit(1);
	}
	throw err;
}
