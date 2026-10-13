import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { type LinkMap, linkRenderer } from './linkify.js';

/**
 * Messages are written in markdown (the compose box says so, and the agents write it). The
 * mailbox shows the rendered form by default; the raw text stays one click away. Everything
 * goes through DOMPurify because a body can come from any member, including a human whose
 * dashboard identity was not enforced, and a message must never run script in another
 * member's tab.
 */
marked.setOptions({ gfm: true, breaks: true });

/**
 * Paths the server resolved for the message being rendered (see lib/linkify.ts). Set for the
 * duration of one synchronous parse; the extension below reads it.
 */
let activeLinks: LinkMap | undefined;
marked.use(linkRenderer(() => activeLinks));

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
	// Another site opens in a new tab; a page of this dashboard (data-internal) stays in this one.
	if (node.tagName === 'A' && !node.hasAttribute('data-internal')) {
		node.setAttribute('target', '_blank');
		node.setAttribute('rel', 'noopener noreferrer');
	}
});

export function renderMarkdown(source: string, links?: LinkMap): string {
	activeLinks = links;
	try {
		const html = marked.parse(source ?? '', { async: false }) as string;
		return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
	} finally {
		activeLinks = undefined;
	}
}
