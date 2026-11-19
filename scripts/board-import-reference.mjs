#!/usr/bin/env node
/**
 * Import the reference data of an export folder into the team work board (ticket A4): people, teams and workflow
 * states, labels, cycles, projects with milestones and updates, documents, and the message-tag map.
 *
 *   node scripts/board-import-reference.mjs --workspace <repo root> --export <export folder> [--apply]
 *        [--members <members.json>] [--people-map <file>] [--tag-hints <file>] [--filter <filter file>]
 *
 * Without `--apply` this is the dry run: it reads the export and the board, and prints what each file kind would do
 * (new, changed, same). Nothing is written. `--apply` writes, and only when `board.importer` is `true` in the config.
 * A real run first asks the sync filter whether `<board>/raw` stays off Drive and stops if it would sync.
 *
 *   --members     default <workspace>/team/members.json (names and e-mail addresses; matched in memory, never written)
 *   --people-map  JSON object: Linear user id -> member name, for a person whose address differs between the systems
 *   --tag-hints   JSON object: message tag -> exact Linear project name, for the tags that no project code equals
 *   --filter      default <workspace>/scripts/rclone-filter.txt
 *
 * Prints counts only: no title, text, name or address. Exit 0 ok, 1 a write failed or the guard refused, 2 usage.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BoardError, BoardStore, boardConfig } from './lib/board/index.mjs';
import { ExportError, assertLocalOnly, readExport } from './lib/board-export/index.mjs';
import { ImportError, applyReference, formatSummary, loadExisting, planReference } from './lib/board-import/index.mjs';
import { loadConfig } from './lib/config.mjs';

const TYPES = ['users', 'teams', 'states', 'labels', 'cycles', 'projects', 'milestones', 'projectUpdates', 'documents'];

function usage(message) {
	if (message) process.stderr.write(`${message}\n`);
	process.stderr.write('usage: board-import-reference.mjs --workspace <dir> --export <dir> [--apply] [--members <file>] [--people-map <file>] [--tag-hints <file>] [--filter <file>]\n');
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
	else if (['--workspace', '--export', '--members', '--people-map', '--tag-hints', '--filter'].includes(a) && args[i + 1]) opt[a.slice(2)] = args[++i];
	else usage(`unknown argument "${a}"`);
}
if (!opt.workspace || !opt.export) usage('--workspace and --export are required');

const workspace = resolve(opt.workspace);
const config = await loadConfig(workspace);
const board = boardConfig(config, workspace);
if (!board.on) usage(`the board module is off: ${board.reason}`);
if (apply && board.importer !== true) usage('board.importer is not true in the config: --apply is refused (a dry run is fine)');

const membersFile = readJson(opt.members ? resolve(opt.members) : join(workspace, 'team', 'members.json'), 'members.json');
// A members file of the wrong shape must stop the run: read as an empty list it would match nobody and every
// member would be written as `linear:<first name>`.
if (!Array.isArray(membersFile?.members)) usage('members.json has no "members" list');
const members = membersFile.members;
const overrides = opt['people-map'] ? readObject(resolve(opt['people-map']), 'the people map') : {};
const tagHints = opt['tag-hints'] ? readObject(resolve(opt['tag-hints']), 'the tag hints') : {};
const filterPath = opt.filter ? resolve(opt.filter) : join(workspace, 'scripts', 'rclone-filter.txt');

try {
	const { entities, manifest } = await readExport(resolve(opt.export), { require: TYPES });
	process.stdout.write(`export read: complete ${manifest.complete === true}, ${TYPES.map((t) => `${t} ${entities[t].length}`).join(', ')}\n`);
	const store = new BoardStore({ dir: board.dir, lockDir: board.lockDir, dryRun: !apply });
	const existing = await loadExisting(store);
	const plan = planReference(entities, { members, overrides, tagHints, existing });
	const rawDir = join(board.dir, 'raw');
	let filterText = '';
	if (apply) {
		try {
			filterText = readFileSync(filterPath, 'utf8');
		} catch (err) {
			usage(`cannot read the filter file: ${err.code ?? 'error'}`);
		}
	}
	const result = await applyReference(plan, store, { rawDir, guard: () => assertLocalOnly(rawDir, { workspaceRoot: workspace, filterText }) });
	process.stdout.write(`${formatSummary(plan, result, { dryRun: !apply })}\n`);
	process.exit(Object.keys(result.failures).length > 0 ? 1 : 0);
} catch (err) {
	if (err instanceof ExportError || err instanceof ImportError || err instanceof BoardError) {
		process.stderr.write(`stopped (${err.code}): ${err.message}\n`);
		process.exit(1);
	}
	throw err;
}
