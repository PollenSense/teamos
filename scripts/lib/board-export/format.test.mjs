import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENTITY_TYPES, ExportError, TYPE_NAMES, fileNameFor, isIsoDate, validateRecord, validateRecords } from './format.mjs';
import { buildFixture } from './fixture-data.mjs';

test('the fixture covers every entity type and every record in it is valid', () => {
	const fixture = buildFixture();
	assert.deepEqual(Object.keys(fixture).sort(), [...TYPE_NAMES].sort());
	for (const type of TYPE_NAMES) {
		assert.ok(fixture[type].length > 0, `${type} has records`);
		validateRecords(type, fixture[type]);
	}
});

test('every field of a spec has a known kind', () => {
	const kinds = new Set(['string', 'int', 'number', 'bool', 'strings', 'object', 'iso', 'key', 'teamkey']);
	for (const [type, spec] of Object.entries(ENTITY_TYPES)) {
		assert.ok(spec.fields[spec.id], `${type}: the id field is in the spec`);
		for (const [field, raw] of Object.entries(spec.fields)) {
			assert.ok(kinds.has(raw.replace(/\?$/, '')), `${type}.${field} kind ${raw}`);
		}
	}
});

test('a missing required field, a wrong kind and a null required field are each one problem', () => {
	const good = buildFixture().issues[0];
	const { title, ...noTitle } = good;
	assert.deepEqual(validateRecord('issues', noTitle), [{ field: 'title', expected: 'missing' }]);
	assert.deepEqual(validateRecord('issues', { ...good, number: '1' }), [{ field: 'number', expected: 'int' }]);
	assert.deepEqual(validateRecord('issues', { ...good, title: null }), [{ field: 'title', expected: 'string' }]);
	assert.deepEqual(validateRecord('issues', { ...good, labelIds: ['a', 2] }), [{ field: 'labelIds', expected: 'strings' }]);
	assert.deepEqual(validateRecord('issues', null), [{ field: '(record)', expected: 'object' }]);
	assert.deepEqual(validateRecord('issues', []), [{ field: '(record)', expected: 'object' }]);
});

test('optional fields may be missing, null or undefined; extra fields are allowed', () => {
	const good = { ...buildFixture().issues[1], description: undefined, estimate: null, somethingNew: { a: 1 } };
	assert.deepEqual(validateRecord('issues', good), []);
});

test('issue keys, team keys and dates are checked by shape', () => {
	const issue = buildFixture().issues[0];
	for (const key of ['pse-1', 'PSE-0', 'PSE-01', 'P-1', 'PSE-', 'PSE-1234567890', 'PSE-1 ', '']) {
		assert.equal(validateRecord('issues', { ...issue, key }).length, 1, `key "${key}" is refused`);
	}
	for (const teamKey of ['P', 'pse', 'PSE_1', 'ABCDEFGHIJK']) {
		assert.equal(validateRecord('issues', { ...issue, teamKey }).length, 1, `team key "${teamKey}" is refused`);
	}
	assert.deepEqual(validateRecord('issues', { ...issue, key: 'AB1-12', teamKey: 'AB1' }), []);
});

test('a record with a date that is not a date is refused, for dates and date-times alike', () => {
	const issue = buildFixture().issues[0];
	assert.deepEqual(validateRecord('issues', { ...issue, createdAt: 'yesterday' }), [{ field: 'createdAt', expected: 'iso' }]);
	assert.deepEqual(validateRecord('issues', { ...issue, dueDate: '2025-02-30' }), [{ field: 'dueDate', expected: 'iso' }]);
	assert.deepEqual(validateRecord('issues', { ...issue, createdAt: 1737367200000 }), [{ field: 'createdAt', expected: 'iso' }]);
	assert.deepEqual(validateRecord('issues', { ...issue, dueDate: '2025-02-28' }), []);
});

test('isIsoDate accepts dates and date-times that exist and refuses the rest', () => {
	for (const ok of ['2026-02-28', '2024-02-29', '2026-02-28T10:00Z', '2026-02-28T10:00:00.123Z', '2026-02-28T10:00:00+02:00']) {
		assert.equal(isIsoDate(ok), true, ok);
	}
	for (const bad of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-02-28T25:00:00Z', 'yesterday', '2026-2-8', '', 20260228, null]) {
		assert.equal(isIsoDate(bad), false, String(bad));
	}
});

test('a repeated id or a repeated issue key is refused, naming the position and no value', () => {
	const [a, b] = buildFixture().issues;
	assert.throws(() => validateRecords('issues', [a, { ...b, id: a.id }]), (e) => e instanceof ExportError && e.code === 'duplicate-id' && /record 2/.test(e.message));
	assert.throws(() => validateRecords('issues', [a, { ...b, key: a.key }]), (e) => e.code === 'duplicate-id' && /"key"/.test(e.message));
	assert.throws(() => validateRecords('issues', 'not a list'), (e) => e.code === 'invalid-record');
});

test('error text never contains a record value', () => {
	const secret = 'SECRET-VALUE-9f3';
	const bad = { ...buildFixture().issues[0], key: secret, title: 5 };
	let message = '';
	try {
		validateRecords('issues', [bad]);
	} catch (e) {
		message = e.message;
	}
	assert.match(message, /record 1/);
	assert.ok(!message.includes(secret), 'no value in the message');
});

test('fileNameFor only answers for known types', () => {
	assert.equal(fileNameFor('issues'), 'issues.json');
	for (const bad of ['../issues', '__proto__', 'constructor', 'toString', 'Issues', '', 'issues.json', undefined]) {
		assert.throws(() => fileNameFor(bad), (e) => e.code === 'unknown-type', String(bad));
	}
});
