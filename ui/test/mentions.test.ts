import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { activeTag, completeTag, findMentions, insertAtSign, maskNonProse, previewTags, splitMentions, suggestions } from '../src/lib/mentions.js';

// The same table the server test runs (scripts/lib/messaging/mentions.test.mjs); the built test lives in ui/.test-build.
const table = JSON.parse(readFileSync(new URL('../../scripts/lib/messaging/mentions-cases.json', import.meta.url), 'utf-8')) as {
	roster: { name: string; active: boolean }[];
	cases: { name: string; body: string; sender?: string; expect: string[] }[];
};

const roster = [
	{ name: 'kris', title: 'CEO', active: true },
	{ name: 'nate', title: 'CTO', active: true },
	{ name: 'van', title: 'Marketing', active: true },
	{ name: 'sal', title: 'Sales ops', active: true },
	{ name: 'sagun', title: 'Data science', active: true },
	{ name: 'old', title: 'Gone', active: false },
];

describe('findMentions (shared table, also run by the server test)', () => {
	for (const c of table.cases) {
		it(c.name, () => {
			assert.deepEqual(findMentions(c.body, table.roster, { sender: c.sender }), c.expect);
		});
	}
});

describe('maskNonProse', () => {
	it('keeps the length and blanks code and quotes', () => {
		const body = 'x `@a` y\n> @b\n```\n@c\n```\n@d';
		const masked = maskNonProse(body);
		assert.equal(masked.length, body.length);
		assert.ok(!masked.includes('@a') && !masked.includes('@b') && !masked.includes('@c'));
		assert.ok(masked.endsWith('@d'));
	});
});

describe('previewTags', () => {
	it('lists who is tagged and who the server will add to Cc', () => {
		assert.deepEqual(previewTags('@nate and @van', roster, { sender: 'kris', to: ['van'], cc: [] }), { mentioned: ['nate', 'van'], addedToCc: ['nate'] });
		assert.deepEqual(previewTags('@nate', roster, { sender: 'kris', to: ['x'], cc: ['nate'] }), { mentioned: ['nate'], addedToCc: [] });
		assert.deepEqual(previewTags('no tags', roster, { sender: 'kris' }), { mentioned: [], addedToCc: [] });
		assert.deepEqual(previewTags('@kris', roster, { sender: 'kris' }), { mentioned: [], addedToCc: [] });
	});
});

describe('activeTag', () => {
	it('finds the @word being typed at the caret', () => {
		assert.deepEqual(activeTag('hello @na', 9), { start: 6, end: 9, query: 'na' });
		assert.deepEqual(activeTag('@', 1), { start: 0, end: 1, query: '' });
		assert.deepEqual(activeTag('a\n@s', 4), { start: 2, end: 4, query: 's' });
		assert.deepEqual(activeTag('(@na', 4), { start: 1, end: 4, query: 'na' });
	});
	it('ignores an @ that cannot start a tag, or one in code or a quote', () => {
		assert.equal(activeTag('van@pol', 7), null);
		assert.equal(activeTag('hello', 5), null);
		assert.equal(activeTag('hello @na rest', 3), null, 'the caret is not at the end of a tag word');
		assert.equal(activeTag('`@na', 4), null, 'an unclosed backtick is not code, but the @ follows a backtick, which is not a boundary');
		assert.equal(activeTag('> @na', 5), null);
		assert.equal(activeTag('```\n@na', 7), null);
		assert.equal(activeTag('https://x/@na', 13), null);
	});
	it('works with the caret inside a word: only what is before it counts', () => {
		assert.deepEqual(activeTag('@nate', 3), { start: 0, end: 3, query: 'na' });
	});
});

describe('suggestions', () => {
	it('prefix matches first, then containing, active only, never the sender, at most the limit', () => {
		assert.deepEqual(suggestions('', roster, { sender: 'kris' }).map((m) => m.name), ['nate', 'sagun', 'sal', 'van']);
		assert.deepEqual(suggestions('sa', roster).map((m) => m.name), ['sagun', 'sal']);
		assert.deepEqual(suggestions('A', roster, { sender: 'kris' }).map((m) => m.name), ['nate', 'sagun', 'sal', 'van']);
		assert.deepEqual(suggestions('a', [{ name: 'alton' }, { name: 'ivy' }, { name: 'david' }]).map((m) => m.name), ['alton', 'david']);
		assert.deepEqual(suggestions('old', roster), [], 'inactive members cannot be tagged');
		assert.deepEqual(suggestions('', roster, { limit: 2 }).map((m) => m.name), ['kris', 'nate']);
		assert.deepEqual(suggestions('zz', roster), []);
	});
});

describe('completeTag', () => {
	it('replaces what was typed with @name and a space, caret after it', () => {
		assert.deepEqual(completeTag('hi @na', { start: 3, end: 6, query: 'na' }, 'nate'), { text: 'hi @nate ', caret: 9 });
	});
	it('completing in the middle of a line reuses the space that follows', () => {
		assert.deepEqual(completeTag('hi @na there', { start: 3, end: 6, query: 'na' }, 'nate'), { text: 'hi @nate there', caret: 9 });
		assert.deepEqual(completeTag('hi @na, ok', { start: 3, end: 6, query: 'na' }, 'nate'), { text: 'hi @nate , ok', caret: 9 });
	});
});

describe('splitMentions', () => {
	it('cuts a run of text into plain parts and the tagged names', () => {
		assert.deepEqual(splitMentions('Hello @Nate, and @van.', ['nate', 'van']), [
			{ text: 'Hello ' },
			{ mention: 'nate', text: '@Nate' },
			{ text: ', and ' },
			{ mention: 'van', text: '@van' },
			{ text: '.' },
		]);
	});
	it('only names the message tags are highlighted; email and longer words are not', () => {
		assert.deepEqual(splitMentions('@kris and van@x.com and @salary', ['van']), [{ text: '@kris and van@x.com and @salary' }]);
		assert.deepEqual(splitMentions('plain', undefined), [{ text: 'plain' }]);
		assert.deepEqual(splitMentions('', ['van']), [{ text: '' }]);
	});
	it('a run that starts with the tag counts (it may follow markup)', () => {
		assert.deepEqual(splitMentions('@van', ['van']), [{ mention: 'van', text: '@van' }]);
	});
});

describe('insertAtSign', () => {
	it('types an @ at the caret, after a space unless the caret already follows a boundary', () => {
		assert.deepEqual(insertAtSign('', 0), { text: '@', caret: 1 });
		assert.deepEqual(insertAtSign('hello', 5), { text: 'hello @', caret: 7 });
		assert.deepEqual(insertAtSign('hello ', 6), { text: 'hello @', caret: 7 });
		assert.deepEqual(insertAtSign('a\nb', 2), { text: 'a\n@b', caret: 3 });
		assert.deepEqual(insertAtSign('(', 1), { text: '(@', caret: 2 });
		assert.deepEqual(insertAtSign('hi there', 2), { text: 'hi @ there', caret: 4 });
	});
	it('the typed @ opens the strip for everyone', () => {
		const r = insertAtSign('Please look', 11);
		assert.deepEqual(activeTag(r.text, r.caret), { start: 12, end: 13, query: '' });
	});
});
