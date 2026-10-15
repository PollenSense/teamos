import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
	AttachmentStore,
	MAX_ATTACHMENTS,
	MAX_ATTACHMENT_BYTES,
	applyAttachmentsToBody,
	isAttachmentName,
	isMessageId,
	safeAttachmentName,
	sniffImage,
} from './attachments.mjs';
import { FileMessagingAdapter } from './file.mjs';

// The smallest real png (1×1), plus header-only stand-ins for the other formats:
// the rules look at the first bytes, nothing more.
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64',
);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]);

async function withDir(fn) {
	const dir = await mkdtemp(join(tmpdir(), 'teamos-att-'));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function writeImage(dir, name, bytes = PNG) {
	const path = join(dir, name);
	await writeFile(path, bytes);
	return path;
}

test('sniffImage reads the first bytes: png, jpg, gif, webp; nothing else', () => {
	assert.equal(sniffImage(PNG).ext, 'png');
	assert.equal(sniffImage(JPG).mime, 'image/jpeg');
	assert.equal(sniffImage(GIF).ext, 'gif');
	assert.equal(sniffImage(WEBP).ext, 'webp');
	assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
	assert.equal(sniffImage(Buffer.from('<html><script>alert(1)</script></html>')), null);
	assert.equal(sniffImage(Buffer.from('PK\x03\x04 a zip file pretending')), null);
	assert.equal(sniffImage(Buffer.alloc(4)), null);
	assert.equal(sniffImage(null), null);
});

test('safeAttachmentName keeps a plain name, cuts the rest, takes the real extension', () => {
	assert.equal(safeAttachmentName('Screenshot 2026-10-13 at 3.45.12 PM.PNG', 'png'), 'screenshot-2026-10-13-at-3.45.12-pm.png');
	assert.equal(safeAttachmentName('../../etc/passwd', 'png'), 'passwd.png');
	assert.equal(safeAttachmentName('C:\\Users\\kris\\IMG_0042.HEIC', 'jpg'), 'img_0042.jpg');
	assert.equal(safeAttachmentName('', 'png'), 'image.png');
	assert.equal(safeAttachmentName('...', 'png'), 'image.png');
	assert.equal(safeAttachmentName('.hidden', 'png'), 'hidden.png');
	assert.equal(safeAttachmentName('évènement 日本.png', 'png'), 'v-nement.png');
	assert.equal(safeAttachmentName('a'.repeat(200), 'png').length, 64);
	assert.equal(safeAttachmentName('shot.png', 'png', new Set(['shot.png', 'shot-2.png'])), 'shot-3.png');
	assert.ok(isAttachmentName(safeAttachmentName('x y/z\u0000.gif', 'gif')));
});

test('name and id checks refuse traversal and odd extensions', () => {
	assert.equal(isAttachmentName('a.png'), true);
	assert.equal(isAttachmentName('../a.png'), false);
	assert.equal(isAttachmentName('a/b.png'), false);
	assert.equal(isAttachmentName('a.svg'), false);
	assert.equal(isAttachmentName('A.png'), false);
	assert.equal(isAttachmentName('.png'), false);
	assert.equal(isMessageId('2026-10-13T16-33-49.548Z-szrx'), true);
	assert.equal(isMessageId('..'), false);
	assert.equal(isMessageId('a/b'), false);
	assert.equal(isMessageId('x..y'), false);
	assert.equal(isMessageId(''), false);
});

test('applyAttachmentsToBody fills placeholders and appends the unreferenced', () => {
	const prepared = [
		{ name: 'a.png', ref: 'aaaa', original: 'a.png' },
		{ name: 'b.png', ref: 'bbbb', original: 'Photo of [the] thing.jpeg' },
	];
	const out = applyAttachmentsToBody('Look: ![a](attachment:aaaa) done', 'ID1', prepared);
	assert.equal(out, 'Look: ![a](attachments/ID1/a.png) done\n\n![Photo of  the  thing](attachments/ID1/b.png)');
	assert.throws(
		() => applyAttachmentsToBody('![x](attachment:zzzz)', 'ID1', prepared),
		/refers to an attachment that was not sent/,
	);
	assert.equal(applyAttachmentsToBody('plain', 'ID1', []), 'plain');
});

test('sendMessage stores images beside the message, rewrites the body, lists them in the frontmatter', () =>
	withDir(async (dir) => {
		const adapter = new FileMessagingAdapter(join(dir, 'team'));
		const a = await writeImage(dir, 'Shot One.PNG');
		const b = await writeImage(dir, 'two', JPG);
		const { id } = await adapter.sendMessage({
			from: 'alice',
			to: ['bob'],
			subject: 'pics',
			body: 'See ![first](attachment:tok1)',
			attachments: [
				{ path: a, name: 'Shot One.PNG', ref: 'tok1' },
				{ path: b, name: 'two' },
			],
		});
		const msgDir = join(dir, 'team', 'messages');
		assert.deepEqual((await readdir(join(msgDir, 'attachments', id))).sort(), ['shot-one.png', 'two.jpg']);
		const raw = await readFile(join(msgDir, `${id}.md`), 'utf-8');
		assert.match(raw, /^attachments: \[shot-one\.png, two\.jpg\]$/m);
		const msg = await adapter.readMessage(id);
		assert.deepEqual(msg.attachments, ['shot-one.png', 'two.jpg']);
		assert.equal(
			msg.body,
			`See ![first](attachments/${id}/shot-one.png)\n\n![two](attachments/${id}/two.jpg)`,
		);
		assert.deepEqual(await readFile(join(msgDir, 'attachments', id, 'shot-one.png')), PNG);
	}));

test('a message without attachments is unchanged and writes no attachments folder', () =>
	withDir(async (dir) => {
		const adapter = new FileMessagingAdapter(join(dir, 'team'));
		const { id } = await adapter.sendMessage({ from: 'a', to: ['b'], subject: 's', body: 'see ![x](attachment:abc)' });
		const msg = await adapter.readMessage(id);
		assert.equal(msg.body, 'see ![x](attachment:abc)');
		assert.deepEqual(msg.attachments, []);
		await assert.rejects(stat(join(dir, 'team', 'messages', 'attachments')));
		assert.doesNotMatch(await readFile(join(dir, 'team', 'messages', `${id}.md`), 'utf-8'), /^attachments:/m);
	}));

test('a refused attachment leaves no message, no folder and no inbox entry', () =>
	withDir(async (dir) => {
		const adapter = new FileMessagingAdapter(join(dir, 'team'));
		const good = await writeImage(dir, 'good.png');
		const svg = join(dir, 'x.png');
		await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
		const secret = join(dir, 'secrets.env');
		await writeFile(secret, 'TOKEN=not-an-image-but-long-enough');
		for (const bad of [svg, secret, join(dir, 'missing.png'), dir]) {
			await assert.rejects(
				adapter.sendMessage({ from: 'a', to: ['b'], subject: 's', body: 'x', attachments: [{ path: good }, { path: bad }] }),
				/Attachment|not a/,
			);
		}
		assert.deepEqual(await adapter.listInbox('b'), []);
		await assert.rejects(readdir(join(dir, 'team', 'messages')));
	}));

test('limits: ten per message, 8 MB each, 25 MB together', () =>
	withDir(async (dir) => {
		const adapter = new FileMessagingAdapter(join(dir, 'team'));
		const one = await writeImage(dir, 'one.png');
		await assert.rejects(
			adapter.sendMessage({
				from: 'a',
				to: ['b'],
				subject: 's',
				body: 'x',
				attachments: Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ({ path: one })),
			}),
			/Too many attachments/,
		);
		const big = await writeImage(dir, 'big.png', Buffer.concat([PNG, Buffer.alloc(MAX_ATTACHMENT_BYTES)]));
		await assert.rejects(
			adapter.sendMessage({ from: 'a', to: ['b'], subject: 's', body: 'x', attachments: [{ path: big }] }),
			/limit is 8 MB each/,
		);
		const seven = await writeImage(dir, 'seven.png', Buffer.concat([PNG, Buffer.alloc(7 * 1024 * 1024)]));
		await assert.rejects(
			adapter.sendMessage({
				from: 'a',
				to: ['b'],
				subject: 's',
				body: 'x',
				attachments: [seven, seven, seven, seven].map((path) => ({ path })),
			}),
			/more than 25 MB/,
		);
		const ok = await adapter.sendMessage({
			from: 'a',
			to: ['b'],
			subject: 's',
			body: 'x',
			attachments: [seven, seven, seven].map((path) => ({ path })),
		});
		assert.deepEqual((await readdir(join(dir, 'team', 'messages', 'attachments', ok.id))).sort(), [
			'seven-2.png',
			'seven-3.png',
			'seven.png',
		]);
	}));

test('a leftover placeholder is refused when attachments were passed', () =>
	withDir(async (dir) => {
		const adapter = new FileMessagingAdapter(join(dir, 'team'));
		await assert.rejects(
			adapter.sendMessage({ from: 'a', to: ['b'], subject: 's', body: '![x](attachment:nope)', attachments: [] }),
			/not sent with it/,
		);
		assert.deepEqual(await adapter.listInbox('b'), []);
	}));

test('supersedeMessage carries the new images and keeps the predecessor\'s own list', () =>
	withDir(async (dir) => {
		const adapter = new FileMessagingAdapter(join(dir, 'team'));
		const img = await writeImage(dir, 'v1.png');
		const first = await adapter.sendMessage({ from: 'a', to: ['b'], subject: 's', body: 'v1', attachments: [{ path: img }] });
		const img2 = await writeImage(dir, 'v2.gif', GIF);
		const second = await adapter.supersedeMessage({
			from: 'a',
			supersedes: [first.id],
			to: ['b'],
			body: 'v2',
			attachments: [{ path: img2 }],
		});
		const prev = await adapter.readMessage(first.id);
		assert.equal(prev.supersededBy, second.id);
		assert.deepEqual(prev.attachments, ['v1.png']);
		assert.match(prev.body, new RegExp(`attachments/${first.id}/v1\\.png`));
		const next = await adapter.readMessage(second.id);
		assert.deepEqual(next.attachments, ['v2.gif']);
		assert.deepEqual(await readFile(join(dir, 'team', 'messages', 'attachments', first.id, 'v1.png')), PNG);
	}));

test('AttachmentStore: stage, claim by the same sender, release', () =>
	withDir(async (dir) => {
		const store = new AttachmentStore(join(dir, 'team'));
		const staged = await store.stage({ from: 'kris', name: 'My Photo.JPG', bytes: JPG });
		assert.match(staged.token, /^[a-f0-9]{24}$/);
		assert.equal(staged.name, 'my-photo.jpg');
		assert.equal(staged.mime, 'image/jpeg');

		await assert.rejects(store.claim([staged.token], 'van'), { status: 403 });
		await assert.rejects(store.claim(['../../x'], 'kris'), { status: 400 });
		await assert.rejects(store.claim(['0'.repeat(24)], 'kris'), { status: 400 });
		await assert.rejects(store.claim('nope', 'kris'), { status: 400 });

		const items = await store.claim([staged.token], 'kris');
		assert.equal(items.length, 1);
		assert.equal(items[0].ref, staged.token);
		assert.deepEqual(await readFile(items[0].path), JPG);

		await store.release([staged.token]);
		await assert.rejects(store.claim([staged.token], 'kris'), { status: 400 });
		assert.deepEqual(await readdir(store.stagingDir), []);
	}));

test('AttachmentStore refuses non-images, empty and oversize uploads, and sweeps old ones', () =>
	withDir(async (dir) => {
		const store = new AttachmentStore(join(dir, 'team'), { maxAgeMs: 1000 });
		await assert.rejects(store.stage({ from: 'kris', name: 'a.png', bytes: Buffer.from('<svg/>'.repeat(10)) }), { status: 415 });
		await assert.rejects(store.stage({ from: 'kris', name: 'a.png', bytes: Buffer.alloc(0) }), { status: 400 });
		await assert.rejects(
			store.stage({ from: 'kris', name: 'a.png', bytes: Buffer.concat([PNG, Buffer.alloc(MAX_ATTACHMENT_BYTES)]) }),
			{ status: 413 },
		);
		await assert.rejects(store.stage({ from: '', name: 'a.png', bytes: PNG }), { status: 403 });

		const old = await store.stage({ from: 'kris', name: 'old.png', bytes: PNG });
		const past = new Date(Date.now() - 60_000);
		await utimes(join(store.stagingDir, `${old.token}.bin`), past, past);
		await utimes(join(store.stagingDir, `${old.token}.json`), past, past);
		const fresh = await store.stage({ from: 'kris', name: 'fresh.png', bytes: PNG });
		await assert.rejects(store.claim([old.token], 'kris'), { status: 400 });
		assert.equal((await store.claim([fresh.token], 'kris')).length, 1);
	}));

test('AttachmentStore.read serves only a well-formed image that is really that type', () =>
	withDir(async (dir) => {
		const store = new AttachmentStore(join(dir, 'team'));
		const folder = join(dir, 'team', 'messages', 'attachments', 'M1');
		await mkdir(folder, { recursive: true });
		await writeFile(join(folder, 'a.png'), PNG);
		await writeFile(join(folder, 'liar.png'), JPG);
		await writeFile(join(folder, 'page.png'), '<html><script>alert(1)</script></html>');
		await writeFile(join(dir, 'team', 'messages', 'secret.png'), PNG);
		const hit = await store.read('M1', 'a.png');
		assert.equal(hit.mime, 'image/png');
		assert.deepEqual(hit.bytes, PNG);
		assert.equal(await store.read('M1', 'liar.png'), null);
		assert.equal(await store.read('M1', 'page.png'), null);
		assert.equal(await store.read('M1', 'missing.png'), null);
		assert.equal(await store.read('..', 'secret.png'), null);
		assert.equal(await store.read('M1', '../../secret.png'), null);
		assert.equal(await store.read('M1/..', 'a.png'), null);
		assert.equal(await store.read('M1', 'a.svg'), null);
	}));
