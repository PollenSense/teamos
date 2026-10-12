import { readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { findCandidates, type LinkMap, type LinkTarget, splitLine } from '../lib/linkify.js';

/**
 * The `links` block of teamos.config.json. Everything is optional and nothing is assumed:
 * a project that configures no resolver gets no links.
 *
 *   "links": {
 *     "drive": { "root": "PollenBot", "index": "team/.logs/drive-index.tsv" }
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
}

export interface LinkerOptions {
	/** The workspace the paths in messages are relative to (the folder that holds team/). */
	projectRoot: string;
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

	const existsCache = new Map<string, { at: number; ok: boolean }>();
	/** Does this workspace-relative path exist under the project root? */
	async function existsInWorkspace(rel: string): Promise<boolean> {
		const hit = existsCache.get(rel);
		const now = Date.now();
		if (hit && now - hit.at < EXISTS_TTL_MS) return hit.ok;
		let ok = false;
		try {
			await stat(join(projectRoot, rel));
			ok = true;
		} catch {
			// Not there.
		}
		existsCache.set(rel, { at: now, ok });
		return ok;
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
