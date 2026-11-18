/**
 * A read-only Linear GraphQL client.
 *
 * - Sends only documents from `documents.mjs`, chosen by NAME. Nothing else can be sent: a name that is
 *   not on the list (including `__proto__`, `constructor`) is refused before any request, and so is a
 *   variable the document does not declare.
 * - The key comes from the environment only (`LINEAR_API_KEY_RO` first, then `LINEAR_API_KEY`: the same order
 *   as the wrapper `scripts/linear-api.sh`). There is no option, argument or file that carries it. It is sent
 *   as the `Authorization` header (no `Bearer`) and appears in no error message, event or log line: text
 *   that comes back from Linear is scrubbed of it, and of anything shaped like a Linear key, before it is
 *   used in a message.
 * - 429 (and Linear's `RATELIMITED` GraphQL error) pauses for `Retry-After` (or until the request limit
 *   resets) and retries; 5xx and network errors retry a few times with a growing pause; 401 and 403 stop.
 * - Two budgets stop the run with a clear message before the next request: fewer than 200 requests left in
 *   the hour, or less than 10 percent of the complexity budget left (3,000,000 an hour, shared by every key
 *   on the account). Nothing is written by a stopped run (the caller writes the export at the end).
 */

import { DOCUMENTS } from './documents.mjs';

export const LINEAR_URL = 'https://api.linear.app/graphql';
const KEY_SHAPE = /lin_(?:api|oauth)_[A-Za-z0-9]+/g;

/** Error with a stable `code`; the message never contains the key or a record value. */
export class FetchError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'FetchError';
		this.code = code;
	}
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function headerNumber(headers, name) {
	const raw = headers?.get?.(name);
	if (raw === null || raw === undefined || raw === '') return null;
	const n = Number(raw);
	return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env]   where the key is read (default `process.env`)
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.now]
 * @param {string} [options.url]                            for tests; the CLI never sets it
 * @param {number} [options.paceMs]                         pause between requests (default 300)
 * @param {number} [options.minRequestsLeft]                stop below this many requests left (default 200)
 * @param {number} [options.minComplexityFraction]          stop below this share of the complexity budget (default 0.1)
 * @param {number} [options.maxRetries]                     rate-limit and server-error retries per request (default 5)
 * @param {number} [options.maxWaitMs]                      longest single pause we accept (default 10 minutes)
 * @param {(event: object) => void} [options.onEvent]       `{ name, status, requestsRemaining, complexityRemaining, waitedMs? }`
 */
export function createClient(options = {}) {
	const env = options.env ?? process.env;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? Date.now;
	const url = options.url ?? LINEAR_URL;
	const paceMs = options.paceMs ?? 300;
	const minRequestsLeft = options.minRequestsLeft ?? 200;
	const minComplexityFraction = options.minComplexityFraction ?? 0.1;
	const maxRetries = options.maxRetries ?? 5;
	const maxWaitMs = options.maxWaitMs ?? 10 * 60 * 1000;
	const onEvent = options.onEvent ?? (() => {});

	const key = env.LINEAR_API_KEY_RO || env.LINEAR_API_KEY || '';
	if (key === '') throw new FetchError('no-key', 'LINEAR_API_KEY is not set in this environment');
	if (typeof fetchImpl !== 'function') throw new FetchError('no-fetch', 'no fetch implementation is available');

	const state = { requests: 0, requestsRemaining: null, complexityRemaining: null, complexityLimit: null, lastSentAt: 0 };

	/** Remove the key and anything shaped like one, and cap the length, before text enters a message. */
	function scrub(text) {
		let out = String(text ?? '').split(key).join('[key]').replace(KEY_SHAPE, '[key]');
		out = out.replace(/\s+/g, ' ').trim();
		return out.length > 200 ? `${out.slice(0, 200)}...` : out;
	}

	function checkBudget() {
		if (state.requestsRemaining !== null && state.requestsRemaining < minRequestsLeft) {
			throw new FetchError('budget', `stopping: only ${state.requestsRemaining} Linear requests left this hour (limit for a run: keep ${minRequestsLeft}); nothing was written; try again after the hour resets`);
		}
		if (state.complexityRemaining !== null && state.complexityLimit !== null && state.complexityRemaining < state.complexityLimit * minComplexityFraction) {
			throw new FetchError('budget', `stopping: only ${state.complexityRemaining} of ${state.complexityLimit} Linear complexity points are left this hour; nothing was written; try again after the hour resets`);
		}
	}

	function readHeaders(headers) {
		const requests = headerNumber(headers, 'x-ratelimit-requests-remaining');
		const complexity = headerNumber(headers, 'x-ratelimit-complexity-remaining');
		const limit = headerNumber(headers, 'x-ratelimit-complexity-limit');
		if (requests !== null) state.requestsRemaining = requests;
		if (complexity !== null) state.complexityRemaining = complexity;
		if (limit !== null) state.complexityLimit = limit;
		else if (complexity !== null && state.complexityLimit === null) state.complexityLimit = 3_000_000;
	}

	/** Milliseconds to wait after a rate-limit answer. */
	function waitFor(headers) {
		const retryAfter = headerNumber(headers, 'retry-after');
		if (retryAfter !== null) return Math.max(0, retryAfter) * 1000;
		const reset = headerNumber(headers, 'x-ratelimit-requests-reset');
		if (reset !== null) {
			// An epoch time, in milliseconds or in seconds (the unit is not stated where we read it): take the
			// reading that puts the reset inside the hour window around now. Neither: the default pause below.
			const inWindow = (w) => w >= -3_600_000 && w <= 7_200_000;
			const asMs = reset - now();
			const asSeconds = reset * 1000 - now();
			if (inWindow(asMs)) return Math.max(1000, asMs);
			if (inWindow(asSeconds)) return Math.max(1000, asSeconds);
		}
		return 60_000;
	}

	async function run(name, variables = {}) {
		if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(DOCUMENTS, name)) {
			throw new FetchError('document-not-allowed', `"${String(name).slice(0, 40)}" is not on the list of documents this client may send`);
		}
		const spec = DOCUMENTS[name];
		if (variables === null || typeof variables !== 'object' || Array.isArray(variables)) throw new FetchError('bad-variables', `${name}: variables must be an object`);
		for (const [k, v] of Object.entries(variables)) {
			if (!spec.variables.includes(k)) throw new FetchError('bad-variables', `${name}: the document has no variable "${k.slice(0, 40)}"`);
			if (v !== null && typeof v !== 'string') throw new FetchError('bad-variables', `${name}: variable "${k}" must be a string or null`);
		}
		const body = JSON.stringify({ query: spec.doc, variables });

		let attempts = 0;
		for (;;) {
			checkBudget();
			const sinceLast = now() - state.lastSentAt;
			if (state.lastSentAt > 0 && sinceLast < paceMs) await sleep(paceMs - sinceLast);
			state.lastSentAt = now();
			state.requests++;

			let res;
			try {
				res = await fetchImpl(url, {
					method: 'POST',
					headers: { Authorization: key, 'Content-Type': 'application/json' },
					body,
					signal: AbortSignal.timeout(60_000),
				});
			} catch (err) {
				if (++attempts > maxRetries) throw new FetchError('network', `${name}: the request failed after ${attempts} tries (${scrub(err?.name ?? 'error')})`);
				const wait = Math.min(maxWaitMs, 1000 * 2 ** attempts);
				onEvent({ name, status: 0, waitedMs: wait, requestsRemaining: state.requestsRemaining, complexityRemaining: state.complexityRemaining });
				await sleep(wait);
				continue;
			}
			readHeaders(res.headers);
			onEvent({ name, status: res.status, requestsRemaining: state.requestsRemaining, complexityRemaining: state.complexityRemaining });

			if (res.status === 401 || res.status === 403) {
				throw new FetchError('auth', `${name}: Linear refused the key (HTTP ${res.status}); it may be revoked or lack read access`);
			}
			let text = '';
			let unreadable = null;
			try {
				text = await res.text();
			} catch (err) {
				unreadable = err;
			}
			// A body that cannot be read (the connection dropped part-way, the timeout fired) is a network failure and
			// gets the same bounded retry. Rate-limit and server-error answers are judged by their status and headers,
			// which do not need the body, so they keep their own handling below.
			if (unreadable && res.status !== 429 && res.status < 500) {
				if (++attempts > maxRetries) throw new FetchError('network', `${name}: the answer (HTTP ${res.status}) could not be read after ${attempts} tries (${scrub(unreadable?.name ?? 'error')})`);
				const wait = Math.min(maxWaitMs, 1000 * 2 ** attempts);
				onEvent({ name, status: 0, waitedMs: wait, requestsRemaining: state.requestsRemaining, complexityRemaining: state.complexityRemaining });
				await sleep(wait);
				continue;
			}
			let payload = null;
			try {
				payload = text ? JSON.parse(text) : null;
			} catch {
				payload = null; // malformed JSON is an answer, not a network failure: it ends as `bad-response` below
			}
			const rateLimited = res.status === 429 || (payload?.errors ?? []).some((e) => e?.extensions?.code === 'RATELIMITED');
			if (rateLimited) {
				if (++attempts > maxRetries) throw new FetchError('rate-limited', `${name}: still rate limited after ${attempts} tries`);
				const wait = waitFor(res.headers);
				if (wait > maxWaitMs) throw new FetchError('rate-limited', `${name}: Linear asks for a pause of ${Math.round(wait / 1000)} s, longer than this run waits (${Math.round(maxWaitMs / 1000)} s); nothing was written; try again later`);
				onEvent({ name, status: res.status, waitedMs: wait, requestsRemaining: state.requestsRemaining, complexityRemaining: state.complexityRemaining });
				await sleep(wait);
				// The counts that came with the 429 describe the window we just waited out; the answer to the retry
				// brings fresh ones. Checked against the old ones, the retry would stop on a budget it no longer has.
				state.requestsRemaining = null;
				state.complexityRemaining = null;
				continue;
			}
			if (res.status >= 500) {
				if (++attempts > maxRetries) throw new FetchError('http', `${name}: Linear answered HTTP ${res.status} ${attempts} times`);
				const wait = Math.min(maxWaitMs, 1000 * 2 ** attempts);
				onEvent({ name, status: res.status, waitedMs: wait, requestsRemaining: state.requestsRemaining, complexityRemaining: state.complexityRemaining });
				await sleep(wait);
				continue;
			}
			if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
				throw new FetchError('graphql', `${name}: Linear reported an error (HTTP ${res.status}): ${scrub(payload.errors[0]?.message)}`);
			}
			if (res.status !== 200) throw new FetchError('http', `${name}: Linear answered HTTP ${res.status}`);
			if (payload === null || typeof payload !== 'object') throw new FetchError('bad-response', `${name}: the answer is not JSON`);
			if (payload.data === null || typeof payload.data !== 'object') throw new FetchError('bad-response', `${name}: the answer has no data`);
			return payload.data;
		}
	}

	return {
		run,
		get requests() { return state.requests; },
		get requestsRemaining() { return state.requestsRemaining; },
		get complexityRemaining() { return state.complexityRemaining; },
		scrub,
	};
}
