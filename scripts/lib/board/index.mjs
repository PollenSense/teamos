import { boardConfig } from './config.mjs';
import { BoardStore } from './store.mjs';

export { BoardError } from './errors.mjs';
export { boardConfig, BOARD_DEFAULTS } from './config.mjs';
export { BoardStore, ISSUE_FIELDS, PROJECT_FIELDS, TEAM_FIELDS, CYCLE_FIELDS } from './store.mjs';
export { IssueIndex } from './issue-index.mjs';
export { assertId, isProjectCode, isTeamKey, normalizeId, parseId } from './ids.mjs';
export { contentHash, mergeFields, parseDocument, serializeDocument } from './frontmatter.mjs';

/**
 * The board for a checkout, or null when the module is off (no `board:` section, or one that is not valid).
 * `config` is what `loadConfig(repoRoot)` returned. Every caller (the API, the sync script, the MCP tools) starts here,
 * so "off when the section is missing" is decided in one place. `on` is false with a `reason` when it is off.
 */
export function openBoard(config, repoRoot) {
	const cfg = boardConfig(config, repoRoot);
	if (!cfg.on) return null;
	return { config: cfg, store: new BoardStore({ dir: cfg.dir, lockDir: cfg.lockDir }) };
}
