import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOCUMENTS } from './documents.mjs';
import { FetchError, LINEAR_URL, createClient } from './client.mjs';
import { inventedWorkspace, makeFakeLinear } from './fake-linear.mjs';

const KEY = 'lin_api_TESTKEYinvented0123456789';
const env = { LINEAR_API_KEY: KEY };

function setup(fakeOpts = {}, clientOpts = {}) {
	const fake = makeFakeLinear(inventedWorkspace(), fakeOpts);
	const sleeps = [];
	let clock = 1_000_000;
	const events = [];
	const client = createClient({
		env, fetchImpl: fake.fetchImpl, paceMs: 0, sleep: async (ms) => { sleeps.push(ms); clock += ms; }, now: () => clock, onEvent: (e) => events.push(e), ...clientOpts,
	});
	return { fake, client, sleeps, events, tick: (ms) => { clock += ms; } };
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const code = (c) => (e) => e instanceof FetchError && e.code === c;

test('no key in the environment is an error that names the variable, not a value', () => {
	assert.throws(() => createClient({ env: {} }), (e) => e.code === 'no-key' && /LINEAR_API_KEY/.test(e.message));
	assert.throws(() => createClient({ env: { LINEAR_API_KEY: '' } }), code('no-key'));
	assert.doesNotThrow(() => createClient({ env: { LINEAR_API_KEY_RO: KEY }, fetchImpl: async () => json(200, {}) }));
});

test('there is no way to hand the key in as an argument', () => {
	const fake = makeFakeLinear(inventedWorkspace());
	assert.throws(() => createClient({ env: {}, apiKey: KEY, key: KEY, fetchImpl: fake.fetchImpl }), code('no-key'));
});

test('only names from the list can be sent, and only declared variables', async () => {
	const { client, fake } = setup();
	for (const name of ['nope', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '', undefined, null, 42, 'Teams', 'mutation { x }']) {
		await assert.rejects(client.run(name), code('document-not-allowed'), String(name));
	}
	await assert.rejects(client.run('teams', { first: 'x' }), code('bad-variables'));
	await assert.rejects(client.run('teams', { after: 5 }), code('bad-variables'));
	await assert.rejects(client.run('teams', { after: ['a'] }), code('bad-variables'));
	await assert.rejects(client.run('teams', null), code('bad-variables'));
	await assert.rejects(client.run('teams', []), code('bad-variables'));
	assert.equal(fake.requests.length, 0, 'nothing was sent');
	await client.run('teams', { after: null });
	assert.equal(fake.requests.length, 1);
});

test('a request is a POST of a listed document with the key as the whole Authorization header', async () => {
	const { client, fake } = setup();
	await client.run('issues', { after: null, team: 't-1' });
	const r = fake.requests[0];
	assert.equal(r.method, 'POST');
	assert.equal(r.url, LINEAR_URL);
	assert.equal(r.authorization, KEY, 'no Bearer');
	assert.equal(r.query, DOCUMENTS.issues.doc);
	assert.deepEqual(r.variables, { after: null, team: 't-1' });
});

test('the key never appears in an error: refused, echoed by Linear, or inside a network error', async () => {
	const messages = [];
	const attempt = async (fetchImpl, opts = {}) => {
		const client = createClient({ env, fetchImpl, paceMs: 0, sleep: async () => {}, maxRetries: 1, ...opts });
		try { await client.run('teams'); } catch (e) { messages.push(e.message); }
	};
	await attempt(async () => json(401, { errors: [{ message: `bad ${KEY}` }] }));
	await attempt(async () => json(403, {}));
	await attempt(async () => json(400, { errors: [{ message: `Variable x with ${KEY} and lin_api_OTHERKEY99 is wrong` }] }));
	await attempt(async () => { throw new Error(`connect failed for ${KEY}`); });
	await attempt(async () => json(500, { errors: [{ message: KEY }] }));
	await attempt(async () => json(200, { errors: [{ message: `x ${KEY.split('').join(' ')}` }] }));
	assert.equal(messages.length, 6);
	for (const m of messages) {
		assert.ok(!m.includes(KEY), m);
		assert.ok(!/lin_api_[A-Za-z0-9]/.test(m), m);
	}
	assert.match(messages[0], /refused the key \(HTTP 401\)/);
	assert.match(messages[2], /\[key\]/);
});

test('a 429 pauses for Retry-After and resumes', async () => {
	let n = 0;
	const { client, sleeps, events } = setup({ hook: () => (++n === 1 ? json(429, { errors: [{ message: 'slow down' }] }, { 'Retry-After': '7' }) : undefined) });
	const data = await client.run('teams');
	assert.equal(data.teams.nodes.length, 2);
	assert.deepEqual(sleeps, [7000]);
	assert.equal(events.find((e) => e.waitedMs).waitedMs, 7000);
});

test('Linear\'s RATELIMITED error (HTTP 400) waits until the request limit resets', async () => {
	let n = 0;
	const { client, sleeps } = setup({ hook: () => (++n === 1 ? json(400, { errors: [{ message: 'rate', extensions: { code: 'RATELIMITED' } }] }, { 'X-RateLimit-Requests-Reset': String(1_000_000 + 12_000) }) : undefined) });
	await client.run('teams');
	assert.deepEqual(sleeps, [12000]);
});

test('a pause longer than the run accepts, or endless limiting, ends the run without sleeping that long', async () => {
	const limited = () => json(429, { errors: [{ message: 'x' }] }, { 'Retry-After': '4000' });
	const a = setup({ hook: limited });
	await assert.rejects(a.client.run('teams'), (e) => e.code === 'rate-limited' && /nothing was written/.test(e.message));
	assert.deepEqual(a.sleeps, []);
	const b = setup({ hook: () => json(429, {}, { 'Retry-After': '1' }) }, { maxRetries: 3 });
	await assert.rejects(b.client.run('teams'), code('rate-limited'));
	assert.equal(b.fake.requests.length, 4, 'one try and three retries');
});

test('a server error is retried with a growing pause, then reported', async () => {
	let n = 0;
	const a = setup({ hook: () => (++n <= 2 ? json(503, {}) : undefined) });
	await a.client.run('teams');
	assert.deepEqual(a.sleeps, [2000, 4000]);
	const b = setup({ hook: () => json(502, {}) }, { maxRetries: 2 });
	await assert.rejects(b.client.run('teams'), (e) => e.code === 'http' && /502/.test(e.message));
});

test('a network error is retried, then reported without detail that could hold a key', async () => {
	let n = 0;
	const sleeps = [];
	const client = createClient({ env, paceMs: 0, sleep: async (ms) => sleeps.push(ms), fetchImpl: async () => { if (++n < 3) throw new TypeError('fetch failed'); return json(200, { data: { teams: { pageInfo: { hasNextPage: false }, nodes: [] } } }); } });
	await client.run('teams');
	assert.deepEqual(sleeps, [2000, 4000]);
});

test('fewer than 200 requests left ends the run before the next request is sent', async () => {
	const { client, fake } = setup({ headers: (n) => ({ 'X-RateLimit-Requests-Remaining': String(n === 1 ? 250 : 150) }) });
	await client.run('teams');
	assert.equal(client.requestsRemaining, 250);
	await client.run('teams');
	await assert.rejects(client.run('teams'), (e) => e.code === 'budget' && /only 150/.test(e.message) && /nothing was written/.test(e.message));
	assert.equal(fake.requests.length, 2, 'the third request was never sent');
});

test('under 10 percent of the complexity budget left ends the run', async () => {
	const { client, fake } = setup({ headers: () => ({ 'X-RateLimit-Complexity-Remaining': '290000', 'X-RateLimit-Complexity-Limit': '3000000' }) });
	await client.run('teams');
	await assert.rejects(client.run('teams'), (e) => e.code === 'budget' && /complexity/.test(e.message));
	assert.equal(fake.requests.length, 1);
	const ok = setup({ headers: () => ({ 'X-RateLimit-Complexity-Remaining': '310000', 'X-RateLimit-Complexity-Limit': '3000000' }) });
	await ok.client.run('teams');
	await ok.client.run('teams');
	assert.equal(ok.fake.requests.length, 2);
});

test('without limit headers the complexity limit is assumed to be the documented 3,000,000', async () => {
	const { client } = setup({ headers: () => ({ 'X-RateLimit-Complexity-Remaining': '100' }) });
	await client.run('teams');
	await assert.rejects(client.run('teams'), code('budget'));
});

test('requests are paced', async () => {
	const { client, sleeps, tick } = setup({}, { paceMs: 300 });
	await client.run('teams');
	await client.run('teams');
	assert.deepEqual(sleeps, [300]);
	tick(1000);
	await client.run('teams');
	assert.deepEqual(sleeps, [300], 'no pause when enough time has passed');
});

test('a GraphQL error is reported with its HTTP status, without data', async () => {
	const { client } = setup({ hook: () => json(400, { errors: [{ message: 'Query too complex' }] }) });
	await assert.rejects(client.run('projects'), (e) => e.code === 'graphql' && /HTTP 400/.test(e.message) && /Query too complex/.test(e.message));
});

test('answers that are not what Linear sends are errors, not empty results', async () => {
	for (const response of [new Response('<html>', { status: 200 }), json(200, null), json(200, {}), json(200, { data: null })]) {
		const { client } = setup({ hook: () => response.clone() });
		await assert.rejects(client.run('teams'), code('bad-response'));
	}
	const { client } = setup({ hook: () => json(404, {}) });
	await assert.rejects(client.run('teams'), code('http'));
});

// ---- the independent review of 2026-11-16 ----

test('a 429 that reports no requests left is retried after the pause, not stopped on its own stale count', async () => {
	let n = 0;
	const { client, sleeps, fake } = setup({ hook: () => (++n === 1 ? json(429, { errors: [{ message: 'x' }] }, { 'Retry-After': '7', 'X-RateLimit-Requests-Remaining': '0', 'X-RateLimit-Complexity-Remaining': '0', 'X-RateLimit-Complexity-Limit': '3000000' }) : undefined) });
	const data = await client.run('teams');
	assert.ok(data.teams, 'the retry went through');
	assert.deepEqual(sleeps, [7000]);
	assert.equal(fake.requests.length, 2);
	assert.equal(client.requests, 2, 'every send is counted, the retry too');
});

test('a budget that the retry itself reports is still enforced', async () => {
	let n = 0;
	const { client } = setup({ hook: () => (++n === 1 ? json(429, {}, { 'Retry-After': '1' }) : undefined), headers: (k) => (k >= 2 ? { 'X-RateLimit-Requests-Remaining': '5' } : {}) });
	await client.run('teams');
	await assert.rejects(client.run('teams'), code('budget'));
});

test('the request-limit reset time is read as milliseconds or as seconds, whichever lands inside the hour', async () => {
	const NOW = 1_800_000_000_000; // a real epoch time in ms: the two readings cannot be confused
	const waits = async (reset) => {
		let n = 0;
		const { client, sleeps } = setup({ hook: () => (++n === 1 ? json(429, {}, { 'X-RateLimit-Requests-Reset': String(reset) }) : undefined) }, { now: () => NOW });
		await client.run('teams');
		return sleeps;
	};
	assert.deepEqual(await waits(NOW + 12_000), [12_000], 'milliseconds');
	assert.deepEqual(await waits((NOW + 12_000) / 1000), [12_000], 'seconds');
	assert.deepEqual(await waits(NOW * 1000), [60_000], 'a value that fits neither reading gets the default pause');
});

test('the read-only key is preferred over the general one, as the wrapper does', async () => {
	const fake = makeFakeLinear(inventedWorkspace());
	const client = createClient({ env: { LINEAR_API_KEY: 'general-key-aaa', LINEAR_API_KEY_RO: 'read-only-key-bbb' }, fetchImpl: fake.fetchImpl, paceMs: 0 });
	await client.run('teams');
	assert.equal(fake.requests[0].authorization, 'read-only-key-bbb');
});

test('a key that does not look like a Linear key is still scrubbed from what Linear echoes back', async () => {
	const odd = 'plain-secret-0123456789abcdef';
	const fake = makeFakeLinear(inventedWorkspace(), { hook: () => json(200, { errors: [{ message: `bad input ${odd} in header` }] }) });
	const client = createClient({ env: { LINEAR_API_KEY: odd }, fetchImpl: fake.fetchImpl, paceMs: 0 });
	await assert.rejects(client.run('teams'), (e) => e.code === 'graphql' && !e.message.includes(odd) && /\[key\]/.test(e.message));
});

test('401 and 403 stop at once with no retry', async () => {
	for (const status of [401, 403]) {
		const { client, fake, sleeps } = setup({ hook: () => json(status, {}) });
		await assert.rejects(client.run('teams'), code('auth'));
		assert.equal(fake.requests.length, 1, String(status));
		assert.deepEqual(sleeps, []);
	}
});

test('every request carries an abort signal, so a hung connection ends', async () => {
	const { client, fake } = setup();
	await client.run('teams');
	assert.equal(fake.requests[0].hasSignal, true);
});
