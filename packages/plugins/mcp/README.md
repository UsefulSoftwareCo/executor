# @executor-js/plugin-mcp

Register remote [Model Context Protocol](https://modelcontextprotocol.io) servers as tool sources for an executor. Supports HTTP/SSE MCP servers with optional OAuth.

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
  plugins: [mcpPlugin()] as const,
});

const scope = executor.scopes[0]!.id;

await executor.mcp.addSource({
  scope,
  transport: "remote",
  name: "Context7",
  endpoint: "https://mcp.context7.com/mcp",
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

Pre-`1.0`. APIs may still change between beta releases. Part of the [executor monorepo](https://github.com/RhysSullivan/executor).

## License

MIT
