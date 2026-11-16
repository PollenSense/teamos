#!/usr/bin/env node
/**
 * Does the sync filter keep the board's raw texts off Drive, and let the uploaded files through?
 *
 *   node scripts/board-export-check.mjs --workspace <synced folder> [--filter <file>] [--folder <path>]... [--synced <path>]...
 *
 * `--filter` defaults to `<workspace>/scripts/rclone-filter.txt`. `--folder` names a folder that must stay
 * local, `--synced` one that must reach Drive. With neither flag the check covers the two import folders:
 * `team/board/raw` must be local (full-fidelity Linear text), `team/board/files` must sync (Van wants every
 * uploaded screenshot kept in Drive on its issue, 2026-11-13). Each folder is a path relative to the
 * workspace (or an absolute path; one outside the workspace is always local, so it fails as a `--synced` folder).
 * Prints one line per folder, "local" or "WOULD SYNC" for a folder that must stay local, "syncs" or "HIDDEN"
 * for one that must reach Drive (HIDDEN when ANY upload-shaped path in it is filtered: `<folder>/PSE-1/shot.png`
 * and the other extensions, see `uploadProbePaths`),
 * and exits 1 if any line is wrong, 2 on a usage or filter-file error. Prints no file content. Run it after
 * the filter edit and the bisync `--resync`, and before the first import.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ExportError, assertLocalOnly, assertSynced } from './lib/board-export/index.mjs';

function usage(message) {
	if (message) process.stderr.write(`${message}\n`);
	process.stderr.write('usage: board-export-check.mjs --workspace <dir> [--filter <file>] [--folder <path>]... [--synced <path>]...\n');
	process.exit(2);
}

const args = process.argv.slice(2);
let workspace = null;
let filter = null;
const folders = [];
const syncedFolders = [];
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === '--workspace' && args[i + 1]) workspace = args[++i];
	else if (a === '--filter' && args[i + 1]) filter = args[++i];
	else if (a === '--folder' && args[i + 1]) folders.push(args[++i]);
	else if (a === '--synced' && args[i + 1]) syncedFolders.push(args[++i]);
	else usage(`unknown argument "${a}"`);
}
if (!workspace) usage('--workspace is required');
if (folders.length === 0 && syncedFolders.length === 0) {
	folders.push('team/board/raw');
	syncedFolders.push('team/board/files');
}

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
for (const folder of syncedFolders) {
	try {
		assertSynced(folder, { workspaceRoot: resolve(workspace), filterText });
		process.stdout.write(`syncs        ${folder}\n`);
	} catch (err) {
		if (!(err instanceof ExportError)) throw err;
		if (err.code === 'export-hidden') {
			failed++;
			process.stdout.write(`HIDDEN       ${folder} (${err.message})\n`);
		} else usage(`${folder}: ${err.message}`);
	}
}
process.exit(failed > 0 ? 1 : 0);
