# Executor

**Everything your agent needs, drivable as code.**

Think of Executor as Zapier or Retool, but fully drivable as code, with
everything exposed to your agent. Connect the services you already use once,
and any agent can use them through one MCP endpoint, without ever seeing a
credential.

[Website](https://executor.sh) · [Documentation](https://executor.sh/docs) · [Discord](https://discord.gg/eF29HBHwM6) · [Launch post](https://x.com/RhysSullivan/status/2118440383353172022)

https://github.com/user-attachments/assets/126c8117-2ef7-4f96-8fb8-8871728b0102

## What it does

You have an agent, and you want it to call something: an API, an MCP server, a
CLI, a service with no spec at all. Usually that means pasting the same keys into
every client, wiring the same servers up again, and writing an exception for
every API that does not fit the format.

Executor gives all of that one shape: the **app**. An app is a small TypeScript
program that turns your accounts into tools. One app can wrap an OpenAPI spec,
proxy a remote MCP server, or call an API by hand. It can also store data,
serve its own UI, run in the background, and ask before it does anything risky.

- **Connect once, use everywhere.** Save an account (an API key or an OAuth
  sign-in) once. Every app that needs the same service reuses it. The agent
  never sees the credential; Executor attaches it inside the app.
- **Your agent writes code, not tool calls.** Agents get two tools, `skills` and
  `execute`. They search for what they need and run a short program across as
  many apps as the task takes.
- **Approvals where they matter.** Each tool decides when to ask first: always,
  never, or only when the input looks risky. You approve through your agent, in
  your MCP client's own prompt, or on a browser page.
- **Build what isn't there yet.** Install from the catalog, add a remote MCP
  server by URL, or have your agent write and deploy a new app for you. Every
  deploy is a new version you can roll back.
- **For teams too.** Hosted and self-host add organizations, groups, shared
  accounts and browser sign-in.

## Get started

**Hosted.** Sign in at [app.executor.sh](https://app.executor.sh). There is
nothing to install.

**On your machine.** Your accounts and data stay local:

```sh
curl -fsSL https://executor.sh/docs/install.sh | sh
executor
```

`executor` starts Executor in the background and opens the dashboard. npm,
Homebrew and Windows installs are in the [command line guide](https://executor.sh/docs/run/cli).

**On your own infrastructure.** One Docker container with an embedded database.
See [Self-host with Docker](https://executor.sh/docs/run/self-host).

All three run the same apps and serve the same MCP endpoint.

## Connect your agent

Point any MCP client at your endpoint. With Claude Code and hosted Executor:

```sh
claude mcp add --transport http --scope user executor 'https://mcp.executor.sh/mcp'
```

Then run `/mcp` inside Claude Code to sign in. The local endpoint is
`http://127.0.0.1:4312/mcp`. ChatGPT, Codex, Cursor and others are covered in
[Add an MCP client](https://executor.sh/docs/mcp-clients).

Once connected, ask your agent what it can do: "Show me the apps and tools in
my Executor workspace."

## Build an app

An app is ordinary async TypeScript. This one has a single tool:

```ts
import { defineApp, object, query, router, string } from "apps";

export default defineApp(
  {},
  {
    tools: router({
      greet: query(
        { description: "Greet someone by name", input: object({ name: string() }) },
        async (_ctx, { name }) => ({ message: `Hello, ${name}!` }),
      ),
    }),
  },
);
```

Declare the accounts it needs and Executor asks the person using it to connect
them. Read [Author an app](https://executor.sh/docs/author-an-app) for accounts,
approvals, stored data and deploying. Or skip the reading and ask your agent to
build one: it can read the same guide through the `skills` tool.

## Learn more

- [What Executor is](https://executor.sh/docs): accounts, apps and tools in two minutes
- [Providers and accounts](https://executor.sh/docs/concepts/providers-and-accounts):
  what Executor stores and what an app sees
- [Tools and approvals](https://executor.sh/docs/concepts/tools-and-approvals):
  how calls are checked before they run
- [MCP](https://executor.sh/docs/mcp): code mode, `skills`, `execute` and resuming approvals

## Contributing

Issues and pull requests are welcome. [DEVELOPMENT.md](DEVELOPMENT.md) covers
running Executor from source, the repository layout and how the pieces fit
together. Executor 1 lives on the [`main`](https://github.com/UsefulSoftwareCo/executor/tree/main)
branch.

## License

[MIT](LICENSE)
