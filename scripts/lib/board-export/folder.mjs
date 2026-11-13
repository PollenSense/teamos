/**
 * Reading and writing an export folder (format in `format.mjs`).
 *
 * Writing validates every record first, asks the sync-filter guard whether the folder may hold text at
 * all, writes each entity file through a temp file and a rename, and writes the manifest last, so a run
 * that stops half-way leaves either the previous manifest (and files that no longer match its hashes) or
 * none: the reader refuses both instead of importing a mix.
 *
 * Reading trusts nothing in the folder: it opens only the fixed file name of each known type, checks the
 * file's hash and record count against the manifest, and validates every record. A manifest with a newer
 * version is refused with a message that says to update TeamOS.
 */

import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	ENTITY_TYPES,
	ExportError,
	FORMAT,
	FORMAT_VERSION,
	MANIFEST_FILE,
	TYPE_NAMES,
	fileNameFor,
	isIsoDate,
	validateRecords,
} from './format.mjs';
import { assertLocalOnly } from './sync-filter.mjs';

const MAX_MANIFEST_BYTES = 1024 * 1024;
export const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const ISO_ANY = /^\d{4}-\d{2}-\d{2}T/;

function sha256(buffer) {
	return createHash('sha256').update(buffer).digest('hex');
}

async function writeAtomic(path, text) {
	const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
	try {
		await writeFile(temp, text, { mode: 0o600 });
		await rename(temp, path);
	} catch (err) {
		await rm(temp, { force: true });
		throw err;
	}
}

/**
 * Write a complete export.
 *
 * @param {string} dir          the export folder
 * @param {{source: string, fetchedAt?: string, complete?: boolean, entities: Record<string, object[]>}} data
 * @param {{workspaceRoot: string, filterText: string}} guard  who may hold the text: see `assertLocalOnly`
 * @returns {Promise<{manifest: object}>}
 *
 * Types that are not in `data.entities` are removed from the folder (their fixed file names only: nothing
 * else in the folder is touched). A folder that has files but no manifest is refused.
 */
export async function writeExport(dir, data, guard) {
	if (!guard || typeof guard !== 'object') throw new ExportError('export-synced', 'writeExport needs the sync guard (workspaceRoot and filterText)');
	if (typeof data?.source !== 'string' || data.source === '') throw new ExportError('manifest-damaged', 'the export has no source name');
	const entities = data.entities ?? {};
	for (const type of Object.keys(entities)) {
		fileNameFor(type);
		validateRecords(type, entities[type]);
	}
	const fetchedAt = data.fetchedAt ?? new Date().toISOString();
	if (!ISO_ANY.test(fetchedAt) || !isIsoDate(fetchedAt)) throw new ExportError('manifest-damaged', 'fetchedAt is not an ISO date-time');
	assertLocalOnly(dir, guard);

	await mkdir(dir, { recursive: true, mode: 0o700 });
	const existing = await readdir(dir);
	if (existing.length > 0 && !existing.includes(MANIFEST_FILE)) {
		throw new ExportError('not-export-folder', 'the folder has files but no export manifest; refusing to write into it');
	}

	const manifestEntities = {};
	for (const type of TYPE_NAMES) {
		if (!Object.prototype.hasOwnProperty.call(entities, type)) continue;
		const file = fileNameFor(type);
		const text = `${JSON.stringify({ type, version: FORMAT_VERSION, records: entities[type] })}\n`;
		await writeAtomic(join(dir, file), text);
		manifestEntities[type] = { file, count: entities[type].length, sha256: sha256(Buffer.from(text)), bytes: Buffer.byteLength(text) };
	}
	const manifest = {
		format: FORMAT,
		version: FORMAT_VERSION,
		source: data.source,
		fetchedAt,
		complete: data.complete !== false,
		entities: manifestEntities,
	};
	await writeAtomic(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
	for (const type of TYPE_NAMES) {
		if (!Object.prototype.hasOwnProperty.call(entities, type)) await rm(join(dir, fileNameFor(type)), { force: true });
	}
	return { manifest };
}

async function readRegularFile(path, maxBytes, missingCode, what) {
	let st;
	try {
		st = await lstat(path);
	} catch (err) {
		if (err.code === 'ENOENT') throw new ExportError(missingCode, `${what} is missing`);
		throw err;
	}
	if (!st.isFile()) throw new ExportError(missingCode, `${what} is not a regular file`);
	if (st.size > maxBytes) throw new ExportError('file-too-large', `${what} is larger than ${maxBytes} bytes`);
	return readFile(path);
}

/**
 * Read and verify an export folder.
 *
 * @param {string} dir
 * @param {{require?: string[], allowIncomplete?: boolean, maxFileBytes?: number}} [options]
 * @returns {Promise<{manifest: object, entities: Record<string, object[]>}>} records in file order
 */
export async function readExport(dir, options = {}) {
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const manifestBytes = await readRegularFile(join(dir, MANIFEST_FILE), MAX_MANIFEST_BYTES, 'missing-manifest', 'the export manifest');
	let manifest;
	try {
		manifest = JSON.parse(manifestBytes.toString('utf8'));
	} catch {
		throw new ExportError('manifest-damaged', 'the export manifest is not valid JSON');
	}
	if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) throw new ExportError('manifest-damaged', 'the export manifest is not an object');
	if (manifest.format !== FORMAT) throw new ExportError('wrong-format', 'the folder is not a board export (format name differs)');
	if (!Number.isSafeInteger(manifest.version) || manifest.version < 1) throw new ExportError('version-invalid', 'the export manifest has no valid version number');
	if (manifest.version > FORMAT_VERSION) {
		throw new ExportError('version-newer', `this export is format version ${manifest.version}; this TeamOS reads up to version ${FORMAT_VERSION}. Update TeamOS before importing it.`);
	}
	if (typeof manifest.source !== 'string' || manifest.source === '') throw new ExportError('manifest-damaged', 'the export manifest has no source name');
	if (!ISO_ANY.test(manifest.fetchedAt) || !isIsoDate(manifest.fetchedAt)) throw new ExportError('manifest-damaged', 'the export manifest has no valid fetchedAt');
	if (manifest.complete !== true && !options.allowIncomplete) {
		throw new ExportError('export-incomplete', 'the export is marked incomplete (the fetcher stopped before it had read everything); fetch again');
	}
	const listed = manifest.entities;
	if (listed === null || typeof listed !== 'object' || Array.isArray(listed)) throw new ExportError('manifest-damaged', 'the export manifest lists no entities object');
	for (const type of options.require ?? []) {
		fileNameFor(type);
		if (!Object.prototype.hasOwnProperty.call(listed, type)) throw new ExportError('missing-type', `the export has no "${type}" file`);
	}

	const entities = {};
	for (const type of Object.keys(listed)) {
		if (!Object.prototype.hasOwnProperty.call(ENTITY_TYPES, type)) throw new ExportError('unknown-type', `the manifest lists "${type.slice(0, 40)}", which export format ${FORMAT_VERSION} does not have`);
		const entry = listed[type];
		const file = fileNameFor(type);
		if (entry === null || typeof entry !== 'object' || entry.file !== file || !Number.isSafeInteger(entry.count) || entry.count < 0 || !HASH.test(entry.sha256 ?? '')) {
			throw new ExportError('manifest-damaged', `the manifest entry for "${type}" is not valid`);
		}
		const bytes = await readRegularFile(join(dir, file), maxFileBytes, 'file-missing', `the "${type}" file`);
		if (sha256(bytes) !== entry.sha256) {
			throw new ExportError('hash-mismatch', `the "${type}" file differs from what the manifest recorded (changed or half-written); fetch again`);
		}
		let parsed;
		try {
			parsed = JSON.parse(bytes.toString('utf8'));
		} catch {
			throw new ExportError('file-damaged', `the "${type}" file is not valid JSON`);
		}
		if (parsed === null || typeof parsed !== 'object' || parsed.type !== type || parsed.version !== manifest.version || !Array.isArray(parsed.records)) {
			throw new ExportError('file-damaged', `the "${type}" file does not have the header the manifest promises`);
		}
		if (parsed.records.length !== entry.count) {
			throw new ExportError('count-mismatch', `the "${type}" file has ${parsed.records.length} records; the manifest says ${entry.count}`);
		}
		validateRecords(type, parsed.records);
		entities[type] = parsed.records;
	}
	return { manifest, entities };
}
