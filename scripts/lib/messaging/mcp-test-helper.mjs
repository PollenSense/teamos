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

/** The server as `member` (default alice); `call` resolves with the JSON-RPC response, `tool` unwraps a tools/call. */
export async function withServer(dir, fn, member = 'alice') {
	const child = spawn(process.execPath, [SERVER], {
		cwd: dir,
		env: { ...process.env, TEAMOS_TEAM_DIR: join(dir, 'team'), TEAMOS_MEMBER_NAME: member },
		stdio: ['pipe', 'pipe', 'ignore'],
	});
	const waiting = new Map();
	createInterface({ input: child.stdout }).on('line', (line) => {
		const msg = JSON.parse(line);
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
		const res = await call('tools/call', { name, arguments: args });
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
}
