import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { UPLOAD_HOST } from './uploads.mjs';

/**
 * Reads one upload from Linear's upload host, read-only (ticket A6b): a HEAD request for the size and type, a GET that
 * streams the body into a file. Nothing here writes to Linear: the only methods are HEAD and GET.
 *
 * The key is the `Authorization` header of a request to the upload host itself (https, the default port) and nothing
 * else: not in a URL, not in an error text, not in a log. A redirect is followed by hand (at most 3 hops) and only within
 * that same host and port; a redirect anywhere else is refused, so the key and the run never leave the upload host.
 *
 * Answers: `ok`, `gone` (404, 410), `denied` (403) and `failed` (any other status after the retries) are results the
 * caller counts and goes on from; a 401 (the key is wrong or expired) and a network that never answers throw
 * `UploadError` with `fatal: true`, because every later request would fail the same way.
 */

export class UploadError extends Error {
	constructor(code, message, { fatal = false } = {}) {
		super(message);
		this.name = 'UploadError';
		this.code = code;
		this.fatal = fatal;
	}
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * @param {object} options
 * @param {string} options.key  the read-only key (one line, no spaces)
 * @param {typeof fetch} [options.fetchImpl]  for tests
 * @param {(ms: number) => Promise<void>} [options.sleep]  for tests
 * @param {number} [options.paceMs]  pause between requests (300 by default)
 * @param {string} [options.host]  the upload host (tests only)
 */
export function createUploadClient({ key, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), paceMs = 300, host = UPLOAD_HOST, maxRedirects = 3, maxTries = 5, maxWaitMs = 120_000 } = {}) {
	if (typeof key !== 'string' || key.length < 8 || /\s/.test(key)) throw new UploadError('no-key', 'the key is missing or is not one token', { fatal: true });
	let requests = 0;

	const waitFor = (res, tries) => {
		const seconds = Number(res.headers.get('retry-after'));
		const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000 * 2 ** (tries - 1);
		return Math.min(ms, maxWaitMs);
	};
	const drop = async (res) => {
		try {
			await res.body?.cancel();
		} catch {
			// the body is not needed
		}
	};

	/** One request with the retries and redirects; the response of the final answer (a status the caller maps). */
	async function send(method, url) {
		let target = new URL(url);
		if (target.protocol !== 'https:' || target.hostname !== host || target.port !== '' || target.username !== '' || target.password !== '') {
			throw new UploadError('bad-url', 'the link is not an https link on the upload host');
		}
		let hops = 0;
		let tries = 0;
		for (;;) {
			if (requests++ > 0 && paceMs > 0) await sleep(paceMs);
			let res;
			try {
				res = await fetchImpl(target.href, { method, redirect: 'manual', headers: { Authorization: key } });
			} catch {
				tries++;
				if (tries >= maxTries) throw new UploadError('network', 'the upload host did not answer', { fatal: true });
				await sleep(Math.min(1000 * 2 ** (tries - 1), maxWaitMs));
				continue;
			}
			if (REDIRECTS.has(res.status)) {
				const location = res.headers.get('location');
				await drop(res);
				if (!location) throw new UploadError('redirect', 'a redirect without a place to go');
				if (++hops > maxRedirects) throw new UploadError('redirect', 'too many redirects');
				let next;
				try {
					next = new URL(location, target);
				} catch {
					throw new UploadError('redirect', 'a redirect to something that is not a link');
				}
				if (next.protocol !== 'https:' || next.hostname !== host || next.port !== '' || next.username !== '' || next.password !== '') {
					throw new UploadError('redirect', 'a redirect to somewhere other than the upload host');
				}
				target = next;
				continue;
			}
			if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
				tries++;
				if (tries >= maxTries) {
					await drop(res);
					return { res, status: res.status };
				}
				const ms = waitFor(res, tries);
				await drop(res);
				await sleep(ms);
				continue;
			}
			return { res, status: res.status };
		}
	}

	/** Maps the status of an answer to what the caller counts; a 401 stops the run. */
	function classify(status) {
		if (status === 401) throw new UploadError('unauthorized', 'the upload host refused the key (401)', { fatal: true });
		if (status === 404 || status === 410) return 'gone';
		if (status === 403) return 'denied';
		if (status >= 200 && status < 300) return 'ok';
		return 'failed';
	}

	/**
	 * Size and type without the body: `{ result, status, bytes (number or null: no Content-Length), type, disposition }`.
	 * A host that does not answer HEAD (405 or 501) is asked with GET and the body is dropped.
	 */
	async function head(url) {
		let answer = await send('HEAD', url);
		if (answer.status === 405 || answer.status === 501) {
			await drop(answer.res);
			answer = await send('GET', url);
		}
		const { res, status } = answer;
		const result = classify(status);
		const length = res.headers.get('content-length');
		const bytes = length !== null && /^\d+$/.test(length) ? Number(length) : null;
		const info = { result, status, bytes, type: (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(), disposition: res.headers.get('content-disposition') ?? '' };
		await drop(res);
		return info;
	}

	/**
	 * Streams the body to `tmpPath` (created new; removed again unless the whole body arrived), counting bytes and the SHA-256
	 * on the way. `{ result: 'ok', bytes, sha256, type, disposition }`, or `{ result: 'gone' | 'denied' | 'failed', status }`, or
	 * `{ result: 'toobig', bytes }` when the answer announces more than `maxBytes` or grows past it (the run stops).
	 */
	async function download(url, tmpPath, { maxBytes }) {
		const { res, status } = await send('GET', url);
		const result = classify(status);
		if (result !== 'ok') {
			await drop(res);
			return { result, status };
		}
		const length = res.headers.get('content-length');
		const declared = length !== null && /^\d+$/.test(length) ? Number(length) : null;
		if (declared !== null && declared > maxBytes && !res.headers.get('content-encoding')) {
			await drop(res);
			return { result: 'toobig', bytes: declared };
		}
		if (!res.body) return { result: 'failed', status };
		const hash = createHash('sha256');
		let bytes = 0;
		let tooBig = false;
		const counter = new Transform({
			transform(chunk, _encoding, done) {
				bytes += chunk.length;
				if (bytes > maxBytes) {
					tooBig = true;
					done(new UploadError('toobig', 'the body is larger than the cap'));
					return;
				}
				hash.update(chunk);
				done(null, chunk);
			},
		});
		try {
			await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(tmpPath, { flags: 'wx', mode: 0o644 }));
		} catch (err) {
			await unlink(tmpPath).catch(() => {});
			if (tooBig) return { result: 'toobig', bytes };
			if (err?.code === 'EEXIST') throw err;
			return { result: 'failed', status, reason: 'the body stopped early' };
		}
		// A body the client unpacked (Content-Encoding) is not the length the header gives; only a plain body is compared.
		if (declared !== null && !res.headers.get('content-encoding') && declared !== bytes) {
			await unlink(tmpPath).catch(() => {});
			return { result: 'failed', status, reason: 'the body was shorter than announced' };
		}
		return { result: 'ok', status, bytes, sha256: hash.digest('hex'), type: (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(), disposition: res.headers.get('content-disposition') ?? '' };
	}

	return { head, download };
}
