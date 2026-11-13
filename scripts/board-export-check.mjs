#!/usr/bin/env node
/**
 * Does the sync filter keep the board's local-only folders off Drive?
 *
 *   node scripts/board-export-check.mjs --workspace <synced folder> [--filter <file>] [--folder <path>]...
 *
 * `--filter` defaults to `<workspace>/scripts/rclone-filter.txt`. With no `--folder` the check covers the
 * two import folders, `team/board/raw` and `team/board/files`. Each folder is a path relative to the
 * workspace (or an absolute path; one outside the workspace is always local). Prints one line per folder,
 * "local" or "WOULD SYNC", and exits 1 if any folder would sync, 2 on a usage or filter-file error.
 * Prints no file content. Run it after the filter edit and the bisync `--resync`, and before the first import.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ExportError, assertLocalOnly } from './lib/board-export/index.mjs';

function usage(message) {
	if (message) process.stderr.write(`${message}\n`);
	process.stderr.write('usage: board-export-check.mjs --workspace <dir> [--filter <file>] [--folder <path>]...\n');
	process.exit(2);
}

const args = process.argv.slice(2);
let workspace = null;
let filter = null;
const folders = [];
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === '--workspace' && args[i + 1]) workspace = args[++i];
	else if (a === '--filter' && args[i + 1]) filter = args[++i];
	else if (a === '--folder' && args[i + 1]) folders.push(args[++i]);
	else usage(`unknown argument "${a}"`);
}
if (!workspace) usage('--workspace is required');
if (folders.length === 0) folders.push('team/board/raw', 'team/board/files');

let filterText;
try {
	filterText = readFileSync(filter ? resolve(filter) : join(resolve(workspace), 'scripts', 'rclone-filter.txt'), 'utf8');
} catch (err) {
	usage(`cannot read the filter file: ${err.code ?? 'error'}`);
}

let failed = 0;
for (const folder of folders) {
	try {
		const r = assertLocalOnly(folder, { workspaceRoot: resolve(workspace), filterText });
		process.stdout.write(`local        ${folder} (${r.where})\n`);
	} catch (err) {
		if (!(err instanceof ExportError)) throw err;
		if (err.code === 'export-synced') {
			failed++;
			process.stdout.write(`WOULD SYNC   ${folder}\n`);
		} else {
			usage(`${folder}: ${err.message}`);
		}
	}
}
process.exit(failed > 0 ? 1 : 0);
