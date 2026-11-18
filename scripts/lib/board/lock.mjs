import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { BoardError } from './errors.mjs';

/**
 * A lock for board writes: an exclusive-create file `<dir>/<name>.lock` holding `{ pid, host, at }`.
 *
 * The directory is `team/.logs/board/`: local to the machine, never in the synced folder (a lock that syncs
 * would lock every other machine out). A lock is stale, and taken over, when its process is gone (same host
 * only) or when it is older than `staleMs`; the second rule is the one that matters inside containers, where a
 * pid can mean another process or none. A waiter checks again every `pollMs` until `waitMs` has passed, then
 * gives up with a `locked` error.
 *
 * Phase (a) has one writer, so this guards the rare second one (an importer run started by hand while the poll
 * runs). A lock file with no readable content (empty, half-written) is judged by the file's own age instead.
 * Known small window, accepted: two waiters that judge the same lock stale can both take over (one removes the
 * stale file and creates its own, the other then removes that new one). The store's content-hash compare narrows
 * this but does not close it: `_put` reads the file's hash and renames the new text in two separate steps, so
 * two writers inside that gap can both pass the check. It takes a crashed holder and two new writers in the
 * same few milliseconds, and phase (a) has one writer. If a second writer ever runs regularly, the fix is a
 * lease the holder refreshes, not a longer wait.
 */

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === 'EPERM';
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const lockedError = (name, info) => new BoardError('locked', `the board is locked by another writer (${name})`, { holder: info ? { pid: info.pid, host: info.host, at: info.at } : null });

/**
 * `{ text, info }` (info null when the content is not JSON), or null when the file is gone (ENOENT). Any other
 * read error (permissions, I/O, the path is a folder) is an `unreadable` error: a lock we cannot read is not a
 * lock that was released, and treating it as one would spin without ever reaching the deadline.
 */
async function readHolder(path, name) {
	let text;
	try {
		text = await readFile(path, 'utf-8');
	} catch (err) {
		if (err.code === 'ENOENT') return null;
		throw new BoardError('unreadable', `the lock file of ${name} cannot be read (${err.code ?? 'error'})`, { code: err.code });
	}
	try {
		return { text, info: JSON.parse(text) };
	} catch {
		return { text, info: null };
	}
}

export async function withLock(dir, name, fn, { staleMs = 60_000, waitMs = 10_000, pollMs = 25 } = {}) {
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${name}.lock`);
	const mine = JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() });
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			const handle = await open(path, 'wx');
			try {
				await handle.writeFile(mine);
			} catch (err) {
				await handle.close().catch(() => {});
				await unlink(path).catch(() => {}); // never leave an empty lock behind
				throw err;
			}
			await handle.close();
			break;
		} catch (err) {
			if (err.code !== 'EEXIST') throw err;
		}
		const holder = await readHolder(path, name);
		if (!holder) {
			// It was released between our attempt and our look: try again at once, but never past the deadline.
			if (Date.now() >= deadline) throw lockedError(name, null);
			continue;
		}
		const info = holder.info;
		let stale;
		if (info && typeof info.at === 'number') {
			stale = Date.now() - info.at > staleMs || (info.host === hostname() && Number.isInteger(info.pid) && !alive(info.pid));
		} else {
			// No usable content (empty or half-written, e.g. the disk filled while it was being made): judge by the file's age.
			try {
				stale = Date.now() - (await stat(path)).mtimeMs > staleMs;
			} catch (err) {
				if (err.code === 'ENOENT') {
					// Gone between the read and the stat: try again at once, but never past the deadline.
					if (Date.now() >= deadline) throw lockedError(name, null);
					continue;
				}
				throw new BoardError('unreadable', `the lock file of ${name} cannot be inspected (${err.code ?? 'error'})`, { code: err.code });
			}
		}
		if (stale) {
			const again = await readHolder(path, name);
			if (again?.text === holder.text) {
				let gone = false;
				try {
					await unlink(path);
					gone = true;
				} catch (err) {
					// Already removed by someone else counts as gone. Any other error (a read-only folder) means we
					// cannot remove it: fall through to the deadline, never spin.
					gone = err.code === 'ENOENT';
				}
				if (gone) {
					// Try again at once, but never past the deadline (another waiter may keep making stale locks).
					if (Date.now() >= deadline) throw lockedError(name, null);
					continue;
				}
			}
		}
		if (Date.now() >= deadline) throw lockedError(name, info);
		await sleep(pollMs);
	}
	try {
		return await fn();
	} finally {
		// Release only a lock we can read and recognise as ours. One we cannot read is left alone (it goes stale on
		// its own) and the error is not raised: it must not replace what `fn` returned or threw. A lock that is
		// already gone is left alone too: another writer may create its own between our look and an unlink.
		const now = await readHolder(path, name).catch(() => undefined);
		if (now?.text === mine) await unlink(path).catch(() => {});
	}
}
