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
 * `--types` reads only the named types: the export is then marked incomplete (the importer refuses it) and
 * the run refuses to write over an export that is already in the folder.
 * Prints counts only, never a title, text, name or address. Exit 0 ok, 1 error, 2 usage, 3 stopped on a budget
 * or the rate limit (nothing written). The logic is in scripts/lib/linear/cli.mjs.
 */

import { runCli } from './lib/linear/cli.mjs';

process.exit(await runCli(process.argv.slice(2), { env: process.env }));
