import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { composeHref, prefillRecipients } from '../src/lib/compose.js';

const MEMBERS = [
	{ name: 'van', active: true },
	{ name: 'cy', active: true },
	{ name: 'Ivy', active: true },
	{ name: 'old', active: false },
];

describe('compose links', () => {
	it('no name is an empty message; names go in the To line, encoded, comma separated', () => {
		assert.equal(composeHref(), '#/compose');
		assert.equal(composeHref(''), '#/compose');
		assert.equal(composeHref([]), '#/compose');
		assert.equal(composeHref('cy'), '#/compose?to=cy');
		assert.equal(composeHref(['cy', 'ivy']), '#/compose?to=cy,ivy');
		assert.equal(composeHref(' cy '), '#/compose?to=cy');
		assert.equal(composeHref('a b'), '#/compose?to=a%20b');
	});

	it('the To line from a link: active members only, once each, in order, any letter case', () => {
		assert.deepEqual(prefillRecipients({ to: 'cy' }, MEMBERS), ['cy']);
		assert.deepEqual(prefillRecipients({ to: 'cy,ivy,cy' }, MEMBERS), ['cy', 'Ivy']);
		assert.deepEqual(prefillRecipients({ to: 'CY, nobody ,old' }, MEMBERS), ['cy'], 'unknown and inactive names are dropped');
		assert.deepEqual(prefillRecipients({}, MEMBERS), []);
		assert.deepEqual(prefillRecipients({ to: '' }, MEMBERS), []);
		assert.deepEqual(prefillRecipients({ to: ',,' }, MEMBERS), []);
		assert.deepEqual(prefillRecipients({ to: 'cy' }, []), []);
	});

	it('a link made by composeHref reads back to the same names', () => {
		const href = composeHref(['van', 'cy']);
		const query = Object.fromEntries(new URLSearchParams(href.split('?')[1]));
		assert.deepEqual(prefillRecipients(query, MEMBERS), ['van', 'cy']);
	});
});
