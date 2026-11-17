import { UPLOAD_HOST } from './uploads.mjs';

/**
 * A scripted stand-in for Linear's upload host, for tests (no network, no real key; names and bytes are invented).
 *
 *   const host = fakeUploadHost({ '/ws/a/b': { body: 'bytes', type: 'image/png', name: 'shot.png' } }, { key: KEY });
 *   createUploadClient({ key: KEY, fetchImpl: host.fetchImpl, sleep: async () => {}, paceMs: 0 })
 *
 * A route is `{ status?, body?, type?, name?, disposition?, noLength?, headers?, location?, stream? }` or a function of
 * `(call, count)` returning one; `count` is how many requests that path got. A request to the upload host without the
 * key answers 401, a path with no route 404. `calls` records `{ method, url, auth, host }` for every request.
 */
export function fakeUploadHost(routes, { key, host = UPLOAD_HOST } = {}) {
	const calls = [];
	const seen = new Map();
	const fetchImpl = async (href, init = {}) => {
		const url = new URL(href);
		const method = init.method ?? 'GET';
		const auth = init.headers?.Authorization ?? null;
		const call = { method, url: href, auth, host: url.hostname };
		calls.push(call);
		const path = `${url.pathname}${url.search}`;
		const count = (seen.get(path) ?? 0) + 1;
		seen.set(path, count);
		if (url.hostname === host && auth !== key) return new Response('{"error":"unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } });
		let route = routes[path] ?? routes[url.pathname];
		if (typeof route === 'function') route = route(call, count);
		if (route === undefined) return new Response('{"error":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } });
		if (route instanceof Error) throw route;
		const status = route.status ?? 200;
		const headers = new Headers(route.headers ?? {});
		if (route.location) headers.set('location', route.location);
		if (route.type) headers.set('content-type', route.type);
		const disposition = route.disposition ?? (route.name === undefined ? undefined : `inline; filename="${route.name}"`);
		if (disposition) headers.set('content-disposition', disposition);
		const body = route.body === undefined ? '' : route.body;
		if (status === 200 && !route.noLength) headers.set('content-length', String(route.length ?? Buffer.byteLength(body)));
		if (method === 'HEAD') return new Response(null, { status, headers });
		if (route.stream) return new Response(route.stream(), { status, headers });
		if (status >= 300 && status < 400) return new Response(null, { status, headers });
		return new Response(body, { status, headers });
	};
	return { fetchImpl, calls, methods: () => [...new Set(calls.map((c) => c.method))].sort() };
}

/** A body that sends `first` and then fails, as a dropped connection does. */
export function brokenStream(first) {
	return () => new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(first));
			controller.error(new Error('connection dropped'));
		},
	});
}
