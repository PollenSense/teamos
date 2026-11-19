import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { boardConfig } from './config.mjs';
import { openBoard } from './index.mjs';

const root = '/repo';

test('the module is off when the board section is missing, null, or switched off', () => {
	for (const config of [undefined, null, {}, { messaging: { adapter: 'file' } }, { board: null }, { board: { enabled: false } }]) {
		const cfg = boardConfig(config, root);
		assert.equal(cfg.on, false);
		assert.equal(typeof cfg.reason, 'string');
		assert.equal(openBoard(config, root), null);
	}
});

test('an empty section turns it on with the defaults', () => {
	const cfg = boardConfig({ board: {} }, root);
	assert.deepEqual(cfg, { on: true, dir: join(root, 'team', 'board'), lockDir: join(root, 'team', '.logs', 'board'), pollMinutes: 5, importer: false, teams: undefined });
});

test('path, pollMinutes, importer and teams are read; the lock folder never follows the path', () => {
	const cfg = boardConfig({ board: { path: 'team/work/board', pollMinutes: 10, importer: true, teams: ['PSE', 'INS'] } }, root);
	assert.equal(cfg.on, true);
	assert.equal(cfg.dir, join(root, 'team', 'work', 'board'));
	assert.equal(cfg.lockDir, join(root, 'team', '.logs', 'board'));
	assert.equal(cfg.pollMinutes, 10);
	assert.equal(cfg.importer, true);
	assert.deepEqual(cfg.teams, ['PSE', 'INS']);
	assert.ok(openBoard({ board: {} }, root).store);
});

test('anything wrong switches the board off with the reason, never half on', () => {
	const bad = [
		{ path: '/etc/board' },
		{ path: '../board' },
		{ path: 'team/../../board' },
		{ path: 'board' },
		{ path: 'team' },
		{ path: '' },
		{ path: 5 },
		{ pollMinutes: 0 },
		{ pollMinutes: 61 },
		{ pollMinutes: 'x' },
		{ importer: 'yes' },
		{ teams: 'PSE' },
		{ teams: ['pse'] },
	];
	for (const section of bad) {
		const cfg = boardConfig({ board: section }, root);
		assert.equal(cfg.on, false, JSON.stringify(section));
		assert.ok(cfg.reason.length > 0);
	}
	assert.equal(boardConfig({ board: 'on' }, root).on, false);
	assert.equal(boardConfig({ board: [] }, root).on, false);
});
