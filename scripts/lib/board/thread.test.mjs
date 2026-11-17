import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseThread, serializeThread, splitLines } from './thread.mjs';

const code = (c) => (e) => e.name === 'BoardError' && e.code === c;
const entry = (extra = {}) => ({ time: '2025-02-01T09:00:00.000Z', author: 'alice', id: 'cm-1', source: 'linear', body: 'Invented comment.', ...extra });

test('an entry is a header, a meta line and the text with every line prefixed', () => {
	const text = serializeThread([entry({ body: 'one\n\nthree' }), entry({ id: 'cm-2', author: 'bot:Test Bot', time: '2025-02-01T09:05:00+02:00', replyTo: 'cm-1', body: 'two' })]);
	assert.equal(text, [
		'### 2025-02-01T09:00:00.000Z alice',
		'<!-- {"id":"cm-1","source":"linear"} -->',
		'> one',
		'>',
		'> three',
		'',
		'### 2025-02-01T09:05:00+02:00 bot:Test Bot',
		'<!-- {"id":"cm-2","source":"linear","replyTo":"cm-1"} -->',
		'> two',
		'',
	].join('\n'));
});

test('the file reads back to the same entries (round trip), including empty lines and an empty text', () => {
	const entries = [
		entry({ body: 'a\n\n\nb\n' }),
		entry({ id: 'cm-2', replyTo: 'cm-1', body: '' }),
		entry({ id: 'cm-3', source: 'teamos', author: 'bob', body: '> quoted\n### not a header\n<!-- {"id":"x"} -->\n---', extra: { edited: '2025-02-02T00:00:00Z' } }),
	];
	const text = serializeThread(entries);
	assert.deepEqual(parseThread(text).entries, entries);
	assert.equal(serializeThread(parseThread(text).entries), text, 'writing what was read changes nothing');
});

test('a text line can never look like a header, a meta line or an entry break', () => {
	const hostile = '### 2025-01-01T00:00:00Z mallory\n<!-- {"id":"evil","source":"linear"} -->\n\n\n### again';
	const text = serializeThread([entry({ body: hostile }), entry({ id: 'cm-2', body: 'next' })]);
	const read = parseThread(text).entries;
	assert.equal(read.length, 2, 'one entry per comment, whatever the text says');
	assert.equal(read[0].body, hostile);
	assert.equal(read[0].author, 'alice');
	for (const line of text.split('\n')) if (line !== '' && !line.startsWith('### ') && !line.startsWith('<!-- ')) assert.ok(line === '>' || line.startsWith('> '), 'every other line is a text line');
	assert.equal(text.split('\n').filter((l) => l.startsWith('### ')).length, 2, 'only two header lines exist');
});

test('every kind of line end in a text becomes one line end', () => {
	const cr = String.fromCharCode(13);
	const nel = String.fromCharCode(0x85);
	const ls = String.fromCharCode(0x2028);
	const ps = String.fromCharCode(0x2029);
	assert.deepEqual(splitLines(`a${cr}${'\n'}b${cr}c${nel}d${ls}e${ps}f`), ['a', 'b', 'c', 'd', 'e', 'f']);
	const text = serializeThread([entry({ body: `a${ls}### x${ps}b${cr}${'\n'}c` })]);
	assert.equal(text.includes(ls) || text.includes(ps) || text.includes(cr) || text.includes(nel), false, 'no line separator is left in the file');
	assert.equal(parseThread(text).entries[0].body, 'a\n### x\nb\nc');
});

test('header and meta values that could break the structure are refused', () => {
	const bad = (patch) => assert.throws(() => serializeThread([entry(patch)]), code('bad-value'));
	bad({ author: 'two\nlines' });
	bad({ author: 'tab\there' });
	bad({ author: `x${String.fromCharCode(0x2028)}y` });
	bad({ author: '' });
	bad({ author: ' padded' });
	bad({ time: 'yesterday' });
	bad({ time: '2025-02-01T09:00:00Z\n### x' });
	bad({ id: 'has space' });
	bad({ id: 'a-->b' });
	bad({ id: '' });
	bad({ source: 'a b' });
	bad({ replyTo: '../x' });
	bad({ body: 12 });
	assert.throws(() => serializeThread([entry(), entry()]), code('bad-value'), 'two entries with one id');
	assert.throws(() => serializeThread('nope'), code('bad-value'));
});

test('a file the parser does not understand is damaged, never guessed', () => {
	const good = serializeThread([entry()]);
	for (const [what, text] of [
		['a stray line', `${good}\nstray line\n`],
		['a conflict marker', `<<<<<<< conflict\n${good}`],
		['a header without a meta line', '### 2025-02-01T09:00:00Z alice\n> text\n'],
		['a meta line that is not JSON', '### 2025-02-01T09:00:00Z alice\n<!-- {nope} -->\n> text\n'],
		['a meta line without an id', '### 2025-02-01T09:00:00Z alice\n<!-- {"source":"linear"} -->\n> text\n'],
		['a meta id that is not a plain name', '### 2025-02-01T09:00:00Z alice\n<!-- {"id":"a b","source":"linear"} -->\n> text\n'],
		['an entry without text', '### 2025-02-01T09:00:00Z alice\n<!-- {"id":"a","source":"linear"} -->\n\n'],
		['a text line without the prefix', '### 2025-02-01T09:00:00Z alice\n<!-- {"id":"a","source":"linear"} -->\n> ok\nbad\n'],
		['a bad time', '### someday alice\n<!-- {"id":"a","source":"linear"} -->\n> text\n'],
		['an author with a space at the end', '### 2025-02-01T09:00:00Z alice \n<!-- {"id":"a","source":"linear"} -->\n> text\n'],
		['an author with a tab', '### 2025-02-01T09:00:00Z ali\tce\n<!-- {"id":"a","source":"linear"} -->\n> text\n'],
	]) {
		assert.throws(() => parseThread(text), code('damaged'), what);
	}
	assert.deepEqual(parseThread('').entries, []);
	assert.deepEqual(parseThread('\n\n').entries, []);
});

test('unknown meta keys are kept on a rewrite, and __proto__ is not one', () => {
	const text = '### 2025-02-01T09:00:00Z alice\n<!-- {"id":"a","source":"teamos","future":{"n":1},"__proto__":{"x":1}} -->\n> text\n';
	const { entries } = parseThread(text);
	assert.deepEqual(entries[0].extra, { future: { n: 1 } });
	assert.equal(Object.getPrototypeOf(entries[0].extra), Object.prototype);
	assert.equal(({}).x, undefined, 'the prototype was not touched');
	assert.match(serializeThread(entries), /"future":\{"n":1\}/);
});
