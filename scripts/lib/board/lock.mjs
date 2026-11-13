import { mkdir, open, readFile, unlink } from 'node:fs/promises';
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
 * runs). Known small window: two waiters that judge the same lock stale can both take over; the content-hash
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

async function readHolder(path) {
	try {
		const text = await readFile(path, 'utf-8');
		return { text, info: JSON.parse(text) };
	} catch {
		return null;
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
			} finally {
				await handle.close();
			}
			break;
		} catch (err) {
			if (err.code !== 'EEXIST') throw err;
		}
		const holder = await readHolder(path);
		const info = holder?.info;
		// An unreadable lock file (half-written, empty) is judged by its age on disk only after staleMs: leave it.
		const stale = info && typeof info.at === 'number' && (Date.now() - info.at > staleMs || (info.host === hostname() && Number.isInteger(info.pid) && !alive(info.pid)));
		if (stale) {
			const again = await readHolder(path);
			if (again?.text === holder.text) await unlink(path).catch(() => {});
			continue;
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
