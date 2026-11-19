/**
 * An error the board store raises on purpose. `code` says which rule was broken, so a caller (the importer, an
 * API route) can report it by name instead of matching message text:
 *
 *   bad-id          an issue ID, team key, project code or cycle number that does not follow the rules (ids.mjs)
 *   bad-value       a front-matter value JSON cannot hold (undefined is skipped; NaN and Infinity are refused)
 *   bad-call        the caller left out a required option (a write without `expect`)
 *   duplicate-id    a new issue whose ID already has a file
 *   alias-conflict  an alias that is another issue's real ID, that another issue already claims, or the card's own ID
 *   changed         the file is not the one the caller read (its content hash differs): re-read and try again
 *   missing         a write expected a file that is not there
 *   damaged         a file that cannot be read as what it should be (no front matter, not JSON); never overwritten
 *   locked          the write lock is held by someone else and did not free up in time
 *   thread-conflict a card's retire would lose a thread file: two old cards have one, or one is already at the new card's ID
 *   unreadable      a file the store needs is there but cannot be read or inspected (permissions, I/O error): never treated as gone
 */
export class BoardError extends Error {
	constructor(code, message, details) {
		super(message);
		this.name = 'BoardError';
		this.code = code;
		if (details !== undefined) this.details = details;
	}
}
