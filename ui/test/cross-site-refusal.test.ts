import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IncomingMessage } from 'node:http';
import { crossSiteRefusal } from '../src/server/api-plugin.js';

const request = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;
const sameOrigin = { origin: 'http://dash:5173', host: 'dash:5173', 'sec-fetch-site': 'same-origin' };

test('a same-origin JSON write passes; a JSON body is required on other routes', () => {
	assert.equal(crossSiteRefusal(request({ ...sameOrigin, 'content-type': 'application/json', 'content-length': '20' }), 'POST', '/api/messages'), null);
	assert.match(crossSiteRefusal(request({ ...sameOrigin, 'content-type': 'text/plain', 'content-length': '20' }), 'POST', '/api/messages') ?? '', /application\/json/);
	assert.match(crossSiteRefusal(request({ ...sameOrigin, 'content-type': 'application/octet-stream', 'content-length': '20' }), 'POST', '/api/messages') ?? '', /application\/json/);
});

test('the dashboard\'s own raw picture upload is not refused for being raw', () => {
	// ui/src/lib/api.ts uploadAttachment: POST /api/attachments, Content-Type application/octet-stream, same-origin.
	const upload = request({ ...sameOrigin, 'content-type': 'application/octet-stream', 'content-length': '5000' });
	assert.equal(crossSiteRefusal(upload, 'POST', '/api/attachments'), null);
	// A curl-style upload with the picture's own type (no browser headers) works too.
	assert.equal(crossSiteRefusal(request({ 'content-type': 'image/png', 'content-length': '5000' }), 'POST', '/api/attachments'), null);
});

test('the raw upload route still refuses a cross-site or cross-origin page', () => {
	const raw = { 'content-type': 'application/octet-stream', 'content-length': '5000' };
	assert.match(crossSiteRefusal(request({ ...raw, 'sec-fetch-site': 'cross-site' }), 'POST', '/api/attachments') ?? '', /Cross-site/);
	assert.match(crossSiteRefusal(request({ ...raw, origin: 'https://evil.example', host: 'dash:5173' }), 'POST', '/api/attachments') ?? '', /Cross-origin/);
	assert.match(crossSiteRefusal(request({ ...raw, origin: 'null', host: 'dash:5173' }), 'POST', '/api/attachments') ?? '', /Cross-origin/);
});

test('only POST /api/attachments is exempt', () => {
	const raw = request({ ...sameOrigin, 'content-type': 'application/octet-stream', 'content-length': '5000' });
	assert.match(crossSiteRefusal(raw, 'PUT', '/api/attachments') ?? '', /application\/json/);
	assert.match(crossSiteRefusal(raw, 'POST', '/api/attachments/extra') ?? '', /application\/json/);
	assert.match(crossSiteRefusal(raw, 'POST', '/api/members') ?? '', /application\/json/);
});
