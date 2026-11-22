import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gitAuthorEnv, isMemberAuthor } from './git-author.mjs';

test('git author names the member; email only from the template', () => {
	assert.deepEqual(gitAuthorEnv('Devin', {}), { GIT_AUTHOR_NAME: 'Devin (teamos)' });
	assert.deepEqual(gitAuthorEnv('Devin', { TEAMOS_GIT_AUTHOR_EMAIL: '{member}@example.com' }), {
		GIT_AUTHOR_NAME: 'Devin (teamos)',
		GIT_AUTHOR_EMAIL: 'devin@example.com',
	});
	assert.deepEqual(gitAuthorEnv(undefined, {}), {});
});

test('a member is the author of a commit under their bare name or the author their cycles commit as', () => {
	assert.equal(isMemberAuthor('Val', 'Val', 'runner@example.com', {}), true);
	assert.equal(isMemberAuthor('Val', 'Val (teamos)', 'runner@example.com', {}), true);
	assert.equal(isMemberAuthor('Val', 'Shep (teamos)', 'runner@example.com', {}), false);
	assert.equal(isMemberAuthor(undefined, 'Val (teamos)', 'runner@example.com', {}), false);
});

test('only a per-member email identifies the member; the runner’s shared one never does', () => {
	const env = { TEAMOS_GIT_AUTHOR_EMAIL: '{member}@example.com' };
	assert.equal(isMemberAuthor('Val', 'Someone', 'val@example.com', env), true);
	assert.equal(isMemberAuthor('Val', 'Someone', 'shep@example.com', env), false);
	assert.equal(isMemberAuthor('Val', 'Someone', 'runner@example.com', {}), false);
});
