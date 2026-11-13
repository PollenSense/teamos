# MCP tool modules

The MCP server (`scripts/lib/messaging/mcp-server.mjs`) offers the built-in messaging, task, schedule, trigger and watch tools. A **tool module** adds more tools without patching that list.

## Configure (host only)

List the module files under `mcp.modules` in `teamos.config.json`, the same file and the same trust as `probes`: an agent cannot add one, and a module runs with the server's own permissions. A path is relative to the project root, or absolute.

```json
{
	"mcp": {
		"modules": ["modules/my-tools.mjs"],
		"moduleLoadTimeoutMs": 5000
	}
}
```

`moduleLoadTimeoutMs` (default 5000) limits the import plus `registerTools` of each module.

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
- `handler(args, context)` returns an MCP result (`{ content: [...] }`) as is, a string as text, or any other value as JSON text. `context` is `{ teamDir, repoRoot, config, memberName }`.

## What happens when something is wrong

One module or one tool never breaks the others. Each problem is one line on stderr (`[mcp-server] ...`) and the item is left out:

| Problem | Result |
| --- | --- |
| module missing, does not import, throws, exports no tools, or is slower than the timeout | that module is skipped |
| tool without a valid name, a description, an object `inputSchema` or a `handler` | that tool is skipped, its module's other tools stay |
| tool named like a built-in tool or like an earlier module's tool | that tool is skipped (the first one wins) |
| `mcp.modules` is not a list | no module is loaded |
| a handler throws | that call returns an error result; the server keeps running |

With no `mcp.modules`, the tool list is exactly the built-in list.
