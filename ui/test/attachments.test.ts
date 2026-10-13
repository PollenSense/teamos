import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Marked } from 'marked';
import {
	type AttachmentLimits,
	appendBlock,
	attachmentRenderer,
	attachmentUrl,
	fitWithin,
	insertAt,
	isServedAttachmentUrl,
	jpegName,
	pastedName,
	placeholder,
	planImage,
	removePlaceholder,
	swapPlaceholderRef,
} from '../src/lib/attachments.js';
import { type LinkMap, linkRenderer } from '../src/lib/linkify.js';

const limits: AttachmentLimits = {
	maxBytes: 8 * 1024 * 1024,
	maxCount: 10,
	maxTotalBytes: 25 * 1024 * 1024,
	types: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
};

const ID = '2026-10-13T16-33-49.548Z-szrx';

/** Same extensions as lib/markdown.ts, minus DOMPurify (needs a DOM). */
function render(source: string, links?: LinkMap): string {
	const marked = new Marked({ gfm: true, breaks: true });
	marked.use(linkRenderer(() => links));
	marked.use(attachmentRenderer());
	return marked.parse(source, { async: false }) as string;
}

describe('attachmentUrl', () => {
	it('maps a stored path to the route that serves it', () => {
		assert.equal(attachmentUrl(`attachments/${ID}/shot-1.png`), `/api/messages/${ID}/attachments/shot-1.png`);
		assert.equal(attachmentUrl(`  attachments/${ID}/a.webp `), `/api/messages/${ID}/attachments/a.webp`);
	});

	it('refuses everything else', () => {
		for (const href of [
			'https://example.com/a.png',
			'//example.com/a.png',
			'/api/messages/x/attachments/a.png',
			`attachments/${ID}/../../secret.png`,
			`attachments/../a.png`,
			`attachments/${ID}/A.png`,
			`attachments/${ID}/a.svg`,
			`attachments/${ID}/a/b.png`,
			`team/messages/attachments/${ID}/a.png`,
			'data:image/png;base64,AAAA',
			'javascript:alert(1)',
			'',
		]) {
			assert.equal(attachmentUrl(href), null, href);
		}
	});

	it('knows which addresses the sanitizer may keep on an <img>', () => {
		assert.equal(isServedAttachmentUrl(`/api/messages/${ID}/attachments/a.png`), true);
		assert.equal(isServedAttachmentUrl('https://example.com/a.png'), false);
		assert.equal(isServedAttachmentUrl(`/api/messages/${ID}/attachments/a.svg`), false);
		assert.equal(isServedAttachmentUrl('/api/messages/../attachments/a.png'), false);
		assert.equal(isServedAttachmentUrl(''), false);
	});
});

describe('attachmentRenderer', () => {
	it('renders a stored image as an image inside a link to the full-size file', () => {
		const html = render(`See ![Chart of counts](attachments/${ID}/chart.png) here`);
		assert.match(html, /<a class="md-image" href="\/api\/messages\/[^"]+\/attachments\/chart\.png" target="_blank" rel="noopener noreferrer">/);
		assert.match(html, /<img src="\/api\/messages\/[^"]+\/attachments\/chart\.png" alt="Chart of counts" loading="lazy">/);
	});

	it('turns an image from anywhere else into a plain link, so nothing loads on its own', () => {
		const html = render('![tracking pixel](https://evil.example/p.gif?u=1)');
		assert.doesNotMatch(html, /<img/);
		assert.match(html, /<a href="https:\/\/evil\.example\/p\.gif\?u=1">tracking pixel<\/a>/);
		assert.doesNotMatch(render('![](https://evil.example/p.gif)'), /<img/);
		assert.doesNotMatch(render('![x](data:image/png;base64,AAAA)'), /<img/);
		assert.doesNotMatch(render(`![x](attachments/${ID}/../../a.png)`), /<img/);
	});

	it('escapes a caption with markup in it', () => {
		const html = render(`![a "quoted" <b>caption</b>](attachments/${ID}/a.png)`);
		assert.doesNotMatch(html, /<b>/);
		assert.match(html, /alt="a &quot;quoted&quot; &lt;b&gt;caption&lt;\/b&gt;"/);
	});

	it('leaves path links in the text working next to an image', () => {
		const links: LinkMap = { 'docs/messages.md': { href: 'https://github.com/x/y/blob/main/docs/messages.md', external: true } };
		const html = render(`See docs/messages.md\n\n![s](attachments/${ID}/s.png)`, links);
		assert.match(html, /<a [^>]*href="https:\/\/github\.com\/x\/y\/blob\/main\/docs\/messages\.md"/);
		assert.match(html, /<img src="\/api\/messages\//);
	});
});

describe('compose helpers', () => {
	it('builds the placeholder markdown from a file name', () => {
		assert.equal(placeholder('Screenshot [1].png', 'pending-1'), '![Screenshot  1](attachment:pending-1)');
		assert.equal(placeholder('.png', 'abc'), '![image](attachment:abc)');
	});

	it('inserts at the caret on its own line', () => {
		assert.deepEqual(insertAt('hello world', 5, '![a](attachment:x)'), {
			body: 'hello\n![a](attachment:x)\n world',
			caret: 'hello\n![a](attachment:x)'.length,
		});
		assert.equal(insertAt('', 0, 'IMG').body, 'IMG');
		assert.equal(insertAt('line one\n', 9, 'IMG').body, 'line one\nIMG');
		assert.equal(insertAt('abc', 99, 'IMG').body, 'abc\nIMG');
		assert.equal(insertAt('abc', -4, 'IMG').body, 'IMG\nabc');
	});

	it('appends as a paragraph at the end', () => {
		assert.equal(appendBlock('text', 'IMG').body, 'text\n\nIMG\n');
		assert.equal(appendBlock('text\n\n\n', 'IMG').body, 'text\n\nIMG\n');
		assert.equal(appendBlock('', 'IMG').body, 'IMG\n');
	});

	it('removes a placeholder with its line, and only that one', () => {
		const body = 'before\n![a](attachment:aaa)\nmiddle ![b](attachment:bbb) end\n\n![c](attachment:ccc)\n';
		assert.equal(removePlaceholder(body, 'aaa'), 'before\nmiddle ![b](attachment:bbb) end\n\n![c](attachment:ccc)\n');
		assert.equal(removePlaceholder(body, 'bbb'), 'before\n![a](attachment:aaa)\nmiddle  end\n\n![c](attachment:ccc)\n');
		assert.equal(removePlaceholder(body, 'nope'), body);
		assert.equal(removePlaceholder('![a](attachment:pending-1)\n', 'pending-1'), '');
	});

	it('swaps the pending reference for the token', () => {
		assert.equal(swapPlaceholderRef('x ![a](attachment:pending-1) y', 'pending-1', 'f00d'), 'x ![a](attachment:f00d) y');
	});

	it('names pasted images by time', () => {
		const at = new Date(2026, 9, 13, 9, 5, 7);
		assert.equal(pastedName(at, 'png'), 'pasted-20261013-090507.png');
		assert.equal(pastedName(at, 'jpg', 2), 'pasted-20261013-090507-2.jpg');
	});
});

describe('planImage', () => {
	const file = (type: string, name: string, size = 1000) => ({ type, name, size });

	it('keeps png, gif and webp that fit', () => {
		assert.deepEqual(planImage(file('image/png', 'a.png'), limits), { kind: 'keep' });
		assert.deepEqual(planImage(file('image/gif', 'a.gif'), limits), { kind: 'keep' });
		assert.deepEqual(planImage(file('image/webp', 'a.webp'), limits), { kind: 'keep' });
	});

	it('draws jpeg and phone formats again (shrink, strip location)', () => {
		assert.deepEqual(planImage(file('image/jpeg', 'IMG_1.jpg', 3_000_000), limits), { kind: 'reencode' });
		assert.deepEqual(planImage(file('image/heic', 'IMG_2.heic'), limits), { kind: 'reencode' });
		assert.deepEqual(planImage(file('', 'IMG_3.HEIC'), limits), { kind: 'reencode' });
		assert.deepEqual(planImage(file('image/avif', 'a.avif'), limits), { kind: 'reencode' });
	});

	it('shrinks a png or webp over the limit, refuses a gif over the limit', () => {
		assert.deepEqual(planImage(file('image/png', 'big.png', limits.maxBytes + 1), limits), { kind: 'reencode' });
		const gif = planImage(file('image/gif', 'big.gif', limits.maxBytes + 1), limits);
		assert.equal(gif.kind, 'refuse');
	});

	it('refuses svg and non-images', () => {
		assert.equal(planImage(file('image/svg+xml', 'a.svg'), limits).kind, 'refuse');
		assert.equal(planImage(file('application/pdf', 'a.pdf'), limits).kind, 'refuse');
		assert.equal(planImage(file('', 'notes.txt'), limits).kind, 'refuse');
	});
});

describe('sizes and names', () => {
	it('fits the long side without enlarging', () => {
		assert.deepEqual(fitWithin(4032, 3024), { width: 2560, height: 1920 });
		assert.deepEqual(fitWithin(3024, 4032), { width: 1920, height: 2560 });
		assert.deepEqual(fitWithin(1000, 800), { width: 1000, height: 800 });
		assert.deepEqual(fitWithin(2560, 100), { width: 2560, height: 100 });
		assert.deepEqual(fitWithin(10000, 1), { width: 2560, height: 1 });
	});

	it('renames a re-encoded file to .jpg', () => {
		assert.equal(jpegName('IMG_0042.HEIC'), 'IMG_0042.jpg');
		assert.equal(jpegName('shot.png'), 'shot.jpg');
		assert.equal(jpegName('noext'), 'noext.jpg');
		assert.equal(jpegName('.png'), 'image.jpg');
	});
});
