import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Per-member inbox state that the mailbox lists cannot hold: `team/members/<name>/inbox-state.json`.
 *
 *   { "pinned": { "<message id>": "<when pinned, ISO>" } }
 *
 * `pinned` is the member's own "Needs me": the message stays in Needs you until they unpin or archive it.
 * More keys can be added next to it; unknown keys are kept as they are when the file is rewritten.
 *
 * Written through a temp file and a rename like the mailboxes (a reader never sees half a file), and read
 * defensively: the file syncs through Drive and can be hand-edited, so anything unexpected reads as "no pins"
 * instead of throwing into the dashboard or an agent's `list_inbox`.
 */

export function inboxStatePath(teamDir, member) {
	return join(teamDir, 'members', member, 'inbox-state.json');
}

function readRaw(path) {
	try {
		const data = JSON.parse(readFileSync(path, 'utf-8'));
		return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
	} catch {
		return {};
	}
}

/** `{ pinned: { id -> ISO } }`, with only well-formed entries. */
export function readInboxState(path) {
	const raw = readRaw(path);
	const pinned = {};
	if (raw.pinned && typeof raw.pinned === 'object' && !Array.isArray(raw.pinned)) {
		for (const [id, at] of Object.entries(raw.pinned)) if (typeof at === 'string') pinned[id] = at;
	}
	return { pinned };
}

/**
 * Read, change and write the state as one synchronous step (nothing in this process can interleave).
 * `change(state)` mutates `state.pinned` and returns true when it changed anything.
 */
export function updateInboxState(path, change) {
	const raw = readRaw(path);
	const state = readInboxState(path);
	if (!change(state)) return false;
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ ...raw, pinned: state.pinned }, null, '\t')}\n`, 'utf-8');
	renameSync(tmp, path);
	return true;
}
