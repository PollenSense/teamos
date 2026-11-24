import { BoardError } from './errors.mjs';

/**
 * ID rules for the board (design 2.3). An issue ID is a team key and a number, `PSE-1061`: the team key is two to
 * ten capital letters or digits starting with a letter, the number is a positive whole number without leading
 * zeros (at most nine digits). The ID is the issue's file name, so these rules are also what keeps a name from
 * leaving its folder: nothing that passes can hold a slash, a dot or a space.
 *
 * `parseId` accepts the canonical form only. `normalizeId` is for text a person typed or pasted: it trims and
 * upper-cases first, so `pse-1061 ` finds `PSE-1061`.
 */

const TEAM_KEY = /^[A-Z][A-Z0-9]{1,9}$/;
const ISSUE_ID = /^([A-Z][A-Z0-9]{1,9})-([1-9][0-9]{0,8})$/;
const PROJECT_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isTeamKey(text) {
	return typeof text === 'string' && TEAM_KEY.test(text);
}

/** `{ id, team, number }` for a canonical ID, or null. */
export function parseId(text) {
	if (typeof text !== 'string') return null;
	const match = ISSUE_ID.exec(text);
	return match ? { id: text, team: match[1], number: Number(match[2]) } : null;
}

/** The canonical ID for text a person typed, or null when it is not one. */
export function normalizeId(text) {
	if (typeof text !== 'string') return null;
	const parsed = parseId(text.trim().toUpperCase());
	return parsed ? parsed.id : null;
}

/** The canonical ID, or a `bad-id` error. For values a file or a caller must already have right. */
export function assertId(text, what = 'issue ID') {
	const parsed = parseId(text);
	if (!parsed) throw new BoardError('bad-id', `${what} ${JSON.stringify(text)} is not a team key and a number (PSE-1061)`);
	return parsed;
}

export function assertTeamKey(text) {
	if (!isTeamKey(text)) throw new BoardError('bad-id', `team key ${JSON.stringify(text)} is not two to ten capital letters or digits`);
	return text;
}

/** Board project codes are the tags messages already carry (`renewals`, `airevoSite`): letters, digits, `_`, `-`. */
export function isProjectCode(text) {
	return typeof text === 'string' && PROJECT_CODE.test(text);
}

export function assertProjectCode(text) {
	if (!isProjectCode(text)) throw new BoardError('bad-id', `project code ${JSON.stringify(text)} is not letters, digits, _ or - (up to 64)`);
	return text;
}

export function assertCycleNumber(value) {
	if (!Number.isInteger(value) || value < 1 || value > 999999) throw new BoardError('bad-id', `cycle number ${JSON.stringify(value)} is not a positive whole number`);
	return value;
}
