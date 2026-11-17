import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UploadError, createUploadClient, scrub } from './upload-client.mjs';
import { brokenStream, fakeUploadHost } from './fake-uploads.mjs';
import { UPLOAD_HOST } from './uploads.mjs';

/** A scripted upload host and an invented key; no network. */

const KEY = 'lin_api_TESTKEYTESTKEY0123456789';
const URLS = { a: `https://${UPLOAD_HOST}/ws/a/one`, b: `https://${UPLOAD_HOST}/ws/a/two` };

function make(routes, extra = {}) {
	const host = fakeUploadHost(routes, { key: KEY });
	const sleeps = [];
	const client = createUploadClient({ key: KEY, fetchImpl: host.fetchImpl, sleep: async (ms) => void sleeps.push(ms), paceMs: 0, ...extra });
	return { host, client, sleeps };
}
const tmpdirFor = () => mkdtempSync(join(tmpdir(), 'upload-client-'));

test('the key is the Authorization header of a request to the upload host, exactly, with no Bearer and no key in the URL', async () => {
	const { client, host } = make({ '/ws/a/one': { body: 'hello', type: 'image/png', name: 'shot.png' } });
	const info = await client.head(URLS.a);
	assert.deepEqual(info, { result: 'ok', status: 200, bytes: 5, type: 'image/png', disposition: 'inline; filename="shot.png"' });
	assert.equal(host.calls[0].auth, KEY);
	for (const c of host.calls) assert.equal(c.url.includes('lin_api'), false);
});

test('a HEAD answer with no Content-Length says the size is unknown', async () => {
	const { client } = make({ '/ws/a/one': { body: 'hello', type: 'image/png', noLength: true } });
	assert.equal((await client.head(URLS.a)).bytes, null);
});

test('404 and 410 are gone, 403 is denied, other statuses are failed; none of them stops the run', async () => {
	const { client } = make({ '/ws/a/one': { status: 404 }, '/ws/a/two': { status: 403 }, '/ws/a/three': { status: 410 }, '/ws/a/four': { status: 418 } });
	assert.equal((await client.head(URLS.a)).result, 'gone');
	assert.equal((await client.head(URLS.b)).result, 'denied');
	assert.equal((await client.head(`https://${UPLOAD_HOST}/ws/a/three`)).result, 'gone');
	assert.equal((await client.head(`https://${UPLOAD_HOST}/ws/a/four`)).result, 'failed');
});

test('a 401 stops the run with a fatal error whose text has no key in it', async () => {
	const wrong = fakeUploadHost({ '/ws/a/one': { body: 'x' } }, { key: 'lin_api_SOMEOTHERKEY123456789' });
	const client = createUploadClient({ key: KEY, fetchImpl: wrong.fetchImpl, sleep: async () => {}, paceMs: 0 });
	for (const call of [() => client.head(URLS.a), () => client.download(URLS.a, join(tmpdir(), 'never-written'), { maxBytes: 100 })]) {
		await assert.rejects(call, (err) => err instanceof UploadError && err.fatal === true && err.code === 'unauthorized' && !err.message.includes(KEY) && !String(err.stack).includes(KEY));
	}
	assert.equal(existsSync(join(tmpdir(), 'never-written')), false);
});

test('a key that is empty, short or has a space in it is refused before any request', () => {
	for (const key of ['', 'short', 'two words in a key', undefined, null, 5]) assert.throws(() => createUploadClient({ key }), (err) => err instanceof UploadError && err.fatal);
});

test('a link that is not an https link on the upload host is never requested', async () => {
	const { client, host } = make({});
	for (const url of ['http://uploads.linear.app/ws/a/one', 'https://example.invalid/ws/a/one', `https://user:pw@${UPLOAD_HOST}/ws/a/one`, `https://${UPLOAD_HOST}:444/ws/a/one`]) {
		await assert.rejects(() => client.head(url), (err) => err instanceof UploadError && err.code === 'bad-url');
	}
	assert.equal(host.calls.length, 0);
});

test('only HEAD and GET are ever sent', async () => {
	const dir = tmpdirFor();
	try {
		const { client, host } = make({ '/ws/a/one': { body: 'hello', type: 'image/png' } });
		await client.head(URLS.a);
		await client.download(URLS.a, join(dir, 't.tmp'), { maxBytes: 100 });
		assert.deepEqual(host.methods(), ['GET', 'HEAD']);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a host that does not answer HEAD is asked with GET and the body is dropped', async () => {
	const { client, host } = make({ '/ws/a/one': (call) => (call.method === 'HEAD' ? { status: 405 } : { body: 'hello', type: 'image/png' }) });
	const info = await client.head(URLS.a);
	assert.equal(info.result, 'ok');
	assert.equal(info.bytes, 5);
	assert.deepEqual(host.calls.map((c) => c.method), ['HEAD', 'GET']);
});

test('429 waits for Retry-After and tries again; a 503 waits with a growing pause; both end in an answer after the tries', async () => {
	const { client, sleeps } = make({
		'/ws/a/one': (call, n) => (n === 1 ? { status: 429, headers: { 'retry-after': '7' } } : { body: 'x', type: 'text/plain' }),
		'/ws/a/two': (call, n) => (n < 3 ? { status: 503 } : { body: 'x', type: 'text/plain' }),
		'/ws/a/three': { status: 503 },
	});
	assert.equal((await client.head(URLS.a)).result, 'ok');
	assert.deepEqual(sleeps, [7000]);
	sleeps.length = 0;
	assert.equal((await client.head(URLS.b)).result, 'ok');
	assert.deepEqual(sleeps, [1000, 2000]);
	sleeps.length = 0;
	assert.equal((await client.head(`https://${UPLOAD_HOST}/ws/a/three`)).result, 'failed', 'five tries, then the answer is a failure, not a hang');
	assert.equal(sleeps.length, 4);
});

test('a pause longer than the cap is cut to the cap', async () => {
	const { client, sleeps } = make({ '/ws/a/one': (call, n) => (n === 1 ? { status: 429, headers: { 'retry-after': '99999' } } : { body: 'x' }) }, { maxWaitMs: 5000 });
	await client.head(URLS.a);
	assert.deepEqual(sleeps, [5000]);
});

test('a network that never answers ends the run (fatal), after the tries, with no detail in the text', async () => {
	const { client, sleeps } = make({ '/ws/a/one': new Error(`connect ECONNREFUSED ${KEY}`) });
	await assert.rejects(() => client.head(URLS.a), (err) => err instanceof UploadError && err.fatal && err.code === 'network' && !err.message.includes(KEY));
	assert.equal(sleeps.length, 4);
});

test('requests are paced', async () => {
	const { host } = make({ '/ws/a/one': { body: 'x' } });
	const sleeps = [];
	const client = createUploadClient({ key: KEY, fetchImpl: host.fetchImpl, sleep: async (ms) => void sleeps.push(ms), paceMs: 300 });
	await client.head(URLS.a);
	await client.head(URLS.a);
	await client.head(URLS.a);
	assert.deepEqual(sleeps, [300, 300], 'none before the first request, one before each later one');
});

test('a redirect on the upload host is followed with the key; to another host without it; to an address, an http link or too far, never', async () => {
	const other = 'https://files.example.invalid/signed/xyz';
	const { client, host } = make({
		'/ws/a/one': { status: 302, location: `https://${UPLOAD_HOST}/ws/a/moved` },
		'/ws/a/moved': { body: 'moved', type: 'text/plain' },
		'/ws/a/two': { status: 302, location: other },
		'/signed/xyz': { body: 'signed', type: 'text/plain', noLength: true },
		'/ws/a/ip': { status: 302, location: 'https://127.0.0.1/x' },
		'/ws/a/local': { status: 302, location: 'https://localhost/x' },
		'/ws/a/plain': { status: 302, location: 'http://files.example.invalid/x' },
		'/ws/a/loop': { status: 302, location: `https://${UPLOAD_HOST}/ws/a/loop` },
		'/ws/a/none': { status: 302 },
	});
	assert.equal((await client.head(URLS.a)).bytes, 5);
	assert.equal(host.calls.at(-1).auth, KEY);
	const before = host.calls.length;
	assert.equal((await client.head(URLS.b)).result, 'ok');
	const hops = host.calls.slice(before);
	assert.equal(hops[0].auth, KEY);
	assert.equal(hops[1].host, 'files.example.invalid');
	assert.equal(hops[1].auth, null, 'the key does not go to another host');
	for (const path of ['ip', 'local', 'plain', 'loop', 'none']) {
		const calls = host.calls.length;
		await assert.rejects(() => client.head(`https://${UPLOAD_HOST}/ws/a/${path}`), (err) => err instanceof UploadError && err.code === 'redirect', path);
		if (path === 'loop') assert.equal(host.calls.length - calls, 4, 'the first request and three redirects, then it gives up');
	}
});

test('download writes the body to the file and returns its size, SHA-256, type and Content-Disposition', async () => {
	const dir = tmpdirFor();
	try {
		const body = 'invented bytes '.repeat(1000);
		const { client } = make({ '/ws/a/one': { body, type: 'image/png; charset=x', name: 'shot.png' } });
		const out = await client.download(URLS.a, join(dir, 't.tmp'), { maxBytes: 1_000_000 });
		assert.deepEqual(out, { result: 'ok', status: 200, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex'), type: 'image/png', disposition: 'inline; filename="shot.png"' });
		assert.equal(readFileSync(join(dir, 't.tmp'), 'utf8'), body);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('download: a missing, forbidden or failing upload leaves no file', async () => {
	const dir = tmpdirFor();
	try {
		const { client } = make({ '/ws/a/one': { status: 404 }, '/ws/a/two': { status: 403 } });
		assert.deepEqual(await client.download(URLS.a, join(dir, 'a.tmp'), { maxBytes: 100 }), { result: 'gone', status: 404 });
		assert.deepEqual(await client.download(URLS.b, join(dir, 'b.tmp'), { maxBytes: 100 }), { result: 'denied', status: 403 });
		assert.deepEqual(readdirSync(dir), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('download: a size over the cap, announced or found while streaming, is toobig and leaves no file', async () => {
	const dir = tmpdirFor();
	try {
		const { client } = make({
			'/ws/a/one': { body: 'x'.repeat(500), type: 'image/png' },
			'/ws/a/two': { body: 'x'.repeat(500), type: 'image/png', noLength: true },
		});
		assert.deepEqual(await client.download(URLS.a, join(dir, 'a.tmp'), { maxBytes: 100 }), { result: 'toobig', bytes: 500 });
		const grown = await client.download(URLS.b, join(dir, 'b.tmp'), { maxBytes: 100 });
		assert.equal(grown.result, 'toobig');
		assert.ok(grown.bytes > 100);
		assert.deepEqual(readdirSync(dir), []);
		assert.equal((await client.download(URLS.a, join(dir, 'c.tmp'), { maxBytes: 500 })).result, 'ok', 'a body exactly at the cap is fine');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('download: an announced size over the cap is refused without reading the body', async () => {
	const dir = tmpdirFor();
	try {
		const { client } = make({ '/ws/a/one': { stream: brokenStream('x'), type: 'image/png', length: 500 } });
		assert.deepEqual(await client.download(URLS.a, join(dir, 'a.tmp'), { maxBytes: 100 }), { result: 'toobig', bytes: 500 }, 'a body that was read would have been a dropped connection');
		assert.deepEqual(readdirSync(dir), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('download: a body that stops early or is shorter than announced is a failure and leaves no file', async () => {
	const dir = tmpdirFor();
	try {
		const { client } = make({
			'/ws/a/one': { stream: brokenStream('part'), type: 'image/png', length: 50 },
			'/ws/a/two': { body: 'short', type: 'image/png', length: 50 },
		});
		assert.equal((await client.download(URLS.a, join(dir, 'a.tmp'), { maxBytes: 1000 })).result, 'failed');
		assert.equal((await client.download(URLS.b, join(dir, 'b.tmp'), { maxBytes: 1000 })).result, 'failed');
		assert.deepEqual(readdirSync(dir), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('scrub removes the key and anything shaped like a Linear key from a text', () => {
	assert.equal(scrub(`error with ${KEY} inside`, KEY), 'error with [key] inside');
	assert.equal(scrub('other lin_api_ABCDEFGH12345678 and lin_oauth_ZZZZ1111', KEY), 'other [key] and [key]');
	assert.equal(scrub('no key here', KEY), 'no key here');
});
