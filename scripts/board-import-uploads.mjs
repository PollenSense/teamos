#!/usr/bin/env node
/**
 * Download the uploads that the issues and comments of a Linear export point at into the team work board (ticket A6b):
 * `<board>/files/<card id>/<name>`, listed in the card's `files` and in the thread entry of the comment that used them.
 * Read-only toward Linear (HEAD and GET); the key is the `Authorization` header of requests to the upload host only.
 *
 *   LINEAR_API_KEY_RO=... node scripts/board-import-uploads.mjs --workspace <repo root> --export <export folder> [--apply]
 *        [--max-file-mb 100] [--max-total-mb 1024] [--filter <filter file>]
 *
 * Without `--apply` this is the dry run: it asks the upload host for the size of each link not yet on the board (HEAD)
 * and prints the count, the size known and the largest, writing nothing. Without a key in the environment it only counts
 * the links. `--apply` needs `board.importer: true`, the key, and the issues imported first (`board-import-issues.mjs --apply`);
 * it stops before writing when a known size is over a cap, and when a download grows past one.
 *
 * Prints counts only: no title, text, name or address; a link that could not be saved is named by issue key, upload id and status.
 * Exit 0 ok, 1 a write failed, the run stopped or a check broke, 2 usage.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BoardError, BoardStore, boardConfig } from './lib/board/index.mjs';
import { ExportError, assertLocalOnly, assertSynced, readExport } from './lib/board-export/index.mjs';
import { ImportError, UploadError, applyUploads, createUploadClient, findUploads, formatUploadsSummary } from './lib/board-import/index.mjs';
import { loadConfig } from './lib/config.mjs';

function usage(message) {
	if (message) process.stderr.write(`${message}\n`);
	process.stderr.write('usage: board-import-uploads.mjs --workspace <dir> --export <dir> [--apply] [--max-file-mb <n>] [--max-total-mb <n>] [--filter <file>]\n');
	process.exit(2);
}

const args = process.argv.slice(2);
const opt = {};
let apply = false;
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === '--apply') apply = true;
	else if (['--workspace', '--export', '--filter', '--max-file-mb', '--max-total-mb'].includes(a) && args[i + 1]) opt[a.slice(2)] = args[++i];
	else usage(`unknown argument "${a}"`);
}
if (!opt.workspace || !opt.export) usage('--workspace and --export are required');
const megabytes = (name, fallback) => {
	if (opt[name] === undefined) return fallback;
	const n = Number(opt[name]);
	if (!Number.isFinite(n) || n <= 0 || n > 100000) usage(`--${name} must be a number of megabytes between 0 and 100000`);
	return Math.floor(n * 1024 * 1024);
};
const maxFileBytes = megabytes('max-file-mb', 100 * 1024 * 1024);
const maxTotalBytes = megabytes('max-total-mb', 1024 * 1024 * 1024);

const workspace = resolve(opt.workspace);
const config = await loadConfig(workspace);
const board = boardConfig(config, workspace);
if (!board.on) usage(`the board module is off: ${board.reason}`);
if (apply && board.importer !== true) usage('board.importer is not true in the config: --apply is refused (a dry run is fine)');
const filterPath = opt.filter ? resolve(opt.filter) : join(workspace, 'scripts', 'rclone-filter.txt');
let filterText = '';
try {
	filterText = readFileSync(filterPath, 'utf8');
} catch (err) {
	if (apply) usage(`cannot read the filter file: ${err.code ?? 'error'}`);
}

const key = process.env.LINEAR_API_KEY_RO || process.env.LINEAR_API_KEY || '';
if (apply && key === '') usage('--apply needs LINEAR_API_KEY_RO (or LINEAR_API_KEY) in the environment');

try {
	const { entities, manifest } = await readExport(resolve(opt.export), { require: ['issues', 'comments'] });
	const types = ['issues', 'comments', 'documents', 'projectUpdates', 'projects', 'attachments'];
	process.stdout.write(`export read: complete ${manifest.complete === true}, ${types.map((t) => `${t} ${(entities[t] ?? []).length}`).join(', ')}\n`);
	const found = findUploads(entities);
	const store = new BoardStore({ dir: board.dir, lockDir: board.lockDir, dryRun: !apply });
	const rawDir = join(board.dir, 'raw');
	const client = key === '' ? null : createUploadClient({ key });
	let filesSync;
	try {
		filesSync = `${assertSynced(join(board.dir, 'files'), { workspaceRoot: workspace, filterText }).where} (reaches Drive)`;
	} catch (err) {
		if (!(err instanceof ExportError)) throw err;
		filesSync = `NOT SYNCED: ${err.message}`;
	}
	const result = await applyUploads(found, store, {
		client, boardDir: board.dir, rawDir, maxFileBytes, maxTotalBytes,
		guard: () => assertLocalOnly(rawDir, { workspaceRoot: workspace, filterText }),
	});
	process.stdout.write(`${formatUploadsSummary(found, result, { dryRun: !apply, filesSync, headDone: client !== null })}\n`);
	const c = result.counts;
	const bad = result.stopped !== null || c.cards.failed > 0 || c.threads.failed > 0 || c.checks.filesBroken > 0;
	process.exit(bad ? 1 : 0);
} catch (err) {
	if (err instanceof ExportError || err instanceof ImportError || err instanceof BoardError || err instanceof UploadError) {
		process.stderr.write(`stopped (${err.code}): ${err.message}\n`);
		process.exit(1);
	}
	// Anything else may carry a path with a file name in its text: print the kind of error only.
	process.stderr.write(`stopped (unexpected: ${typeof err?.code === 'string' ? err.code : (err?.name ?? 'error')})\n`);
	process.exit(1);
}
