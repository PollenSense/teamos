/**
 * Which paths does an rclone filter file keep off Drive?
 *
 * The board import writes issue text and comments into folders that must stay on this machine
 * (`team/board/raw/`, and the export folder the fetcher fills). Uploaded files (`team/board/files/`) are
 * NOT local on purpose: Van wants every screenshot kept in Drive on its own issue (2026-11-13), so nothing
 * here asks for that folder to be filtered, and the live check fails if someone filters it. Text that
 * reached Drive cannot be pulled back, so the importer asks this module before it writes anything:
 * "does the filter really exclude this folder?" It reads the same file `scripts/drive-sync.sh` hands to
 * rclone and follows rclone's own model (fs/filter):
 *
 *   - `- pattern` excludes, `+ pattern` includes, `#` and `;` start comments, `!` clears the rules before it.
 *   - Glob: `*` any run of characters except `/`, `**` any run including `/`, `?` one character except `/`,
 *     `[abc]` / `[a-z]` / `[!a]` a class, `{a,b}` alternatives, a backslash escapes the next character.
 *     A pattern that starts with `/` is anchored at the root of the synced folder; any other pattern can
 *     match below any directory (`.env` matches `team/x/.env`). A pattern matches the whole path.
 *   - A pattern is a FILE rule, a DIRECTORY rule, or both. A pattern that ends with `/` is a directory rule
 *     (an exclude of `dir/` is the same as an exclude of `dir/**`); a pattern containing `**` is both;
 *     any other pattern is a file rule only. So `- /a/*` excludes the files directly in `a` and nothing
 *     deeper, while `- /a/**` excludes everything below `a`.
 *   - rclone walks directories first: a directory the directory rules exclude is not entered, so nothing
 *     below it syncs. Inside, the first file rule that matches decides. No match means synced.
 *   - An include rule also lets rclone enter the directories above its path; this module adds those
 *     directory includes the same way, and where it approximates (a `**` in the middle of an include) it
 *     errs towards "synced".
 *
 * A line this module cannot read is an error, never a skipped line: a rule that silently does nothing is
 * exactly the failure this guard exists to catch.
 */

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ExportError, MANIFEST_FILE, TYPE_NAMES, fileNameFor } from './format.mjs';

/** A folder under the uploads that belongs to one issue: `PSE-1061` (the card's ID when the files were saved). */
const ISSUE_FOLDER = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,8}$/;

/** Characters that mean something in a regular expression and nothing in a glob. */
function escapeRegexChar(ch) {
	return /[\\^$.*+?()[\]{}|/-]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Turn one rclone glob into a regular expression source. Throws ExportError('filter-unreadable') for a
 * pattern that cannot be turned into one (unclosed `[` or `{`, trailing backslash).
 */
export function globToRegexSource(pattern) {
	let out = '';
	let braceDepth = 0;
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === '\\') {
			i++;
			if (i >= pattern.length) throw new ExportError('filter-unreadable', 'a filter pattern ends with a backslash');
			out += escapeRegexChar(pattern[i]);
		} else if (ch === '*') {
			if (pattern[i + 1] === '*') {
				while (pattern[i + 1] === '*') i++;
				out += '.*';
			} else {
				out += '[^/]*';
			}
		} else if (ch === '?') {
			out += '[^/]';
		} else if (ch === '[') {
			let j = i + 1;
			let cls = '[';
			if (pattern[j] === '!' || pattern[j] === '^') {
				cls += '^';
				j++;
			}
			let closed = false;
			let members = 0;
			for (; j < pattern.length; j++) {
				const c = pattern[j];
				if (c === ']' && members > 0) {
					closed = true;
					break;
				}
				if (c === '\\') {
					j++;
					if (j >= pattern.length) break;
					cls += `\\${pattern[j]}`;
				} else if (c === '-' || /[A-Za-z0-9_.]/.test(c)) {
					cls += c;
				} else {
					cls += `\\${c}`;
				}
				members++;
			}
			if (!closed) throw new ExportError('filter-unreadable', 'a filter pattern has an unclosed [');
			out += `${cls}]`;
			i = j;
		} else if (ch === '{') {
			// rclone reads `{{regexp}}` as a regular expression, which this module does not model: a rule it would read as
			// literal alternatives could keep a file local here while rclone syncs it (or the other way round). Fail closed.
			if (pattern[i + 1] === '{') throw new ExportError('filter-unreadable', 'a filter pattern has {{ (an rclone regular expression), which is not supported');
			braceDepth++;
			out += '(?:';
		} else if (ch === '}') {
			if (braceDepth === 0) {
				out += '\\}';
			} else {
				braceDepth--;
				out += ')';
			}
		} else if (ch === ',' && braceDepth > 0) {
			out += '|';
		} else {
			out += escapeRegexChar(ch);
		}
	}
	if (braceDepth !== 0) throw new ExportError('filter-unreadable', 'a filter pattern has an unclosed {');
	return out;
}

/** Whole-path regular expression of a glob, anchored at the root when it starts with `/`. */
function globRegex(glob) {
	const anchored = glob.startsWith('/');
	const body = anchored ? glob.slice(1) : glob;
	return new RegExp(`${anchored ? '^' : '(?:^|/)'}${globToRegexSource(body)}$`);
}

/** The directory globs an include rule needs rclone to enter (`/a/b/c.txt` -> `/a/`, `/a/b/`). */
function includeDirGlobs(glob) {
	const anchored = glob.startsWith('/');
	const parts = (anchored ? glob.slice(1) : glob).split('/');
	const out = [];
	let prefix = anchored ? '/' : '';
	for (let i = 0; i < parts.length - 1; i++) {
		if (parts[i].includes('**')) {
			out.push(`${prefix}**`);
			return out;
		}
		prefix += `${parts[i]}/`;
		out.push(prefix);
	}
	if (parts[parts.length - 1].includes('**')) out.push(`${prefix}**`);
	return out;
}

/**
 * Parse the text of a filter file. Returns `{ fileRules, dirRules }`, each an ordered list of
 * `{ include, glob, regex, line }`; a `!` line empties both lists, as in rclone.
 */
export function parseFilter(text) {
	if (typeof text !== 'string') throw new ExportError('filter-unreadable', 'the filter text is not a string');
	let fileRules = [];
	let dirRules = [];
	const lines = text.split(/\r?\n/);
	for (let n = 0; n < lines.length; n++) {
		const line = lines[n].trim();
		if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
		if (line === '!') {
			fileRules = [];
			dirRules = [];
			continue;
		}
		const m = /^([+-])\s+(\S.*)$/.exec(line);
		if (!m) throw new ExportError('filter-unreadable', `filter line ${n + 1} is neither a rule ("- pattern" or "+ pattern") nor a comment`);
		const include = m[1] === '+';
		let glob = m[2];
		if (!/[^/]/.test(glob)) throw new ExportError('filter-unreadable', `filter line ${n + 1} has an empty pattern`);
		let isDirRule = glob.endsWith('/');
		let isFileRule = !isDirRule;
		// Excluding "dir/" is the same as excluding "dir/**" (rclone).
		if (isDirRule && !include) glob += '**';
		if (glob.includes('**')) {
			isDirRule = true;
			isFileRule = true;
		}
		const regex = globRegex(glob);
		const rule = { include, glob: m[2], regex, line: n + 1 };
		if (isFileRule) {
			fileRules.push(rule);
			if (include) for (const dirGlob of includeDirGlobs(glob)) dirRules.push({ include: true, glob: dirGlob, regex: globRegex(dirGlob), line: n + 1, implied: true });
		}
		if (isDirRule) dirRules.push(rule);
	}
	return { fileRules, dirRules };
}

/** Normalise a workspace-relative path: forward slashes, no leading slash; refuses `..` and empty. */
function normalisePath(relPath) {
	if (typeof relPath !== 'string' || relPath === '') throw new ExportError('bad-path', 'a path to check is empty');
	const parts = relPath.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
	if (parts.length === 0 || parts.includes('..')) throw new ExportError('bad-path', 'a path to check is outside the synced folder');
	return parts;
}

function firstMatch(rules, text) {
	for (const rule of rules) if (rule.regex.test(text)) return rule;
	return null;
}

/**
 * Would rclone sync the file at `relPath` (relative to the synced folder)? `{ synced, rule }`: when the
 * file is kept local `rule` is the exclude that did it (its source line number is `rule.line`); when it
 * syncs, `rule` is the include that matched, or null when no rule did.
 */
export function explain(filter, relPath) {
	const parts = normalisePath(relPath);
	// Directories first, shallowest first: rclone does not enter an excluded directory.
	for (let i = 1; i < parts.length; i++) {
		const rule = firstMatch(filter.dirRules, `${parts.slice(0, i).join('/')}/`);
		if (rule && !rule.include) return { synced: false, rule };
	}
	const rule = firstMatch(filter.fileRules, parts.join('/'));
	return { synced: rule === null || rule.include, rule };
}

/** True when rclone would sync the file at `relPath`; false when the filter keeps it local. */
export function isSynced(filter, relPath) {
	return explain(filter, relPath).synced;
}

/** The rule that decided `relPath` (see `explain`), or null. */
export function matchingRule(filter, relPath) {
	return explain(filter, relPath).rule;
}

/** Resolve symlinks of the nearest existing ancestor, then append what does not exist yet. */
function realPathLoose(p) {
	let current = resolve(p);
	const tail = [];
	while (!existsSync(current)) {
		const up = dirname(current);
		if (up === current) break;
		tail.unshift(current.slice(up.length).replace(/^[\\/]+/, ''));
		current = up;
	}
	let base;
	try {
		base = realpathSync(current);
	} catch {
		base = current;
	}
	return tail.length ? join(base, ...tail) : base;
}

/**
 * Probe paths for a folder that must stay local (the raw texts, the export folder): files that a writer
 * could create at the top, one level down and two levels down, plus a name with a dot, so a filter that
 * only names one extension or one depth does not pass. For uploads see `uploadProbePaths`.
 */
export function probePaths(folderRel) {
	const base = normalisePath(folderRel).join('/');
	return [`${base}/probe.json`, `${base}/a/probe.json`, `${base}/a/b/probe.png`, `${base}/.probe`];
}

/**
 * The files an export writer creates in its folder: the manifest and one file per entity type, by their fixed
 * names. The four generic probes above would pass a filter that keeps one of these synced by name
 * (`+ /team/board/raw/users.json` ahead of `- /team/board/raw/**`; `users.json` holds e-mail addresses).
 */
export function exportFilePaths(folderRel) {
	const base = normalisePath(folderRel).join('/');
	return [MANIFEST_FILE, ...TYPE_NAMES.map(fileNameFor)].map((name) => `${base}/${name}`);
}

/**
 * Probe paths for a folder that must reach Drive (uploads): the shape a downloader really writes,
 * `<folder>/<issue key>/<name>.<ext>`, for every extension an upload can have, in lower and upper case, plus
 * one at the top, one deeper and a name with a dot. A filter that hides any one of them hides some uploads.
 *
 * The shape is tried for `PSE-1` and for each name in `issueFolders` (the issue folders that exist now: a
 * filter line for one card, `- /team/board/files/PSE-2/**`, hides that card's uploads and no other probe).
 * A card whose folder does not exist yet cannot be probed; the check runs again at the next import.
 */
export const UPLOAD_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg', 'mp4', 'mov', 'webm', 'pdf', 'txt', 'zip', 'PNG', 'JPG', 'MOV', ''];

export function uploadProbePaths(folderRel, issueFolders = []) {
	const base = folderRel === '' ? '' : normalisePath(folderRel).join('/');
	const prefix = base === '' ? '' : `${base}/`;
	const paths = [`${prefix}probe.json`, `${prefix}.probe`];
	for (const folder of new Set(['PSE-1', ...issueFolders])) {
		paths.push(`${prefix}${folder}/.probe`, `${prefix}${folder}/a/b/shot.png`);
		for (const ext of UPLOAD_EXTENSIONS) paths.push(`${prefix}${folder}/shot${ext === '' ? '' : `.${ext}`}`);
	}
	return paths;
}

/** The issue folders (`PSE-1061`) that exist directly under `abs`, sorted; none when it does not exist yet. */
function existingIssueFolders(abs) {
	let entries;
	try {
		entries = readdirSync(abs, { withFileTypes: true });
	} catch (err) {
		if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
		throw new ExportError('bad-path', `the upload folder cannot be listed (${err.code ?? 'error'})`);
	}
	return entries.filter((e) => e.isDirectory() && ISSUE_FOLDER.test(e.name)).map((e) => e.name).sort();
}

/** Where a folder is, relative to the synced workspace: `{ rel, outside, abs }` (`rel` is '' for the workspace itself; `abs` the real path). */
function locate(folder, workspaceRoot) {
	if (typeof workspaceRoot !== 'string' || workspaceRoot === '') throw new ExportError('bad-path', 'the workspace root is not given');
	const root = realPathLoose(workspaceRoot);
	const abs = realPathLoose(isAbsolute(folder) ? folder : join(root, folder));
	const rel = relative(root, abs);
	const outside = rel === '' ? false : rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
	return { rel, outside, abs };
}

/**
 * The importer's guard for text. `folder` is a folder the importer is about to write issue text or comments
 * into (absolute, or relative to `workspaceRoot`). Throws ExportError('export-synced') unless the folder is
 * outside the synced workspace or the filter keeps everything inside it local.
 *
 * Returns `{ where: 'outside' | 'filtered', rel }` so a caller can log which case held.
 */
export function assertLocalOnly(folder, { workspaceRoot, filterText }) {
	const { rel, outside } = locate(folder, workspaceRoot);
	if (outside) return { where: 'outside', rel: null };
	if (rel === '') throw new ExportError('export-synced', 'the folder is the synced workspace itself');
	const rules = parseFilter(filterText);
	const probes = [...probePaths(rel), ...exportFilePaths(rel)];
	const unmatched = probes.filter((p) => isSynced(rules, p));
	if (unmatched.length > 0) {
		throw new ExportError(
			'export-synced',
			`the folder "${rel.split(sep).join('/')}" is inside the synced workspace and the sync filter does not keep it local (${unmatched.length} of ${probes.length} probe paths would sync); add "- /${rel.split(sep).join('/')}/**" to the filter and run the next bisync with --resync before writing here`,
		);
	}
	return { where: 'filtered', rel: rel.split(sep).join('/') };
}

/**
 * The guard for uploads, the opposite question: does EVERY path an upload can take reach Drive? Throws
 * ExportError('export-hidden') when the folder is outside the synced workspace (nothing there syncs) or the
 * filter hides any probe path: a filter that names one extension or one depth hides some uploads and not
 * others, and one visible probe path must not make the folder look fine. The probes cover `PSE-1` and every
 * issue folder that exists now (see `uploadProbePaths`), not a card that has no folder yet.
 * Returns `{ where: 'synced', rel }`.
 */
export function assertSynced(folder, { workspaceRoot, filterText }) {
	const { rel, outside, abs } = locate(folder, workspaceRoot);
	if (outside) throw new ExportError('export-hidden', 'the folder is outside the synced workspace, so nothing in it reaches Drive');
	const rules = parseFilter(filterText);
	const probes = uploadProbePaths(rel, existingIssueFolders(abs));
	const hidden = probes.filter((p) => !isSynced(rules, p));
	const shown = rel.split(sep).join('/');
	if (hidden.length > 0) {
		const rule = matchingRule(rules, hidden[0]);
		throw new ExportError('export-hidden', `the sync filter hides ${hidden.length} of ${probes.length} probe paths of "${shown}"${rule ? ` (first: filter line ${rule.line})` : ''}; uploads must reach Drive, so change or remove that filter line`);
	}
	return { where: 'synced', rel: shown };
}
