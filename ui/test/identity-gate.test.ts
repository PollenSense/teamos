import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refusalReason } from '../src/server/identity-gate.js';

const member = { name: 'van', locked: true, email: 'van@example.com' };
const unknown = { name: null, locked: true, email: 'who@example.com' };
const anonymous = { name: null, locked: false };

test('a known member passes', () => {
	assert.equal(refusalReason(member, '/api/members/van/inbox'), null);
});

test('an unknown login is refused on every route but /api/me', () => {
	for (const path of ['/api/members', '/api/members/van/inbox', '/api/messages', '/api/messaging/info']) {
		assert.match(refusalReason(unknown, path) ?? '', /who@example\.com matches no member/);
	}
	assert.equal(refusalReason(unknown, '/api/me'), null);
});

test('a request with no identity is left alone', () => {
	assert.equal(refusalReason(anonymous, '/api/members/van/inbox'), null);
});
