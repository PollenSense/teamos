/**
 * The command line of `scripts/board-fetch-linear.mjs`, as a function so tests can run it against a scripted
 * Linear (`fake-linear.mjs`) with no network and no key. `runCli` returns the exit code and never calls
 * `process.exit`; the script does that.
 *
 * Exit 0 ok, 1 error, 2 usage, 3 stopped on a budget or the rate limit (nothing written).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ExportError, MANIFEST_FILE, assertLocalOnly, validateRecords, writeExport } from '../board-export/index.mjs';
import { FETCH_TYPES, FetchError, createClient, fetchWorkspace } from './index.mjs';

const VALUE_OPTIONS = ['--workspace', '--out', '--filter', '--types'];

export const USAGE = 'usage: board-fetch-linear.mjs --workspace <dir> --out <dir> [--filter <file>] [--types a,b] [--dry-run]';

/**
 * @param {string[]} argv
 * @param {{env?: Record<string,string|undefined>, fetchImpl?: Function, sleep?: Function, now?: () => number,
 *          stdout?: (text: string) => void, stderr?: (text: string) => void}} [io]
 * @returns {Promise<number>}
 */
export async function runCli(argv, io = {}) {
	const out = io.stdout ?? ((text) => process.stdout.write(text));
	const err = io.stderr ?? ((text) => process.stderr.write(text));
	const usage = (message) => {
		if (message) err(`${message}\n`);
		err(`${USAGE}\n`);
		return 2;
	};

	let workspace = null;
	let outDir = null;
	let filter = null;
	let types = null;
	let dryRun = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (VALUE_OPTIONS.includes(a)) {
			// A value that is missing, or is itself an option (`--out --dry-run`), is a usage error: the option would
			// otherwise swallow the next one and write to a folder named like a flag.
			const value = argv[i + 1];
			if (value === undefined || value === '' || value.startsWith('--')) return usage(`${a} needs a value`);
			i++;
			if (a === '--workspace') workspace = value;
			else if (a === '--out') outDir = value;
			else if (a === '--filter') filter = value;
			else types = value.split(',').filter(Boolean);
		} else if (a === '--dry-run') dryRun = true;
		else return usage(`unknown argument "${a}"`);
	}
	if (!workspace || !outDir) return usage('--workspace and --out are required');
	if (types !== null && types.length === 0) return usage('--types needs at least one type name');
	if (types) for (const t of types) if (!FETCH_TYPES.includes(t)) return usage(`"${t}" is not a type (${FETCH_TYPES.join(', ')})`);
	// A run that reads every type is a full export; a run that names some is a partial one, marked incomplete.
	const complete = types === null || FETCH_TYPES.every((t) => types.includes(t));

	let filterText;
	try {
		filterText = readFileSync(filter ? resolve(filter) : join(resolve(workspace), 'scripts', 'rclone-filter.txt'), 'utf8');
	} catch (e) {
		return usage(`cannot read the filter file: ${e.code ?? 'error'}`);
	}

	try {
		// Before the first request: a folder the sync filter would not keep local fails now, not after the read.
		assertLocalOnly(resolve(outDir), { workspaceRoot: resolve(workspace), filterText });
		if (!complete && !dryRun && existsSync(join(resolve(outDir), MANIFEST_FILE))) {
			return usage('--types would replace the export that is already in that folder with a partial one; use a new folder, or read every type');
		}
		const client = createClient({
			env: io.env,
			fetchImpl: io.fetchImpl,
			sleep: io.sleep,
			now: io.now,
			paceMs: io.paceMs,
			onEvent: (e) => { if (e.waitedMs) err(`waiting ${Math.round(e.waitedMs / 1000)} s (${e.name}, HTTP ${e.status || 'network'})\n`); },
		});
		const startedAt = new Date().toISOString();
		const { entities, counts, skipped } = await fetchWorkspace(client, { types: types ?? FETCH_TYPES, onProgress: (e) => err(`read ${e.type}: ${e.count}\n`) });
		for (const [type, list] of Object.entries(entities)) validateRecords(type, list);
		// A partial run must not replace a full export: the check above ran before the fetch, so the writer repeats it
		// right before it writes (the folder may have got a manifest while this run was reading).
		if (!dryRun) await writeExport(resolve(outDir), { source: 'linear-api', fetchedAt: startedAt, complete, entities }, { workspaceRoot: resolve(workspace), filterText }, { replaceExisting: complete });
		out(`${dryRun ? 'dry run, nothing written' : `written to ${outDir}${complete ? '' : ' (partial: marked incomplete, the importer refuses it)'}`}; ${client.requests} requests, ${client.requestsRemaining ?? '?'} left this hour\n`);
		for (const [type, n] of Object.entries(counts)) out(`${type}: ${n}\n`);
		for (const [type, n] of Object.entries(skipped)) out(`skipped ${type}: ${n} (no place in the export format)\n`);
		return 0;
	} catch (e) {
		if (e instanceof FetchError || e instanceof ExportError) {
			err(`board-fetch-linear: ${e.message}\n`);
			return e.code === 'budget' || e.code === 'rate-limited' ? 3 : 1;
		}
		err(`board-fetch-linear: unexpected ${e?.name ?? 'error'}\n`);
		return 1;
	}
}
