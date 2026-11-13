/**
 * Tool modules for the MCP server: a host-owned list of ES modules, each of which offers extra MCP tools.
 *
 * The host lists module paths under `mcp.modules` in `teamos.config.json` (the same file, and the same trust, as
 * `probes`): an agent cannot add one. A path is relative to the project root, or absolute.
 *
 * A module exports `tools` (an array) or `registerTools(context)` (sync or async, returns an array). Each tool is
 *
 *   { name, description, inputSchema: { type: 'object', ... }, handler(args, context) }
 *
 * `handler` returns the result: an MCP result (`{ content: [...] }`) goes through as is, anything else is sent as
 * text (a string as is, other values as JSON). `context` is `{ teamDir, repoRoot, config, memberName }`; a tool
 * that needs the caller reads `args.member` or `context.memberName` (the server fills `member` into every schema).
 *
 * One module or one tool must never break the others, so each failure is isolated and reported on stderr:
 *   - a module that cannot be imported, throws in `registerTools`, or takes longer than the timeout is skipped;
 *   - a tool without a name, a description, an object input schema or a handler is skipped (the rest of its module stays);
 *   - a tool named like a built-in tool, or like a tool loaded before it, is skipped (the first one wins);
 *   - a handler that throws gives that one call an error result, never a protocol error.
 */

import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MODULE_TIMEOUT_MS = 5000;

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function describe(err) {
	return err && err.message ? err.message : String(err);
}

function withTimeout(promise, ms, what) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Why a tool definition cannot be offered, or null when it can. */
export function toolProblem(tool) {
	if (!tool || typeof tool !== 'object') return 'not an object';
	if (typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name)) return 'missing or invalid name';
	if (typeof tool.description !== 'string' || !tool.description.trim()) return 'missing description';
	const schema = tool.inputSchema;
	if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object') {
		return 'missing inputSchema (an object schema: { type: "object", ... })';
	}
	if (schema.properties !== undefined && (typeof schema.properties !== 'object' || schema.properties === null || Array.isArray(schema.properties))) {
		return 'inputSchema.properties is not an object';
	}
	if (typeof tool.handler !== 'function') return 'missing handler function';
	return null;
}

/**
 * Load every module in `modulePaths`.
 *
 * @param {object} options
 * @param {string[]} options.modulePaths   from `mcp.modules`
 * @param {string} options.repoRoot        relative paths resolve against it
 * @param {object} options.context         passed to `registerTools` and to every handler
 * @param {Iterable<string>} [options.reserved]  names that are taken (the built-in tools)
 * @param {number} [options.timeoutMs]     per module, import plus `registerTools`
 * @param {(line: string) => void} [options.log]  one line per problem (stderr by default)
 * @returns {Promise<{ tools: Array<{ definition: object, handler: Function }>, problems: string[] }>}
 */
export async function loadToolModules({ modulePaths, repoRoot, context, reserved = [], timeoutMs = DEFAULT_MODULE_TIMEOUT_MS, log }) {
	const say = log || ((line) => process.stderr.write(`[mcp-server] ${line}\n`));
	const problems = [];
	const problem = (line) => {
		problems.push(line);
		say(line);
	};
	const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_MODULE_TIMEOUT_MS;
	const taken = new Set(reserved);
	const tools = [];

	if (modulePaths === undefined || modulePaths === null) return { tools, problems };
	if (!Array.isArray(modulePaths)) {
		problem('mcp.modules is not a list: no tool module loaded');
		return { tools, problems };
	}

	for (const entry of modulePaths) {
		if (typeof entry !== 'string' || !entry.trim()) {
			problem(`mcp.modules entry ${JSON.stringify(entry)} is not a path: skipped`);
			continue;
		}
		const path = isAbsolute(entry) ? entry : resolve(repoRoot, entry);
		let offered;
		try {
			offered = await withTimeout(
				(async () => {
					const mod = await import(pathToFileURL(path).href);
					if (typeof mod.registerTools === 'function') return await mod.registerTools(context);
					return mod.tools;
				})(),
				limit,
				`module ${entry}`,
			);
		} catch (err) {
			problem(`tool module ${entry} not loaded: ${describe(err)}`);
			continue;
		}
		if (!Array.isArray(offered)) {
			problem(`tool module ${entry} not loaded: it exports no \`tools\` array and no \`registerTools\` that returns one`);
			continue;
		}
		for (const tool of offered) {
			const why = toolProblem(tool);
			if (why) {
				problem(`tool ${JSON.stringify(tool && tool.name)} from ${entry} skipped: ${why}`);
				continue;
			}
			if (taken.has(tool.name)) {
				problem(`tool ${tool.name} from ${entry} skipped: the name is already taken`);
				continue;
			}
			taken.add(tool.name);
			const { handler, ...definition } = tool;
			tools.push({ definition: { name: definition.name, description: definition.description, inputSchema: definition.inputSchema }, handler });
		}
	}
	return { tools, problems };
}

/** What a handler's return value becomes: an MCP result as is, a string as text, anything else as JSON text. */
export function toToolResult(value) {
	if (value && typeof value === 'object' && Array.isArray(value.content)) return value;
	const text = typeof value === 'string' ? value : (JSON.stringify(value ?? null, null, 2) ?? 'null');
	return { content: [{ type: 'text', text }] };
}

/** Call a module tool; a throw becomes an error result for this call only. */
export async function callToolModule(tool, args, context) {
	try {
		return toToolResult(await tool.handler(args, context));
	} catch (err) {
		return { content: [{ type: 'text', text: `Error: ${describe(err)}` }], isError: true };
	}
}
