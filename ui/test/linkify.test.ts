import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Marked } from 'marked';
import { findCandidates, type LinkMap, linkRenderer, splitLine } from '../src/lib/linkify.js';
import { createLinker } from '../src/server/linkify.js';

const driveFile = (id: string) => `https://drive.google.com/file/d/${id}/view`;
const driveFolder = (id: string) => `https://drive.google.com/drive/folders/${id}`;

/** Same options as lib/markdown.ts, minus DOMPurify (needs a DOM). */
function render(source: string, links?: LinkMap): string {
	const marked = new Marked({ gfm: true, breaks: true });
	marked.use(linkRenderer(() => links));
	return marked.parse(source, { async: false }) as string;
}

const target = (href: string) => ({ href, external: true });

describe('findCandidates', () => {
	it('finds paths with a slash, with or without a line suffix', () => {
		const found = findCandidates(
			'See PollenBot/assets/video/drafts/x.mp4, docs/x.md:12 and tickets/complete/a-b.md. Also ../pollen/src/a.ts:3-9.',
		);
		assert.deepEqual(found.sort(), [
			'../pollen/src/a.ts:3-9',
			'PollenBot/assets/video/drafts/x.mp4',
			'docs/x.md:12',
			'tickets/complete/a-b.md',
		]);
	});

	it('keeps sentence punctuation out and a trailing slash in', () => {
		assert.deepEqual(findCandidates('Open docs/x.md. Then docs/onprem-agent-access/, please.'), [
			'docs/x.md',
			'docs/onprem-agent-access/',
		]);
	});

	it('ignores bare file names, URLs and the middle of longer paths', () => {
		assert.deepEqual(findCandidates('README.md https://example.com/a/b.html /abs/path/x.md'), []);
	});
});

describe('splitLine', () => {
	it('splits the suffix off', () => {
		assert.deepEqual(splitLine('a/b.ts:12'), { path: 'a/b.ts', line: 12, lineEnd: undefined });
		assert.deepEqual(splitLine('a/b.ts:12-20'), { path: 'a/b.ts', line: 12, lineEnd: 20 });
		assert.deepEqual(splitLine('a/b.ts'), { path: 'a/b.ts', line: undefined, lineEnd: undefined });
	});
});

describe('markdown rendering with a link map', () => {
	const links: LinkMap = { 'docs/x.md': target(driveFile('X1')), 'docs/': target(driveFolder('D1')) };

	it('links a plain path and leaves the rest alone', () => {
		const html = render('Read docs/x.md now & then a < b.', links);
		assert.match(html, /<a href="https:\/\/drive\.google\.com\/file\/d\/X1\/view">docs\/x\.md<\/a> now &amp; then a &lt; b\./);
	});

	it('wraps a path in backticks as a link around the code span', () => {
		const html = render('Read `docs/x.md` now.', links);
		assert.match(html, /<a href="[^"]*X1[^"]*"><code>docs\/x\.md<\/code><\/a>/);
	});

	it('does not touch fenced code or an existing link', () => {
		const html = render('```\ncat docs/x.md\n```\n\n[docs/x.md](https://example.com/own)\n', links);
		assert.equal((html.match(/<a /g) ?? []).length, 1);
		assert.match(html, /<pre><code>cat docs\/x\.md/);
		assert.match(html, /href="https:\/\/example\.com\/own"/);
	});

	it('does not link a code span inside a link either', () => {
		const html = render('[`docs/x.md`](https://example.com/own)', links);
		assert.equal((html.match(/<a /g) ?? []).length, 1);
	});

	it('links inside list items, tables, bold and headings', () => {
		const html = render('- see docs/x.md\n\n| a |\n|---|\n| docs/x.md |\n\n**docs/x.md**\n\n# docs/x.md\n', links);
		assert.equal((html.match(/<a /g) ?? []).length, 4);
	});

	it('is the identity without a map or without matches', () => {
		const plain = new Marked({ gfm: true, breaks: true }).parse('See docs/x.md and `docs/y.md`.', { async: false });
		assert.equal(render('See docs/x.md and `docs/y.md`.'), plain);
		assert.equal(render('See docs/x.md and `docs/y.md`.', { 'other/z.md': target('https://example.com') }), plain);
	});

	it('escapes the title and href', () => {
		const html = render('docs/x.md', { 'docs/x.md': { href: 'https://e.com/?a=1&b="2"', title: 'a "b"', external: true } });
		assert.match(html, /href="https:\/\/e\.com\/\?a=1&amp;b=&quot;2&quot;" title="a &quot;b&quot;"/);
	});

	it('marks dashboard pages as internal', () => {
		const html = render('docs/x.md', { 'docs/x.md': { href: '#/member/cy', external: false } });
		assert.match(html, /data-internal="1"/);
	});
});

describe('Drive resolver', () => {
	let root: string;
	before(async () => {
		root = await mkdtemp(join(tmpdir(), 'linkify-'));
		await mkdir(join(root, 'team', '.logs'), { recursive: true });
		await mkdir(join(root, 'docs', 'sub'), { recursive: true });
		await mkdir(join(root, 'assets', 'video', 'drafts'), { recursive: true });
		await mkdir(join(root, 'node_modules', 'x'), { recursive: true });
		await writeFile(join(root, 'docs', 'x.md'), '');
		await writeFile(join(root, 'docs', 'sub', 'new.md'), '');
		await writeFile(join(root, 'assets', 'video', 'drafts', 'fresh.mp4'), '');
		await writeFile(join(root, 'node_modules', 'x', 'y.js'), '');
		await writeFile(
			join(root, 'team', '.logs', 'drive-index.tsv'),
			[
				'./\tROOT\t',
				'docs/\tDOCS\tROOT',
				'docs/x.md\tXFILE\tDOCS',
				'docs/sub/\tSUB\tDOCS',
				'assets/\tASSETS\tROOT',
				'assets/video/\tVIDEO\tASSETS',
				'assets/video/drafts/\tDRAFTS\tVIDEO',
				'assets/video/drafts/old.mp4\tOLDMP4\tDRAFTS',
				'bad line without a second field',
				'docs/evil.md\t"><script>\tDOCS',
				'',
			].join('\n'),
		);
	});
	after(() => rm(root, { recursive: true, force: true }));

	const linker = () => createLinker({ projectRoot: root, links: { drive: { root: 'PollenBot' } } });

	it('links an indexed file and folder, with and without the Drive folder name', async () => {
		const out = await linker().linksFor('PollenBot/docs/x.md, docs/x.md, docs/, PollenBot/assets/video/drafts/old.mp4');
		assert.equal(out['PollenBot/docs/x.md'].href, driveFile('XFILE'));
		assert.equal(out['docs/x.md'].href, driveFile('XFILE'));
		assert.equal(out['docs/'].href, driveFolder('DOCS'));
		assert.equal(out['PollenBot/assets/video/drafts/old.mp4'].href, driveFile('OLDMP4'));
	});

	it('sends a path that is not indexed yet to its nearest indexed folder', async () => {
		const out = await linker().linksFor('docs/sub/new.md assets/video/drafts/fresh.mp4 PollenBot/assets/video/drafts/future.mp4 PollenBot/brand/new/x.md');
		assert.equal(out['docs/sub/new.md'].href, driveFolder('SUB'));
		assert.equal(out['assets/video/drafts/fresh.mp4'].href, driveFolder('DRAFTS'));
		assert.equal(out['PollenBot/assets/video/drafts/future.mp4'].href, driveFolder('DRAFTS'));
		assert.equal(out['PollenBot/brand/new/x.md'].href, driveFolder('ROOT'));
		assert.match(out['docs/sub/new.md'].title ?? '', /Not on Drive yet/);
	});

	it('leaves out what is not a real path', async () => {
		const out = await linker().linksFor(
			'and/or 10/12 docs/nope.md ../docs/x.md PollenBot/../etc/passwd node_modules/x/y.js team/.logs/a.log docs/evil.md',
		);
		assert.deepEqual(Object.keys(out), []);
	});

	it('keeps the line suffix in the key and drops it for the link', async () => {
		const out = await linker().linksFor('docs/x.md:12-20');
		assert.equal(out['docs/x.md:12-20'].href, driveFile('XFILE'));
	});

	it('links the synced folder itself', async () => {
		const out = await linker().linksFor('PollenBot/ and PollenBot/docs');
		assert.equal(out['PollenBot/'].href, driveFolder('ROOT'));
		assert.equal(out['PollenBot/docs'].href, driveFolder('DOCS'));
	});

	it('does nothing without a drive block or without an index file', async () => {
		assert.deepEqual(await createLinker({ projectRoot: root }).linksFor('docs/x.md'), {});
		assert.deepEqual(
			await createLinker({ projectRoot: root, links: { drive: { index: 'nope.tsv' } } }).linksFor('docs/x.md'),
			{},
		);
	});

	it('picks up a rewritten index', async () => {
		const l = createLinker({ projectRoot: root, links: { drive: { root: 'PollenBot', index: 'team/.logs/second.tsv' } } });
		await writeFile(join(root, 'team', '.logs', 'second.tsv'), 'docs/x.md\tONE\tD\n');
		assert.equal((await l.linksFor('docs/x.md'))['docs/x.md'].href, driveFile('ONE'));
		await new Promise((r) => setTimeout(r, 20));
		await writeFile(join(root, 'team', '.logs', 'second.tsv'), 'docs/x.md\tTWO\tD\n');
		assert.equal((await l.linksFor('docs/x.md'))['docs/x.md'].href, driveFile('TWO'));
	});
});
