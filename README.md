# Executor

**Connect any agent to everything.**

Executor is an open-source integration layer for AI agents. Configure every
integration once (MCP servers, OpenAPI specs, GraphQL APIs) with authentication
and per-tool policies, then use that one catalog from any MCP-compatible agent.

[Website](https://executor.sh) · [Documentation](https://executor.sh/docs) · [Discord](https://discord.gg/eF29HBHwM6)

[https://github.com/user-attachments/assets/11225f83-e848-42ba-99b2-a993bcc88dad](https://github.com/user-attachments/assets/11225f83-e848-42ba-99b2-a993bcc88dad)

## Why Executor

Every agent you use (Claude Code, Cursor, ChatGPT, and the rest) needs its own
copy of every integration: the same API keys pasted in three places, the same
MCP servers wired up again, no shared idea of what each tool is allowed to do.

Executor is the layer in between. Add a tool once, give it credentials once,
set its policy once, and every agent shares it over MCP. Your integrations,
auth, and policies live in one place instead of being scattered across each
client.

- **Any source.** First-party support for MCP servers, OpenAPI, GraphQL, and
  Google Discovery. If you can describe it with a JSON schema, it can be an
  integration. The plugin system is open to any source type.
- **One catalog, every agent.** Anything MCP-compatible connects to the same
  set of tools.
- **Governed by policy.** Each tool is allowed, gated behind approval, or
  blocked, with sensible defaults derived from the spec.
- **Run it your way.** Local CLI, a desktop app, hosted Executor Cloud, or
  self-hosted on Docker or Cloudflare. Same functionality, different packaging.

## How it works

1. **Add an integration**: an MCP server, an OpenAPI spec, or a GraphQL API.
2. **Create a connection**: one configured (optionally authenticated) instance
   of that integration. An integration can have many connections.
3. **Set policies**: decide whether each tool is always allowed, needs
   approval, or is blocked.
4. **Point your agents at Executor** over MCP. They all share the same catalog.

See [Concepts](https://executor.sh/docs/concepts/integrations) for the full model.

## Quick start

The fastest path is **[Executor Cloud](https://executor.sh)**: sign in, add an
integration, and point your agents at the hosted MCP endpoint. Nothing to
install.

To run it locally instead (Node.js 20+):

```bash
npm install -g executor   # or: pnpm add -g / bun add -g / yarn global add
executor install          # install the durable background service
executor web              # open the web UI in your browser
```

`executor install` keeps the service running across restarts. For a throwaway
foreground runtime, use `executor web --foreground`. From the web UI, add your
first integration and connect an agent.

### Set up with your agent

Prefer to let your coding agent do the setup? Copy the
[setup prompt from the docs](https://executor.sh/docs) and paste it into Claude,
Cursor, or any MCP-capable agent. It will help you pick how to run Executor,
install it, connect over MCP, and get your first integration working end to end.

## Ways to run

Every form exposes the same functionality, just packaged differently.

| Form                       | Best for                                                                                                                  | Docs                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Executor Cloud**         | The fastest start. Use it from many agents (including cloud agents like ChatGPT) with nothing running locally. Free tier. | [Cloud](https://executor.sh/docs/hosted/cloud)           |
| **CLI**                    | A headless or server environment. Runs a local background service.                                                        | [CLI](https://executor.sh/docs/local/cli)                |
| **Desktop app**            | A regular desktop (Mac, Windows, Linux). The same runtime, as a native app.                                               | [Desktop](https://executor.sh/docs/local/desktop)        |
| **Self-host (Docker)**     | Your own infrastructure, full control.                                                                                    | [Docker](https://executor.sh/docs/hosted/docker)         |
| **Self-host (Cloudflare)** | Deploy as a Cloudflare Worker.                                                                                            | [Cloudflare](https://executor.sh/docs/hosted/cloudflare) |

## Connect an agent over MCP

Add Executor to any MCP client (Claude Code, Cursor, OpenCode) with
[`add-mcp`](https://www.npmjs.com/package/add-mcp), which detects the client and
writes its config for you:

```bash
# Over HTTP (the running service serves a streamable-HTTP endpoint)
npx add-mcp http://127.0.0.1:4788/mcp --transport http --name executor

# Or over stdio, with the executor CLI on your PATH
npx add-mcp "executor mcp" --name executor
```

The **Connect** card in the web UI shows the exact command (and port, if it
differs) already filled in. Most MCP clients only load servers at startup, so
you may need to restart the client or open a new chat before the Executor tools
appear.

## Add an integration

From the web UI, click **Add Source**, paste an OpenAPI, GraphQL, or MCP URL,
and Executor detects the type, indexes the tools, and handles auth. Or add one
from the CLI:

```bash
executor call executor openapi addSource '{
  "spec": "https://petstore3.swagger.io/api/v3/openapi.json",
  "namespace": "petstore",
  "baseUrl": "https://petstore3.swagger.io/api/v3"
}'
```

Use `baseUrl` when the OpenAPI document has relative `servers` entries (for
example `"/api/v3"`). Confirm it is live with `executor tools sources`.

## Using tools

### From the CLI

```bash
executor tools search "send email"      # find tools by intent
executor call github issues --help      # browse a namespace
executor call github issues create '{"owner":"octocat","repo":"Hello-World","title":"Hi"}'
```

`executor call`, `executor resume`, and `executor tools ...` auto-start the
local daemon if needed, and pick a free port if the default is busy. If an
execution pauses for auth or approval, resume it:

```bash
executor resume --execution-id exec_123
```

### From your own code

Embed Executor with the TypeScript SDK (a Promise API; an Effect-native API is
also available):

```ts
import { createExecutor } from "@executor-js/sdk/promise";
import { openApiPlugin } from "@executor-js/plugin-openapi/promise";

const executor = await createExecutor({ plugins: [openApiPlugin()] });

// add an integration, create a connection, then list and call tools
const tools = await executor.tools.list({ integration: "inventory" });
const schema = await executor.tools.schema(tools[0].address);

await executor.close();
```

See [`examples/`](examples) for runnable end-to-end scripts.

### CLI reference

```bash
executor install                    # install/start the durable background service
executor web                        # open the running web UI
executor web --foreground           # start a temporary foreground runtime + web UI
executor daemon run                 # start persistent local daemon in background
executor daemon status              # show daemon status
executor daemon stop                # stop daemon
executor daemon restart             # restart daemon
executor mcp                        # start MCP endpoint (stdio)
executor call <path...> '{"k":"v"}' # invoke a tool by path segments
executor call <path...> --help      # browse namespaces/resources/methods
executor call <path...> --help --match "<text>" --limit <n> # narrow huge namespaces
executor resume --execution-id <id> # resume paused execution
executor tools search "<query>"     # search tools by intent
executor tools sources              # list configured sources + tool counts
executor tools describe <path>      # show tool TypeScript/JSON schema
```

## Project layout

Executor is a Bun + Turborepo monorepo.

```
apps/
  cli/             the `executor` CLI and local background service
  desktop/         the desktop app (Mac, Windows, Linux)
  local/           the local runtime shared by the CLI and desktop
  cloud/           Executor Cloud (the hosted product)
  host-selfhost/   self-hosted server (Docker)
  host-cloudflare/ Cloudflare Worker deployment
  marketing/       the executor.sh site
  docs/            the docs at executor.sh/docs
packages/
  core/            contracts, plugin wiring, scopes, policies, SDK, API, CLI core
  kernel/          execution runtimes (QuickJS, Deno subprocess, dynamic worker)
  plugins/         source and provider plugins (openapi, graphql, mcp, google,
                   microsoft, 1password, keychain, encrypted/file secrets, ...)
  hosts/           host adapters (MCP surface, Cloudflare)
  react/           shared React UI
  app/             the web app UI
examples/          runnable SDK examples
e2e/               full-stack end-to-end tests
```

## Develop locally

```bash
bun install
bun run bootstrap   # idempotent: install deps, build required artifacts, fetch Playwright
bun run dev         # start the dev servers (defaults to http://127.0.0.1:4788)
```

`bun run bootstrap` is required in a fresh checkout: its build step produces
artifacts the dev servers fail without. See [RUNNING.md](RUNNING.md) for dev
servers, ports, and environment gotchas, and [AGENTS.md](AGENTS.md) for the
contributor contract.

### Tests

```bash
bun run test       # unit + integration suites
bun run test:e2e   # full-stack e2e: boots the cloud and self-host apps and drives them
```

The browser e2e scenarios need Playwright's Chromium once per machine:
`bunx playwright install chromium`.

## Community

Join the [Discord](https://discord.gg/eF29HBHwM6). To learn more, visit
[executor.sh](https://executor.sh) or [Ask DeepWiki](https://deepwiki.com/RhysSullivan/executor).

## License

[MIT](LICENSE)

## Attribution

- Thank you to [Crystian](https://www.linkedin.com/in/crystian/) for providing
  the npm package name `executor`.

## References

As part of my coding process, I give my agent access to references to other
codebases to understand patterns and how other people have implemented systems.
A non-exhaustive list:

- [FumaDB](https://github.com/fuma-nama/fumadb) - Storage adapter reference
- [Effect](https://github.com/Effect-TS/effect) - General code patterns
- [OpenCode](https://github.com/anomalyco/opencode) - Plugin system reference
- [OpenClaw](https://github.com/openclaw/openclaw) - Plugin system reference
- [Emdash](https://github.com/emdash-cms/emdash) - Plugin system reference
- [Pi](https://github.com/badlogic/pi-mono) - Plugin system reference

You are also encouraged to use this codebase as a reference to understand how it
is implemented.
