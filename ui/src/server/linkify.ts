import { readFile, stat } from 'node:fs/promises';
import { join, posix, relative, resolve, sep } from 'node:path';
import { findCandidates, isMessageId, type LinkMap, type LinkTarget, splitLine } from '../lib/linkify.js';

/**
 * The `links` block of teamos.config.json. Everything is optional and nothing is assumed:
 * Drive and repository links exist only where configured. Links to the dashboard's own pages
 * (a member's state, a message id) need no configuration; `dashboard: false` turns them off.
 *
 *   "links": {
 *     "drive": { "root": "PollenBot", "index": "team/.logs/drive-index.tsv" },
 *     "repos": { "pollen": { "url": "https://github.com/PollenSense/pollen" } }
 *   }
 */
export interface LinksConfig {
	/**
	 * Files that live in a Google Drive folder synced with the workspace. `root` is the name
	 * people write for the synced folder ("PollenBot/docs/x.md"); `index` is a tab-separated
	 * file of `path, Drive id, parent id` (folders end in "/", the folder itself is "./")
	 * relative to the project root; default `team/.logs/drive-index.tsv`.
	 */
	drive?: { root?: string; index?: string };
	/**
	 * Source repositories checked out next to the workspace. The key is the name people write
	 * ("pollen/src/a.ts:12", "../pollen/src/a.ts:12"); `url` is the web address of the repository;
	 * `dir` is the checkout, relative to the project root or absolute (default `../<key>`); `branch` is the one
	 * the links point at (default `main`). A path is linked only if it exists in the checkout.
	 */
	repos?: Record<string, { url: string; dir?: string; branch?: string }>;
	/** Links to this dashboard's pages. Default true. */
	dashboard?: boolean;
}

export interface LinkerOptions {
	/** The workspace the paths in messages are relative to (the folder that holds team/). */
	projectRoot: string;
	/** The team folder (members.json, members/<name>/...). Needed for links to member pages. */
	teamDir?: string;
	/** Does a message with this id exist? Needed for links to messages. */
	messageExists?: (id: string) => Promise<boolean>;
	links?: LinksConfig;
}

export interface Linker {
	/** Resolve the path-shaped tokens in a message body; unresolvable ones are left out. */
	linksFor(body: string): Promise<LinkMap>;
}

const DRIVE_ID = /^[A-Za-z0-9_-]+$/;
/** How long "does this file exist" answers are reused; bodies repeat the same paths. */
const EXISTS_TTL_MS = 10_000;

/** One parsed candidate handed to each resolver. */
interface Candidate {
	/** The text as written, with any ":line" suffix. */
	text: string;
	/** The path part, without the suffix. */
	path: string;
	line?: number;
	lineEnd?: number;
}

type Resolver = (c: Candidate) => Promise<LinkTarget | null>;

export function createLinker(opts: LinkerOptions): Linker {
	const { projectRoot } = opts;
	const config = opts.links ?? {};
	const resolvers: Resolver[] = [];

	// ─── Shared helpers ──────────────────────────────────────

	const statCache = new Map<string, { at: number; kind: 'file' | 'dir' | null }>();
	/** What is at this absolute path: a file, a folder, or nothing. */
	async function kindOf(abs: string): Promise<'file' | 'dir' | null> {
		const hit = statCache.get(abs);
		const now = Date.now();
		if (hit && now - hit.at < EXISTS_TTL_MS) return hit.kind;
		let kind: 'file' | 'dir' | null = null;
		try {
			kind = (await stat(abs)).isDirectory() ? 'dir' : 'file';
		} catch {
			// Not there.
		}
		statCache.set(abs, { at: now, kind });
		return kind;
	}
	/** Does this workspace-relative path exist under the project root? */
	async function existsInWorkspace(rel: string): Promise<boolean> {
		return (await kindOf(join(projectRoot, rel))) !== null;
	}

	/**
	 * A workspace path made safe to look up: no "..", no hidden or dependency folders (those never
	 * reach Drive and are not worth a link). Returns the path without leading "./" or a trailing
	 * slash, or null.
	 */
	function cleanRelative(path: string): string | null {
		const rel = path.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
		if (!rel) return null;
		const segments = rel.split('/');
		if (segments.some((s) => s === '..' || s.startsWith('.') || s === 'node_modules')) return null;
		return posix.normalize(rel);
	}

	// ─── The dashboard's own pages ───────────────────────────

	if (config.dashboard !== false) {
		const { teamDir, messageExists } = opts;
		const teamRel = teamDir ? relative(projectRoot, teamDir).split(sep).join('/') : '';
		const teamInside = !!teamRel && !teamRel.startsWith('..');
		/** The tab of a member's page that shows each of their files. */
		const tabOf: Record<string, string> = { 'state.md': 'state', 'todo.json': 'todos', 'schedule.json': 'schedule' };
		const memberFile = teamInside
			? new RegExp(`^(?:\\./)*${teamRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/members/([^/]+)/(state\\.md|todo\\.json|schedule\\.json)$`)
			: null;

		let members: { mtimeMs: number; names: Set<string> } | null = null;
		async function memberNames(): Promise<Set<string>> {
			const file = join(teamDir as string, 'members.json');
			try {
				const mtimeMs = (await stat(file)).mtimeMs;
				if (members && members.mtimeMs === mtimeMs) return members.names;
				const parsed = JSON.parse(await readFile(file, 'utf-8'));
				const names = new Set<string>(
					(Array.isArray(parsed?.members) ? parsed.members : []).map((m: { name?: unknown }) => String(m?.name ?? '')),
				);
				members = { mtimeMs, names };
				return names;
			} catch {
				return new Set();
			}
		}

		const resolveDashboard: Resolver = async ({ text, path }) => {
			if (isMessageId(text)) {
				if (!messageExists || !(await messageExists(text))) return null;
				return { href: `#/message/${text}`, title: 'Open this message in the dashboard', external: false };
			}
			const m = memberFile?.exec(path);
			if (!m || !(await memberNames()).has(m[1])) return null;
			return {
				href: `#/member/${encodeURIComponent(m[1])}?tab=${tabOf[m[2]]}`,
				title: `Open ${m[1]}'s ${tabOf[m[2]]} in the dashboard`,
				external: false,
			};
		};
		resolvers.push(resolveDashboard);
	}

	// ─── Code in a source repository ─────────────────────────

	const repos = new Map<string, { url: string; dir: string; branch: string }>();
	for (const [name, repo] of Object.entries(config.repos ?? {})) {
		// The address goes into an href, so only a plain https address is accepted.
		const url = (repo?.url ?? '').replace(/\.git$/, '').replace(/\/+$/, '');
		if (!/^https:\/\/[^\s"'<>]+$/.test(url) || name.includes('/')) continue;
		repos.set(name, { url, dir: repo.dir ?? `../${name}`, branch: repo.branch ?? 'main' });
	}

	if (repos.size > 0) {
		const resolveCode: Resolver = async ({ path, line, lineEnd }) => {
			const m = /^(?:\.\/)*(?:\.\.\/)?([^/]+)\/(.+)$/.exec(path);
			const repo = m ? repos.get(m[1]) : undefined;
			if (!m || !repo) return null;
			const rel = m[2].replace(/\/+$/, '');
			// A repository's own hidden files (.github/...) are fine; its git store and dependencies are not.
			if (!rel || rel.split('/').some((seg) => seg === '..' || seg === '.git' || seg === 'node_modules')) return null;
			const kind = await kindOf(resolve(projectRoot, repo.dir, rel));
			if (!kind) return null;
			const webPath = rel.split('/').map(encodeURIComponent).join('/');
			const anchor = kind === 'file' && line ? `#L${line}${lineEnd && lineEnd > line ? `-L${lineEnd}` : ''}` : '';
			return {
				href: `${repo.url}/${kind === 'dir' ? 'tree' : 'blob'}/${encodeURIComponent(repo.branch)}/${webPath}${anchor}`,
				title: `Open ${m[1]}/${rel} on GitHub (${repo.branch} branch; work that is not merged and pushed yet is not there)`,
				external: true,
			};
		};
		resolvers.push(resolveCode);
	}

	// ─── Drive ───────────────────────────────────────────────

	if (config.drive) {
		const driveRoot = (config.drive.root ?? '').replace(/^\/+|\/+$/g, '');
		const indexPath = join(projectRoot, config.drive.index ?? 'team/.logs/drive-index.tsv');
		let cached: { mtimeMs: number; ids: Map<string, string> } | null = null;

		/** path -> Drive id; "./" is the synced folder itself. Null if there is no usable index. */
		async function loadIndex(): Promise<Map<string, string> | null> {
			let mtimeMs: number;
			try {
				mtimeMs = (await stat(indexPath)).mtimeMs;
			} catch {
				return null;
			}
			if (cached && cached.mtimeMs === mtimeMs) return cached.ids;
			const ids = new Map<string, string>();
			try {
				for (const line of (await readFile(indexPath, 'utf-8')).split('\n')) {
					const [path, id] = line.split('\t');
					if (path && id && DRIVE_ID.test(id)) ids.set(path, id);
				}
			} catch {
				return null;
			}
			cached = { mtimeMs, ids };
			return ids;
		}

		const fileHref = (id: string) => `https://drive.google.com/file/d/${id}/view`;
		const folderHref = (id: string) => `https://drive.google.com/drive/folders/${id}`;

		const resolveDrive: Resolver = async ({ path }) => {
			let p = path.replace(/^(\.\/)+/, '');
			let explicit = false;
			if (driveRoot && (p === driveRoot || p.startsWith(`${driveRoot}/`))) {
				explicit = true;
				p = p.slice(driveRoot.length).replace(/^\/+/, '');
			}
			const ids = await loadIndex();
			if (!ids) return null;

			if (explicit && !p.replace(/\/+$/, '')) {
				const rootId = ids.get('./');
				return rootId ? { href: folderHref(rootId), title: 'Open the folder in Google Drive', external: true } : null;
			}
			const rel = cleanRelative(p);
			if (!rel) return null;

			const fileId = ids.get(rel);
			if (fileId) return { href: fileHref(fileId), title: `Open ${rel} in Google Drive`, external: true };
			const folderId = ids.get(`${rel}/`);
			if (folderId) return { href: folderHref(folderId), title: `Open ${rel}/ in Google Drive`, external: true };

			// Not (yet) on Drive. Worth a link only when it plausibly exists: written with the Drive
			// folder's name, or present in the workspace and waiting for its next sync.
			if (!explicit && !(await existsInWorkspace(rel))) return null;
			for (let dir = posix.dirname(rel); dir !== '.'; dir = posix.dirname(dir)) {
				const parentId = ids.get(`${dir}/`);
				if (parentId) {
					return { href: folderHref(parentId), title: `Not on Drive yet; opens the nearest folder, ${dir}/`, external: true };
				}
			}
			const rootId = ids.get('./');
			return rootId ? { href: folderHref(rootId), title: 'Not on Drive yet; opens the synced folder', external: true } : null;
		};
		resolvers.push(resolveDrive);
	}

	// ─── Resolve a body ──────────────────────────────────────

	return {
		async linksFor(body: string): Promise<LinkMap> {
			const out: LinkMap = {};
			if (resolvers.length === 0) return out;
			for (const text of findCandidates(body)) {
				const candidate: Candidate = { text, ...splitLine(text) };
				for (const resolve of resolvers) {
					const target = await resolve(candidate);
					if (target) {
						out[text] = target;
						break;
					}
				}
			}
			return out;
		},
	};
}
