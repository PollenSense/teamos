/**
 * Turning paths in a message into links, without touching the message.
 *
 * The server scans a body for path-shaped tokens and resolves the ones it can (a file in the
 * Drive index, a file in a code repository, a dashboard page, a message) into a map: the exact text found
 * -> where it should link. The browser renders the markdown as before and, while rendering,
 * links those exact strings. The raw body is never rewritten, so the Raw view still shows what
 * the author wrote, and marked's own tokenizer decides what is code or already a link: code
 * blocks and existing links are skipped for free, a path in `backticks` becomes a link around
 * the code span.
 *
 * Both sides must find the same tokens, so the pattern lives here and nowhere else.
 */
import type { MarkedExtension, Token, Tokens } from 'marked';

export interface LinkTarget {
	href: string;
	/** Hover text. */
	title?: string;
	/** True for another site; false for a page of this dashboard (opens in the same tab). */
	external: boolean;
}

/** Exact text as written in the message -> where it links. */
export type LinkMap = Record<string, LinkTarget>;

/**
 * What is linkable in a body. Two shapes, tried at each position:
 *
 * - a message id, as the message store names them: 2026-10-12T18-44-15.508Z-0cfo;
 * - a path-shaped token: optional leading "./" or "../", one or more "segment/" parts, then an
 *   optional last segment that ends in a letter, digit, "_", "@", "+" or "~" (so a full stop that
 *   ends a sentence stays out), then an optional ":line" or ":line-line" suffix. It must contain
 *   a slash: a bare "README.md" is not a candidate.
 *
 * Neither may be preceded by a path character, "/" or ":" (that would be the middle of a URL or
 * of a longer path).
 */
const PATH = '[A-Za-z0-9_.@+~-]';
const MESSAGE_ID = '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z-[a-z0-9]{4}(?![A-Za-z0-9])';
const PATH_SHAPE = `(?:${PATH}+/)+(?:${PATH}*[A-Za-z0-9_@+~])?(?::\\d+(?:-\\d+)?)?`;
const CANDIDATE_SOURCE = `(?<![A-Za-z0-9_.@+~/:-])(?:${MESSAGE_ID}|${PATH_SHAPE})`;

const MESSAGE_ID_WHOLE = new RegExp(`^${MESSAGE_ID}$`);

/** Is this candidate a message id rather than a path? */
export function isMessageId(candidate: string): boolean {
	return MESSAGE_ID_WHOLE.test(candidate);
}

function candidateRegex(): RegExp {
	return new RegExp(CANDIDATE_SOURCE, 'g');
}

/** Every distinct linkable token in a body (code and links included: the renderer decides). */
export function findCandidates(source: string): string[] {
	const found = new Set<string>();
	for (const m of (source ?? '').matchAll(candidateRegex())) found.add(m[0]);
	return [...found];
}

/** Split an optional ":12" or ":12-20" suffix off a candidate. */
export function splitLine(candidate: string): { path: string; line?: number; lineEnd?: number } {
	const m = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(candidate);
	if (!m) return { path: candidate };
	return { path: m[1], line: m[2] ? Number(m[2]) : undefined, lineEnd: m[3] ? Number(m[3]) : undefined };
}

/**
 * Escape text for HTML without double-escaping what marked already escaped (its text tokens
 * arrive with "&", "<" and ">" encoded once).
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&(?!#?\w+;)/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function anchor(target: LinkTarget, inner: string): string {
	const title = target.title ? ` title="${escapeHtml(target.title)}"` : '';
	return `<a href="${escapeHtml(target.href)}"${title}${target.external ? '' : ' data-internal="1"'}>${inner}</a>`;
}

/** Plain text (already escaped by marked) with the known paths linked; null when none matched. */
export function linkText(text: string, links: LinkMap): string | null {
	let out = '';
	let last = 0;
	let any = false;
	for (const m of text.matchAll(candidateRegex())) {
		const target = Object.hasOwn(links, m[0]) ? links[m[0]] : undefined;
		if (!target) continue;
		const at = m.index as number;
		out += escapeHtml(text.slice(last, at)) + anchor(target, escapeHtml(m[0]));
		last = at + m[0].length;
		any = true;
	}
	if (!any) return null;
	return out + escapeHtml(text.slice(last));
}

/** A token the walkTokens pass below has marked as sitting inside a link: it must stay as it is. */
type MaybeInsideLink = { insideLink?: boolean };

function markInsideLink(tokens: Token[]): void {
	for (const t of tokens) {
		(t as MaybeInsideLink).insideLink = true;
		if ('tokens' in t && t.tokens) markInsideLink(t.tokens);
	}
}

/**
 * Renderer overrides for marked. `getLinks` is read at render time so one registered
 * extension can serve every message. Returning false keeps marked's own output.
 */
export function linkRenderer(getLinks: () => LinkMap | undefined) {
	return {
		// marked visits a parent before its children, so a link marks everything under it
		// before any of that is rendered.
		walkTokens(token: Token): void {
			if (token.type === 'link' && token.tokens) markInsideLink(token.tokens);
		},
		renderer: {
			text(token: Tokens.Text | Tokens.Escape): string | false {
				const links = getLinks();
				// A text token with children is a container (a tight list item): marked renders
				// the children, which come back here one by one.
				if (!links || ('tokens' in token && token.tokens) || ('escaped' in token && token.escaped)) return false;
				if ((token as MaybeInsideLink).insideLink) return false;
				return linkText(token.text, links) ?? false;
			},
			codespan(token: Tokens.Codespan): string | false {
				const links = getLinks();
				if (!links || (token as MaybeInsideLink).insideLink) return false;
				const target = Object.hasOwn(links, token.text) ? links[token.text] : undefined;
				if (!target) return false;
				return anchor(target, `<code>${escapeHtml(token.text)}</code>`);
			},
		},
	} satisfies MarkedExtension;
}
