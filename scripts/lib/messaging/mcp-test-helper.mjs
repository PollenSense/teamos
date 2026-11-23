import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/** Shared by the tests that drive the real MCP server over stdio, as an agent's CLI runs it. */

const SERVER = fileURLToPath(new URL('./mcp-server.mjs', import.meta.url));

export const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64',
);

/** A throwaway project: `team/members.json` with the given members and a `pics/` folder with an image and a text file. */
export async function withProject(fn, members = [{ name: 'alice' }, { name: 'bob' }]) {
	const dir = await mkdtemp(join(tmpdir(), 'teamos-mcp-'));
	try {
		await mkdir(join(dir, 'team'), { recursive: true });
		await writeFile(join(dir, 'team', 'members.json'), JSON.stringify({ members }), 'utf-8');
		await mkdir(join(dir, 'pics'), { recursive: true });
		await writeFile(join(dir, 'pics', 'shot.png'), PNG);
		await writeFile(join(dir, 'pics', 'notes.txt'), 'plain text, definitely not an image at all');
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * The server as `member` (default alice); `call` resolves with the JSON-RPC response, `tool` unwraps a tools/call.
 * `onStderr(text)` receives what the server writes to stderr (it is ignored otherwise).
 * `anyMember: true` runs it as an interactive session (no TEAMOS_MEMBER_NAME): a `member` argument is honoured for
 * any member, and `tool` fills in `member` with the one given when a call names none. Since the identity check
 * (upstream bacdefa) a server run as a member refuses a `member` naming someone else, so a test that works as two
 * members at once needs this.
 */
export async function withServer(dir, fn, member = 'alice', { onStderr, anyMember = false } = {}) {
	const env = { ...process.env, TEAMOS_TEAM_DIR: join(dir, 'team') };
	if (anyMember) delete env.TEAMOS_MEMBER_NAME;
	else env.TEAMOS_MEMBER_NAME = member;
	const child = spawn(process.execPath, [SERVER], {
		cwd: dir,
		env,
		stdio: ['pipe', 'pipe', onStderr ? 'pipe' : 'ignore'],
	});
	if (onStderr) child.stderr.on('data', (chunk) => onStderr(chunk.toString('utf8')));
	const waiting = new Map();
	// stdout is the protocol and nothing else: a line that is not JSON is recorded and fails the test afterwards.
	const stray = [];
	createInterface({ input: child.stdout }).on('line', (line) => {
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			stray.push(line.slice(0, 120));
			return;
		}
		waiting.get(msg.id)?.(msg);
	});
	let next = 1;
	const call = (method, params) =>
		new Promise((resolve) => {
			const id = next++;
			waiting.set(id, resolve);
			child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
		});
	const tool = async (name, args) => {
		const withMember = anyMember && member && args && args.member === undefined ? { ...args, member } : args;
		const res = await call('tools/call', { name, arguments: withMember });
		if (res.error) return { error: res.error };
		const text = res.result.content[0].text;
		return { isError: !!res.result.isError, text, json: res.result.isError ? null : JSON.parse(text) };
	};
	try {
		await call('initialize', {});
		await fn({ call, tool });
	} finally {
		child.stdin.end();
		child.kill();
	}
	if (stray.length > 0) throw new Error(`the MCP server wrote ${stray.length} line(s) to stdout that are not JSON-RPC: ${JSON.stringify(stray)}`);
}
