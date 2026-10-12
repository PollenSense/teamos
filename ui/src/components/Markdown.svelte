<script lang="ts">
import { renderMarkdown } from '../lib/markdown.js';

const { source }: { source: string } = $props();
const html = $derived(renderMarkdown(source));
</script>

<div class="md">{@html html}</div>

<style>
	.md {
		font-family: var(--font);
		font-size: 0.85rem;
		line-height: 1.6;
		word-wrap: break-word;
		padding: 0.4rem 0 0.6rem;
	}
	.md :global(p) { margin: 0 0 0.6rem; }
	.md :global(p:last-child) { margin-bottom: 0; }
	.md :global(h1), .md :global(h2), .md :global(h3), .md :global(h4) { margin: 0.9rem 0 0.4rem; line-height: 1.3; }
	.md :global(h1) { font-size: 1.1rem; }
	.md :global(h2) { font-size: 1rem; }
	.md :global(h3), .md :global(h4) { font-size: 0.9rem; }
	.md :global(ul), .md :global(ol) { margin: 0 0 0.6rem 1.25rem; padding: 0; }
	.md :global(li) { margin: 0.15rem 0; }
	.md :global(li > p) { margin: 0; }
	.md :global(code) {
		font-family: var(--font-mono);
		font-size: 0.8em;
		background: rgba(127, 127, 127, 0.15);
		padding: 0.1em 0.35em;
		border-radius: 3px;
	}
	.md :global(pre) {
		background: rgba(127, 127, 127, 0.12);
		padding: 0.6rem 0.75rem;
		border-radius: var(--radius);
		overflow: auto;
		margin: 0 0 0.6rem;
	}
	.md :global(pre code) { background: none; padding: 0; font-size: 0.8rem; }
	.md :global(blockquote) {
		margin: 0 0 0.6rem;
		padding-left: 0.8rem;
		border-left: 3px solid var(--border, rgba(127, 127, 127, 0.5));
		color: var(--text-muted);
	}
	.md :global(table) { border-collapse: collapse; margin: 0 0 0.6rem; font-size: 0.8rem; }
	.md :global(th), .md :global(td) {
		border: 1px solid var(--border, rgba(127, 127, 127, 0.5));
		padding: 0.2rem 0.5rem;
		text-align: left;
		vertical-align: top;
	}
	.md :global(a) { color: var(--accent, inherit); text-decoration: underline; }
	.md :global(hr) { border: 0; border-top: 1px solid var(--border, rgba(127, 127, 127, 0.5)); margin: 0.8rem 0; }
	.md :global(img) { max-width: 100%; }
</style>
