import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findMentions, maskNonProse, missingFromCc, readMentions, refuseTagOnFyi } from './mentions.mjs';

const table = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'mentions-cases.json'), 'utf-8'));

describe('findMentions (shared table, also run by ui/test/mentions.test.ts)', () => {
	for (const c of table.cases) {
		it(c.name, () => {
			assert.deepEqual(findMentions(c.body, table.roster, { sender: c.sender }), c.expect);
		});
	}

	it('plain name lists work as a roster, and no roster tags nobody', () => {
		assert.deepEqual(findMentions('@nate @kris', ['nate', 'kris']), ['nate', 'kris']);
		assert.deepEqual(findMentions('@nate', []), []);
		assert.deepEqual(findMentions('@nate', undefined), []);
	});

	it('a roster name with characters outside letters, digits and underscore can never match', () => {
		assert.deepEqual(findMentions('@a-b', ['a-b']), []);
	});
});

describe('maskNonProse', () => {
	it('keeps positions: same length, only code and quotes blanked', () => {
		const body = 'x `@a` y\n> @b\n```\n@c\n```\n@d';
		const masked = maskNonProse(body);
		assert.equal(masked.length, body.length);
		assert.ok(!masked.includes('@a') && !masked.includes('@b') && !masked.includes('@c'));
		assert.ok(masked.endsWith('@d'));
	});
});

describe('readMentions', () => {
	it('reads a list or one name, drops everything else', () => {
		assert.deepEqual(readMentions({ mentions: ['nate', 'van'] }), ['nate', 'van']);
		assert.deepEqual(readMentions({ mentions: 'nate' }), ['nate']);
		assert.deepEqual(readMentions({ mentions: '' }), []);
		assert.deepEqual(readMentions({}), []);
		assert.deepEqual(readMentions(undefined), []);
	});
});

describe('refuseTagOnFyi', () => {
	it('refuses fyi plus a tag with a 400 that names the tag', () => {
		assert.throws(() => refuseTagOnFyi(true, ['nate']), (err) => err.status === 400 && /@nate/.test(err.message));
	});
	it('allows a tag without fyi, and fyi without a tag', () => {
		refuseTagOnFyi(undefined, ['nate']);
		refuseTagOnFyi(false, ['nate']);
		refuseTagOnFyi(true, []);
	});
});

describe('missingFromCc', () => {
	it('lists the tagged who are in neither To nor Cc, in order', () => {
		assert.deepEqual(missingFromCc(['nate', 'kris', 'van'], ['van'], ['kris']), ['nate']);
		assert.deepEqual(missingFromCc([], ['van'], undefined), []);
		assert.deepEqual(missingFromCc(['nate'], undefined, undefined), ['nate']);
	});
});
