import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { attachmentRenderer, isServedAttachmentUrl } from './attachments.js';
import { type LinkMap, linkRenderer } from './linkify.js';
import { splitMentions } from './mentions.js';

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
marked.use(attachmentRenderer());

/**
 * Nothing in a message may fetch from another site on its own: an image, a video's first bytes,
 * a stylesheet background, an image-type button all tell that site who read the message and when.
 * The only picture a message can show is one of its own stored attachments (see lib/attachments.ts);
 * markdown images to other addresses are already links, and these cover the raw-HTML routes. Forms
 * go too (a message is not a place to type into), and `<input>` stays only as the checkbox of a
 * task list.
 */
const NO_AUTO_FETCH = {
	USE_PROFILES: { html: true },
	FORBID_TAGS: ['video', 'audio', 'source', 'track', 'picture', 'form'],
	FORBID_ATTR: ['style', 'srcset', 'poster', 'background', 'action', 'formaction'],
};

DOMPurify.addHook('uponSanitizeElement', (node, data) => {
	const el = node as Element;
	const drop =
		(data.tagName === 'img' && !isServedAttachmentUrl(el.getAttribute('src') ?? '')) ||
		(data.tagName === 'input' && (el.getAttribute('type') ?? '').toLowerCase() !== 'checkbox');
	if (drop) node.parentNode?.removeChild(node);
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
	// Another site opens in a new tab; a page of this dashboard (data-internal) stays in this one.
	if (node.tagName === 'A' && !node.hasAttribute('data-internal')) {
		node.setAttribute('target', '_blank');
		node.setAttribute('rel', 'noopener noreferrer');
	}
});

/**
 * Highlight the tags a message made (`mentions`, see lib/mentions.ts): `@name` in plain text becomes a link to the
 * member's page. Runs on the sanitized HTML and builds its elements itself (text via textContent, the address from a
 * name that is letters, digits and underscores), so nothing from the message becomes markup. Code, quotes and
 * existing links are left as they are, like the server's rule.
 */
function highlightMentions(html: string, mentions: readonly string[]): string {
	const holder = document.createElement('template');
	holder.innerHTML = html;
	const texts: Text[] = [];
	const walker = document.createTreeWalker(holder.content, NodeFilter.SHOW_TEXT);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
	for (const node of texts) {
		if (!node.data.includes('@') || node.parentElement?.closest('a, code, pre, blockquote')) continue;
		const parts = splitMentions(node.data, mentions);
		if (parts.length === 1 && !('mention' in parts[0])) continue;
		const frag = document.createDocumentFragment();
		for (const part of parts) {
			if ('mention' in part) {
				const a = document.createElement('a');
				a.className = 'mention';
				a.setAttribute('href', `#/member/${part.mention}`);
				a.setAttribute('data-internal', '1');
				a.textContent = part.text;
				frag.append(a);
			} else {
				frag.append(part.text);
			}
		}
		node.replaceWith(frag);
	}
	return holder.innerHTML;
}

export function renderMarkdown(source: string, links?: LinkMap, mentions?: readonly string[]): string {
	activeLinks = links;
	try {
		const html = marked.parse(source ?? '', { async: false }) as string;
		const clean = DOMPurify.sanitize(html, NO_AUTO_FETCH);
		return mentions?.length ? highlightMentions(clean, mentions) : clean;
	} finally {
		activeLinks = undefined;
	}
}
