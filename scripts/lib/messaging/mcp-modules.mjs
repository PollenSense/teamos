/**
 * Tool modules for the MCP server: a host-owned list of ES modules, each of which offers extra MCP tools.
 *
 * The host lists module paths under `mcp.modules` in `teamos.config.json` (the same file, and the same trust, as
 * `probes`: whoever can write that file can run code in the server). A path is relative to the project root, or absolute.
 *
 * A module exports `tools` (an array) or `registerTools(context)` (sync or async, returns an array). Each tool is
 *
 *   { name, description, inputSchema: { type: 'object', ... }, handler(args, context) }
 *
 * `handler` is called with the tool as `this`. It returns the result: an MCP result (`{ content: [{ type, ... }] }`)
 * goes through as is, anything else is sent as text (a string as is, other values as JSON). `context` is
 * `{ teamDir, repoRoot, config, member }` where `member` is the caller (`args.member` or the server's default,
 * validated like for the built-in tools) or null.
 *
 * One module or one tool must never break the others, so each failure is isolated and reported on stderr:
 *   - a module that cannot be imported, throws in `registerTools`, or takes longer than the timeout is skipped
 *     (modules load in parallel, so the delays do not add up; only an ASYNC hang can be timed out: code that loops
 *     forever without awaiting blocks the whole process, which is why the file is host-owned);
 *   - a tool without a valid name, description, object input schema or handler is skipped (the rest of its module
 *     stays), and so is a tool whose definition cannot be copied as plain JSON (circular, BigInt, throwing getter);
 *   - a tool named like a built-in tool, or like a tool loaded before it, is skipped (the first one wins);
 *   - a handler that throws gives that one call an error result, never a protocol error.
 */

import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MODULE_TIMEOUT_MS = 5000;
/** setTimeout turns anything above this into 1 ms. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function describe(err) {
	return err && err.message ? String(err.message) : String(err);
}

function isPlainObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function labelFor(name) {
	return typeof name === 'string' ? JSON.stringify(name.slice(0, 64)) : '(unnamed)';
}

function withTimeout(promise, ms, what) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Why a tool definition cannot be offered, or null when it can. The checks cover what an MCP client needs to
 * accept the tool list: one tool it rejects would hide every tool.
 */
export function toolProblem(tool) {
	if (!isPlainObject(tool)) return 'not an object';
	if (typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name)) return 'missing or invalid name';
	if (typeof tool.description !== 'string' || !tool.description.trim()) return 'missing description';
	const schema = tool.inputSchema;
	if (!isPlainObject(schema) || schema.type !== 'object') {
		return 'missing inputSchema (an object schema: { type: "object", ... })';
	}
	if (schema.properties !== undefined) {
		if (!isPlainObject(schema.properties)) return 'inputSchema.properties is not an object';
		if (!Object.values(schema.properties).every(isPlainObject)) return 'inputSchema.properties holds a property that is not an object';
	}
	if (schema.required !== undefined && !(Array.isArray(schema.required) && schema.required.every((item) => typeof item === 'string'))) {
		return 'inputSchema.required is not a list of names';
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
 * @param {object} options.context         passed to `registerTools`
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
		try {
			say(line);
		} catch {
			// a failing logger must not stop the loading
		}
	};
	const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, MAX_TIMEOUT_MS) : DEFAULT_MODULE_TIMEOUT_MS;
	const taken = new Set(reserved);
	const tools = [];

	if (modulePaths === undefined || modulePaths === null) return { tools, problems };
	if (!Array.isArray(modulePaths)) {
		problem('mcp.modules is not a list: no tool module loaded');
		return { tools, problems };
	}

	// Import every module at once (one slow module must not delay the rest), then take their tools in list order.
	const loaded = await Promise.all(
		modulePaths.map(async (entry) => {
			if (typeof entry !== 'string' || !entry.trim()) return { entry, skipped: `mcp.modules entry ${JSON.stringify(entry)} is not a path: skipped` };
			try {
				const path = isAbsolute(entry) ? entry : resolve(repoRoot, entry);
				const offered = await withTimeout(
					(async () => {
						const mod = await import(pathToFileURL(path).href);
						if (typeof mod.registerTools === 'function') return await mod.registerTools(context);
						return mod.tools;
					})(),
					limit,
					`module ${entry}`,
				);
				if (!Array.isArray(offered)) {
					return { entry, skipped: `tool module ${entry} not loaded: it exports no \`tools\` array and no \`registerTools\` that returns one` };
				}
				return { entry, offered };
			} catch (err) {
				return { entry, skipped: `tool module ${entry} not loaded: ${describe(err)}` };
			}
		}),
	);

	for (const { entry, offered, skipped } of loaded) {
		if (skipped) {
			problem(skipped);
			continue;
		}
		for (const tool of offered) {
			let label = '(unnamed)';
			try {
				// Read each field once (a class with getters works, a throwing getter only costs this tool), then
				// check and copy the plain data, so what is offered cannot change or fail to serialise later.
				const candidate = isPlainObject(tool)
					? { name: tool.name, description: tool.description, inputSchema: tool.inputSchema, handler: tool.handler }
					: tool;
				label = labelFor(candidate && candidate.name);
				const why = toolProblem(candidate);
				if (why) {
					problem(`tool ${label} from ${entry} skipped: ${why}`);
					continue;
				}
				if (taken.has(candidate.name)) {
					problem(`tool ${label} from ${entry} skipped: the name is already taken`);
					continue;
				}
				const definition = JSON.parse(JSON.stringify({ name: candidate.name, description: candidate.description, inputSchema: candidate.inputSchema }));
				const handler = candidate.handler;
				taken.add(candidate.name);
				tools.push({ definition, handler: (args, callContext) => handler.call(tool, args, callContext) });
			} catch (err) {
				problem(`tool ${label} from ${entry} skipped: ${describe(err)}`);
			}
		}
	}
	return { tools, problems };
}

/** What a handler's return value becomes: an MCP result as is, a string as text, anything else as JSON text. */
export function toToolResult(value) {
	if (isPlainObject(value) && Array.isArray(value.content) && value.content.every((item) => isPlainObject(item) && typeof item.type === 'string')) return value;
	const text = typeof value === 'string' ? value : (JSON.stringify(value ?? null, null, 2) ?? 'null');
	return { content: [{ type: 'text', text }] };
}

/** Call a module tool; a throw, or a result that cannot be serialised, becomes an error result for this call only. */
export async function callToolModule(tool, args, context) {
	try {
		const result = toToolResult(await tool.handler(args, context));
		JSON.stringify(result); // a circular or BigInt result must fail here, not while the reply is written
		return result;
	} catch (err) {
		return { content: [{ type: 'text', text: `Error: ${describe(err)}` }], isError: true };
	}
}
