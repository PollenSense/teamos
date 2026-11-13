#!/usr/bin/env node
/**
 * Read Linear (read-only) into a local export folder for the team work board importer.
 *
 *   LINEAR_API_KEY=... node scripts/board-fetch-linear.mjs --workspace <synced folder> --out <export folder>
 *                      [--filter <filter file>] [--types teams,issues,...] [--dry-run]
 *
 * The key is read from the environment only. `--workspace` is the synced (Google Drive) folder and `--out` the
 * export folder: the run refuses unless the export folder is outside the workspace or the sync filter keeps it
 * local (scripts/lib/board-export/sync-filter.mjs). Nothing is written until the whole read has succeeded;
 * `--dry-run` reads everything, checks every record against the export format, and writes nothing.
 * Prints counts only, never a title, text, name or address. Exit 0 ok, 1 error, 2 usage, 3 stopped on a budget
 * or the rate limit (nothing written).
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ExportError, assertLocalOnly, validateRecords, writeExport } from './lib/board-export/index.mjs';
import { FETCH_TYPES, FetchError, createClient, fetchWorkspace } from './lib/linear/index.mjs';

function usage(message) {
	if (message) process.stderr.write(`${message}\n`);
	process.stderr.write('usage: board-fetch-linear.mjs --workspace <dir> --out <dir> [--filter <file>] [--types a,b] [--dry-run]\n');
	process.exit(2);
}

const args = process.argv.slice(2);
let workspace = null;
let out = null;
let filter = null;
let types = null;
let dryRun = false;
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === '--workspace' && args[i + 1]) workspace = args[++i];
	else if (a === '--out' && args[i + 1]) out = args[++i];
	else if (a === '--filter' && args[i + 1]) filter = args[++i];
	else if (a === '--types' && args[i + 1]) types = args[++i].split(',').filter(Boolean);
	else if (a === '--dry-run') dryRun = true;
	else usage(`unknown argument "${a}"`);
}
if (!workspace || !out) usage('--workspace and --out are required');
if (types) for (const t of types) if (!FETCH_TYPES.includes(t)) usage(`"${t}" is not a type (${FETCH_TYPES.join(', ')})`);

let filterText;
try {
	filterText = readFileSync(filter ? resolve(filter) : join(resolve(workspace), 'scripts', 'rclone-filter.txt'), 'utf8');
} catch (err) {
	usage(`cannot read the filter file: ${err.code ?? 'error'}`);
}

try {
	// Before the first request: a folder the sync filter would not keep local fails now, not after the read.
	assertLocalOnly(resolve(out), { workspaceRoot: resolve(workspace), filterText });
	const client = createClient({ onEvent: (e) => { if (e.waitedMs) process.stderr.write(`waiting ${Math.round(e.waitedMs / 1000)} s (${e.name}, HTTP ${e.status || 'network'})\n`); } });
	const startedAt = new Date().toISOString();
	const { entities, counts, skipped } = await fetchWorkspace(client, { types: types ?? FETCH_TYPES, onProgress: (e) => process.stderr.write(`read ${e.type}: ${e.count}\n`) });
	for (const [type, list] of Object.entries(entities)) validateRecords(type, list);
	if (!dryRun) await writeExport(resolve(out), { source: 'linear-api', fetchedAt: startedAt, complete: true, entities }, { workspaceRoot: resolve(workspace), filterText });
	process.stdout.write(`${dryRun ? 'dry run, nothing written' : `written to ${out}`}; ${client.requests} requests, ${client.requestsRemaining ?? '?'} left this hour\n`);
	for (const [type, n] of Object.entries(counts)) process.stdout.write(`${type}: ${n}\n`);
	for (const [type, n] of Object.entries(skipped)) process.stdout.write(`skipped ${type}: ${n} (no place in the export format)\n`);
	process.exit(0);
} catch (err) {
	if (err instanceof FetchError || err instanceof ExportError) {
		process.stderr.write(`board-fetch-linear: ${err.message}\n`);
		process.exit(err.code === 'budget' || err.code === 'rate-limited' ? 3 : 1);
	}
	process.stderr.write(`board-fetch-linear: unexpected ${err?.name ?? 'error'}\n`);
	process.exit(1);
}
