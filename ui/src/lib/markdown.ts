import DOMPurify from 'dompurify';
import { marked } from 'marked';

/**
 * Messages are written in markdown (the compose box says so, and the agents write it). The
 * mailbox shows the rendered form by default; the raw text stays one click away. Everything
 * goes through DOMPurify because a body can come from any member, including a human whose
 * dashboard identity was not enforced, and a message must never run script in another
 * member's tab.
 */
marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
	if (node.tagName === 'A') {
		node.setAttribute('target', '_blank');
		node.setAttribute('rel', 'noopener noreferrer');
	}
});

export function renderMarkdown(source: string): string {
	const html = marked.parse(source ?? '', { async: false }) as string;
	return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
