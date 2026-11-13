/**
 * Which paths does an rclone filter file keep off Drive?
 *
 * The board import writes issue text, comments and screenshots into folders that must stay on this
 * machine (`team/board/raw/`, `team/board/files/`, and the export folder the fetcher fills). Text that
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

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ExportError } from './format.mjs';

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
 * Probe paths for a folder: files that a writer could create at the top, one level down and two levels
 * down (an upload `files/PSE-1/shot.png`), plus a name with a dot, so a filter that only names one
 * extension or one depth does not pass.
 */
export function probePaths(folderRel) {
	const base = normalisePath(folderRel).join('/');
	return [`${base}/probe.json`, `${base}/a/probe.json`, `${base}/a/b/probe.png`, `${base}/.probe`];
}

/**
 * The importer's guard. `folder` is a folder the importer is about to write text or uploads into
 * (absolute, or relative to `workspaceRoot`). Throws ExportError('export-synced') unless the folder is
 * outside the synced workspace or the filter keeps everything inside it local.
 *
 * Returns `{ where: 'outside' | 'filtered', rel }` so a caller can log which case held.
 */
export function assertLocalOnly(folder, { workspaceRoot, filterText }) {
	if (typeof workspaceRoot !== 'string' || workspaceRoot === '') throw new ExportError('bad-path', 'the workspace root is not given');
	const root = realPathLoose(workspaceRoot);
	const abs = realPathLoose(isAbsolute(folder) ? folder : join(root, folder));
	const rel = relative(root, abs);
	const outside = rel === '' ? false : rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
	if (outside) return { where: 'outside', rel: null };
	if (rel === '') throw new ExportError('export-synced', 'the folder is the synced workspace itself');
	const rules = parseFilter(filterText);
	const unmatched = probePaths(rel).filter((p) => isSynced(rules, p));
	if (unmatched.length > 0) {
		throw new ExportError(
			'export-synced',
			`the folder "${rel.split(sep).join('/')}" is inside the synced workspace and the sync filter does not keep it local (${unmatched.length} of 4 probe paths would sync); add "- /${rel.split(sep).join('/')}/**" to the filter and run the next bisync with --resync before writing here`,
		);
	}
	return { where: 'filtered', rel: rel.split(sep).join('/') };
}
