# @executor-js/plugin-mcp

Register [Model Context Protocol](https://modelcontextprotocol.io) servers as tool integrations for an executor. Supports both stdio-launched servers and remote (HTTP) servers, with optional OAuth.

## Install

```sh
bun add @executor-js/sdk @executor-js/plugin-mcp
# or
npm install @executor-js/sdk @executor-js/plugin-mcp
```

## Usage

```ts
import { createExecutor } from "@executor-js/sdk";
import { mcpPlugin } from "@executor-js/plugin-mcp";

const executor = await createExecutor({
  onElicitation: "accept-all",
  // Stdio integrations spawn a local subprocess and inherit `process.env` —
  // only enable for trusted single-user contexts.
  plugins: [mcpPlugin({ dangerouslyAllowStdioMCP: true })] as const,
});

const scope = executor.scopes[0]!.id;

// Remote MCP server
await executor.mcp.addIntegration({
  scope,
  transport: "remote",
  name: "Context7",
  endpoint: "https://mcp.context7.com/mcp",
});

// Stdio MCP server (requires `dangerouslyAllowStdioMCP: true` above)
await executor.mcp.addIntegration({
  scope,
  transport: "stdio",
  name: "My Server",
  command: "npx",
  args: ["-y", "@my/mcp-server"],
});

// Every MCP tool is now part of the unified catalog
const tools = await executor.tools.list();

const result = await executor.tools.invoke("context7.searchLibraries", {
  query: "effect-ts",
});
```

## Using with Effect

If you're building on `@executor-js/sdk/core` (the raw Effect entry), import this plugin from its `/core` subpath instead — it returns the Effect-shaped plugin with `Effect.Effect<...>`-returning methods rather than promisified wrappers:

```ts
import { mcpPlugin } from "@executor-js/plugin-mcp/core";
```

## Status

Pre-`1.0`. APIs may still change between beta releases. Part of the [executor monorepo](https://github.com/UsefulSoftwareCo/executor).

## License

MIT
