import { isAbsolute, join, normalize, sep } from 'node:path';
import { isTeamKey } from './ids.mjs';

/**
 * The `board:` section of teamos.config.json (design seam 4). The whole board module is off when the section is
 * missing, so a checkout that never heard of the board runs exactly as before.
 *
 *   "board": { "path": "team/board", "pollMinutes": 5, "importer": false, "teams": ["PSE", "INS", "REV", "AER"] }
 *
 *   path         where the store lives; relative, inside `team/` (default `team/board`). The sync filter that keeps
 *                `raw/` and `files/` out of Drive names `/team/board/...`: change this path and the filter with it.
 *   pollMinutes  how often the Linear poll (A11) asks, 1 to 60 (default 5)
 *   importer     whether the importer and the poll may run at all (default false)
 *   teams        the team keys the board knows; optional
 *   enabled      false switches the module off while keeping the section
 *
 * Anything wrong makes the board off, with the reason, instead of half on: a bad path could put person data
 * where the sync filter does not reach.
 */
export const BOARD_DEFAULTS = { path: 'team/board', pollMinutes: 5, importer: false };

/** `{ on: false, reason }` or `{ on: true, dir, lockDir, pollMinutes, importer, teams }`; never throws. */
export function boardConfig(config, repoRoot) {
	const section = config?.board;
	if (section === undefined || section === null) return { on: false, reason: 'no board section in the config' };
	if (typeof section !== 'object' || Array.isArray(section)) return { on: false, reason: 'board is not an object' };
	if (section.enabled === false) return { on: false, reason: 'board.enabled is false' };
	if (section.enabled !== undefined && section.enabled !== true) return { on: false, reason: 'board.enabled must be true or false' };

	const path = section.path ?? BOARD_DEFAULTS.path;
	if (typeof path !== 'string' || path === '' || isAbsolute(path)) return { on: false, reason: 'board.path must be a relative folder' };
	const clean = normalize(path).split(sep).filter((part) => part !== '' && part !== '.');
	if (clean.includes('..') || clean[0] !== 'team' || clean.length < 2) return { on: false, reason: 'board.path must be a folder inside team/' };

	let pollMinutes = BOARD_DEFAULTS.pollMinutes;
	if (section.pollMinutes !== undefined) {
		if (!Number.isFinite(section.pollMinutes) || section.pollMinutes < 1 || section.pollMinutes > 60) return { on: false, reason: 'board.pollMinutes must be 1 to 60' };
		pollMinutes = section.pollMinutes;
	}
	if (section.importer !== undefined && typeof section.importer !== 'boolean') return { on: false, reason: 'board.importer must be true or false' };
	let teams;
	if (section.teams !== undefined) {
		if (!Array.isArray(section.teams) || !section.teams.every(isTeamKey)) return { on: false, reason: 'board.teams must be a list of team keys (PSE, INS)' };
		teams = [...section.teams];
	}
	return {
		on: true,
		dir: join(repoRoot, ...clean),
		lockDir: join(repoRoot, 'team', '.logs', 'board'),
		pollMinutes,
		importer: section.importer ?? BOARD_DEFAULTS.importer,
		teams,
	};
}
