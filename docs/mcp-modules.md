# MCP tool modules

The MCP server (`scripts/lib/messaging/mcp-server.mjs`) offers the built-in messaging, task, schedule, trigger and watch tools. A **tool module** adds more tools without patching that list.

## Configure (host only)

List the module files under `mcp.modules` in `teamos.config.json`, the same file and the same trust as `probes`: whoever can write that file can run code in the MCP server, with the server's own permissions (`loadConfig` reads the project root's file first and `team/teamos.config.json` only when the root file is absent, so keep it where agents cannot write). A path is relative to the project root, or absolute.

```json
{
	"mcp": {
		"modules": ["modules/my-tools.mjs"],
		"moduleLoadTimeoutMs": 5000
	}
}
```

`moduleLoadTimeoutMs` (default 5000, at most 2147483647) limits the import plus `registerTools` of each module. Modules load in parallel, so slow ones cost one timeout, not one each.

## Write a module

Export `tools` (an array), or `registerTools(context)` (sync or async) that returns one.

```js
export const tools = [
	{
		name: 'my_tool',
		description: 'What it does, for the agent reading the tool list.',
		inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
		handler: async (args, context) => ({ echoed: args.text }),
	},
];
```

- `name`: a letter, then letters, digits, `_` or `-` (64 characters at most).
- `inputSchema`: an object schema. The server adds the optional `member` field, as for every tool.
- `handler(args, context)` is called with the tool as `this`. It returns an MCP result (`{ content: [{ type: ... }] }`) as is, a string as text, or any other value as JSON text. `context` is `{ teamDir, repoRoot, config, member }`; `member` is the caller, checked like for the built-in tools (an invalid `member` is refused before the handler runs), or `null` when the call names none and the server has no default. `registerTools` gets the same context without `member`.
- A class with getters works; the server reads each field once and keeps a plain-JSON copy of `name`, `description` and `inputSchema`, so a later change in the module does not alter the list.

## What happens when something is wrong

One module or one tool never breaks the others. Each problem is one line on stderr (`[mcp-server] ...`) and the item is left out:

| Problem | Result |
| --- | --- |
| module missing, does not import, throws, exports no tools, or is slower than the timeout | that module is skipped |
| tool without a valid name, a description, an object `inputSchema` (`properties` holding objects, `required` a list of names) or a `handler`, or one that cannot be copied as plain JSON (circular, BigInt, throwing getter) | that tool is skipped, its module's other tools stay |
| tool named like a built-in tool or like an earlier module's tool | that tool is skipped (the first one wins) |
| `mcp.modules` is not a list | no module is loaded |
| a handler throws, or returns something that cannot be sent as JSON | that call returns an error result; the server keeps running |
| module code leaves a rejected promise or a timer that throws after its call returned | logged on stderr, the server keeps running (these two guards are installed only when at least one module tool is loaded; without modules nothing changes) |
| module code loops forever without awaiting | not covered: it blocks the whole server, as any code in the same process would |

With no `mcp.modules`, the tool list is exactly the built-in list.
