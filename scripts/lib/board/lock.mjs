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
 * Known small window: two waiters that judge the same lock stale can both take over; the content-hash
 * compare in the store is what catches a lost update in that case.
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

/** `{ text, info }` (info null when the content is not JSON), or null when the file cannot be read (gone). */
async function readHolder(path) {
	let text;
	try {
		text = await readFile(path, 'utf-8');
	} catch {
		return null;
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
		const holder = await readHolder(path);
		if (!holder) continue; // it was released between our attempt and our look: try again at once
		const info = holder.info;
		let stale;
		if (info && typeof info.at === 'number') {
			stale = Date.now() - info.at > staleMs || (info.host === hostname() && Number.isInteger(info.pid) && !alive(info.pid));
		} else {
			// No usable content (empty or half-written, e.g. the disk filled while it was being made): judge by the file's age.
			try {
				stale = Date.now() - (await stat(path)).mtimeMs > staleMs;
			} catch {
				continue; // gone
			}
		}
		if (stale) {
			const again = await readHolder(path);
			if (again?.text === holder.text) {
				try {
					await unlink(path);
					continue;
				} catch (err) {
					if (err.code === 'ENOENT') continue;
					// We cannot remove it (read-only folder): fall through to the deadline, never spin.
				}
			}
		}
		if (Date.now() >= deadline) throw new BoardError('locked', `the board is locked by another writer (${name})`, { holder: info ? { pid: info.pid, host: info.host, at: info.at } : null });
		await sleep(pollMs);
	}
	try {
		return await fn();
	} finally {
		const now = await readHolder(path);
		if (!now || now.text === mine) await unlink(path).catch(() => {});
	}
}
