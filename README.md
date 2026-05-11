# executor

[https://github.com/user-attachments/assets/11225f83-e848-42ba-99b2-a993bcc88dad](https://github.com/user-attachments/assets/11225f83-e848-42ba-99b2-a993bcc88dad)

The integration layer for AI agents. One catalog for every tool, shared across every agent you use.

[Ask DeepWiki](https://deepwiki.com/RhysSullivan/executor)

## Quick start

```bash
npm install -g executor
executor web
```

This starts a local runtime with a web UI at `http://127.0.0.1:4788`. From there, add your first source and start using tools.

### Use as an MCP server

Point any MCP-compatible agent (Cursor, Claude Code, OpenCode, etc.) at Executor to share your tool catalog, auth, and policies across all of them.

```bash

executor mcp
```

Example `mcp.json` for Claude Code / Cursor:

```json
{
  "mcpServers": {
    "executor": {
      "command": "executor",
      "args": ["mcp"]
    }
  }
}
```

## Add a source

If you can represent it with a JSON schema, it can be an integration. Executor has first-party support for OpenAPI, GraphQL, MCP, and Google Discovery — but the plugin system is open to any source type.

### Via the web UI

Open `http://127.0.0.1:4788`, go to **Add Source**, paste a URL, and Executor will detect the type, index the tools, and handle auth.

### Via the CLI

```bash
executor call executor openapi addSource '{
  "spec": "https://petstore3.swagger.io/api/v3/openapi.json",
  "namespace": "petstore",
  "baseUrl": "https://petstore3.swagger.io/api/v3"
}'
```

Use `baseUrl` when the OpenAPI document has relative `servers` entries (for example `"/api/v3"`).

## Use tools

Agents discover and call tools through a typed TypeScript runtime:

```ts
// discover by intent
const matches = await tools.discover({ query: "github issues", limit: 5 });

// inspect the schema
const detail = await tools.describe.tool({
  path: matches.bestPath,
  includeSchemas: true,
});

// call with type safety
const issues = await tools.github.issues.list({
  owner: "vercel",
  repo: "next.js",
});
```

Use tools via the CLI:

```bash
executor tools search "send email"
executor call --help
executor call github --help
executor call github issues --help
executor call cloudflare --help --match dns --limit 20
executor call github issues create '{"owner":"octocat","repo":"Hello-World","title":"Hi"}'
executor call gmail send '{"to":"alice@example.com","subject":"Hi"}'
```

`executor call`, `executor resume`, and `executor tools ...` commands auto-start a local daemon if needed.
If the default port is busy, the CLI will pick an available local port and track it automatically.

If an execution pauses for auth or approval, resume it:

```bash
executor resume --execution-id exec_123
```

## CLI reference

```bash
executor web                        # start runtime + web UI
executor daemon run                 # start persistent local daemon in background
executor daemon status              # show daemon status
executor daemon stop                # stop daemon
executor daemon restart             # restart daemon
executor mcp                        # start MCP endpoint
executor call <path...> '{"k":"v"}' # invoke a tool by path segments
executor call <path...> --help      # browse namespaces/resources/methods
executor call <path...> --help --match "<text>" --limit <n> # narrow huge namespaces
executor resume --execution-id <id> # resume paused execution
executor tools search "<query>"     # search tools by intent
executor tools sources              # list configured sources + tool counts
executor tools describe <path>      # show tool TypeScript/JSON schema
```

## Developing locally

```bash
bun install
bun dev
```

The dev server starts at `http://127.0.0.1:4788`.

## Community

Join the Discord: [https://discord.gg/eF29HBHwM6](https://discord.gg/eF29HBHwM6)

## Learn more

Visit [executor.sh](https://executor.sh) to learn more.

## Attribution

- Thank you to [Crystian](https://www.linkedin.com/in/crystian/) for providing the npm package name `executor`.

## References

As part of my coding process, I give my agent access to references to other codebases to understand patterns and how other people have implemented systems.

A non exhaustive list of references are:

- [Better Auth](https://github.com/better-auth/better-auth) - Storage adapter reference
- [Effect](https://github.com/Effect-TS/effect) - General code patterns
- [OpenCode](https://github.com/anomalyco/opencode) - Plugin system reference
- [OpenClaw](https://github.com/openclaw/openclaw) - Plugin system reference
- [Emdash](https://github.com/emdash-cms/emdash) - Plugin system reference
- [Pi](https://github.com/badlogic/pi-mono) - Plugin system reference

It's encouraged also that you can use this codebase as a reference to understand how it's implemented
