import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BoardError } from './errors.mjs';
import { contentHash, jsonLine, mergeFields, parseDocument, parseHead, serializeDocument } from './frontmatter.mjs';

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

const TITLES = [
	'[x] looks like a list',
	'a: b: c',
	'He said "hi" and \\ left',
	'two\nlines',
	`line${LS}separator${PS}paragraph`,
	'',
	'  padded both sides  ',
	'🌼 pollen 🚀',
	'---',
	'carriage\rreturn\r\nand tab\t',
	'{"looks": "like json"}',
	'null',
	'42',
	'# not a comment',
	'trailing backslash \\',
];

test('round trip: titles that break line-based front matter come back identical, and write the same text again', () => {
	for (const title of TITLES) {
		const fields = { id: 'PSE-1', title, labels: ['Bug', title], relations: { blocks: ['PSE-2'], note: title }, estimate: 3, parent: null, done: false };
		const text = serializeDocument(fields, 'Body line 1\n---\nBody line 2\n');
		const back = parseDocument(text);
		assert.deepEqual(back.fields, fields, JSON.stringify(title));
		assert.equal(back.body, 'Body line 1\n---\nBody line 2\n');
		assert.deepEqual(back.warnings, []);
		assert.equal(serializeDocument(back.fields, back.body), text, 'second write is byte-identical');
	}
});

test('every field is exactly one line, and U+2028 / U+2029 never appear raw', () => {
	const text = serializeDocument({ title: `a${LS}b${PS}c\nd\re`, x: 1 }, '');
	assert.equal(text.includes(LS), false);
	assert.equal(text.includes(PS), false);
	assert.equal(text.split('\n').length, 1 + 2 + 1 + 1 + 1, '--- , two fields, ---, blank, empty body');
});

test('a body that starts with a newline, is empty, or has no blank line before it keeps its meaning', () => {
	for (const body of ['', '\nstarts blank', '\n\n', 'plain', 'ends\n\n']) {
		assert.equal(parseDocument(serializeDocument({ a: 1 }, body)).body, body, JSON.stringify(body));
	}
	assert.equal(parseDocument('---\na: 1\n---\nno blank line\n').body, 'no blank line\n');
	assert.equal(parseDocument('---\na: 1\n---').body, '');
});

test('values that are not JSON read as text with a warning; bad lines, repeats and __proto__ are dropped with one', () => {
	const doc = parseDocument('---\nstatus: In Review\nid: "PSE-1"\nid: "PSE-2"\nnot a field\n__proto__: {"polluted": true}\n: x\n\nlabels: ["a"]\n---\nbody');
	assert.deepEqual(doc.fields, { status: 'In Review', id: 'PSE-2', labels: ['a'] });
	assert.equal(({}).polluted, undefined);
	assert.equal(doc.warnings.length, 5, doc.warnings.join(" | "));
	assert.ok(doc.warnings.some((w) => /status: not JSON/.test(w)));
	assert.ok(doc.warnings.some((w) => /id: repeated/.test(w)));
});

test('CRLF files, a BOM and trailing spaces on the delimiters read the same as plain ones', () => {
	const doc = parseDocument(`${String.fromCharCode(0xfeff)}---  \r\nid: "PSE-1"\r\ntitle: "t"\r\n---  \r\nbody\r\nmore`);
	assert.deepEqual(doc.fields, { id: 'PSE-1', title: 't' });
	assert.equal(doc.body, 'body\r\nmore');
});

test('a file without front matter, or with an unclosed block, is damaged, never an empty card', () => {
	for (const text of ['', 'just text', '---\nid: "PSE-1"\n', '---\nid: "PSE-1"', '<<<<<<< HEAD\n---\nid: "x"\n---\n']) {
		assert.throws(() => parseDocument(text), (e) => e instanceof BoardError && e.code === 'damaged', JSON.stringify(text));
	}
});

test('undefined leaves a field out; NaN, Infinity, functions and bad key names are refused', () => {
	assert.equal(serializeDocument({ a: 1, b: undefined }, '').includes('b:'), false);
	for (const bad of [NaN, Infinity, () => 1, Symbol('x'), 10n]) assert.throws(() => jsonLine(bad), (e) => e.code === 'bad-value');
	assert.throws(() => jsonLine({ nested: NaN }), (e) => e.code === 'bad-value');
	for (const key of ['', 'a b', '1a', 'a:b', '__proto__', 'a\nb']) assert.throws(() => serializeDocument({ [key]: 1 }, ''), (e) => e.code === 'bad-value', JSON.stringify(key));
});

test('parseHead returns the fields when the block is closed inside the text, null when it is not', () => {
	assert.deepEqual(parseHead('---\nid: "PSE-1"\n---\nbody starts').fields, { id: 'PSE-1' });
	assert.equal(parseHead('---\nid: "PSE-1"\ntitle: "cut off'), null);
});

test('mergeFields: known fields come from the incoming object only, unknown fields already in the file are kept', () => {
	const existing = { id: 'PSE-1', title: 'old', milestone: 'M1', futureField: { a: 1 }, other: 'kept' };
	const merged = mergeFields(existing, { id: 'PSE-1', title: 'new', other: 'replaced', added: true }, ['id', 'title', 'milestone', 'labels']);
	assert.deepEqual(merged, { id: 'PSE-1', title: 'new', futureField: { a: 1 }, other: 'replaced', added: true });
	assert.deepEqual(Object.keys(merged), ['id', 'title', 'futureField', 'other', 'added']);
	assert.equal('milestone' in merged, false, 'a known field Linear cleared is removed');
});

test('contentHash is stable and differs on one changed character', () => {
	assert.equal(contentHash('a'), contentHash('a'));
	assert.notEqual(contentHash('a'), contentHash('b'));
	assert.match(contentHash(''), /^[0-9a-f]{64}$/);
});
