import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BoardError } from './errors.mjs';
import { assertCycleNumber, assertId, assertProjectCode, assertTeamKey, isProjectCode, isTeamKey, normalizeId, parseId } from './ids.mjs';

test('parseId reads the canonical form only', () => {
	assert.deepEqual(parseId('PSE-1061'), { id: 'PSE-1061', team: 'PSE', number: 1061 });
	assert.deepEqual(parseId('A1-1'), { id: 'A1-1', team: 'A1', number: 1 });
	assert.deepEqual(parseId('ABCDEFGHIJ-999999999'), { id: 'ABCDEFGHIJ-999999999', team: 'ABCDEFGHIJ', number: 999999999 });
	for (const bad of ['', 'pse-1061', 'PSE-0', 'PSE-01', 'PSE-', '-1', 'P-1', 'ABCDEFGHIJK-1', '1PSE-1', 'PSE-1000000000', 'PSE-1.5', 'PSE-1 ', ' PSE-1', 'PSE_1', 'PSE-1/../x', '../PSE-1', 'PSE-1.md', 'PSE-１', null, undefined, 12, {}]) {
		assert.equal(parseId(bad), null, `${JSON.stringify(bad)} must not parse`);
	}
});

test('normalizeId trims and upper-cases what a person typed', () => {
	assert.equal(normalizeId(' pse-1061\n'), 'PSE-1061');
	assert.equal(normalizeId('Pse-812'), 'PSE-812');
	assert.equal(normalizeId('PSE-01061'), null);
	assert.equal(normalizeId('pse 1061'), null);
	assert.equal(normalizeId(null), null);
});

test('assertId throws bad-id with the value named; team keys, project codes and cycle numbers have rules too', () => {
	assert.equal(assertId('PSE-1').team, 'PSE');
	assert.throws(() => assertId('pse-1'), (e) => e instanceof BoardError && e.code === 'bad-id');
	assert.equal(isTeamKey('PSE'), true);
	assert.equal(isTeamKey('pse'), false);
	assert.equal(isTeamKey('P'), false);
	assert.throws(() => assertTeamKey('../x'), (e) => e.code === 'bad-id');
	for (const ok of ['renewals', 'airevoSite', 'pollen-wise', 'a_b', 'X']) assert.equal(isProjectCode(ok), true, ok);
	for (const bad of ['', '-x', '../x', 'a/b', 'a b', 'a.b', 'x'.repeat(65), null]) assert.equal(isProjectCode(bad), false, String(bad));
	assert.throws(() => assertProjectCode('a/b'), (e) => e.code === 'bad-id');
	assert.equal(assertCycleNumber(37), 37);
	for (const bad of [0, -1, 1.5, '37', NaN, 1000000]) assert.throws(() => assertCycleNumber(bad), (e) => e.code === 'bad-id');
});
