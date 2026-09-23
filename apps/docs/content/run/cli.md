---
title: Command line
description: "Run Executor on your own machine for one person. Your accounts, apps and data stay there, behind an API key, with an MCP endpoint any local agent can use."
---

The local server is Executor on one machine for one person. It holds your
accounts, runs your apps, and serves an MCP endpoint that any local agent can
connect to. There are no organizations and no browser sign-in.

The command is `executor`. During the beta it is not published to npm, so you
run it from a clone of the repository.

```bash
git clone https://github.com/UsefulSoftwareCo/executor-next
cd executor-next
bun install
```

## Configure it

Two settings are required, and the server refuses to start without them.

| Variable                  | Required | Purpose                                                                    |
| ------------------------- | -------- | -------------------------------------------------------------------------- |
| `EXECUTOR_API_KEY`        | yes      | Bearer token for the API and the MCP endpoint. At least 32 characters.     |
| `EXECUTOR_ENCRYPTION_KEY` | yes      | Key that encrypts stored credentials. Exactly 64 hexadecimal characters.   |
| `EXECUTOR_PORT`           | no       | HTTP port. The default is `4312`.                                          |
| `EXECUTOR_DATA_DIR`       | no       | Where the database and diagnostics live. The default is `.local/executor`. |
| `EXECUTOR_BROWSER_ORIGIN` | no       | Exact HTTPS origin to use in generated browser links.                      |
| `EXECUTOR_WEBHOOK_ORIGIN` | no       | Exact HTTPS origin that receives webhooks.                                 |

Generate the two keys once and keep them. Changing the encryption key makes the
credentials you already saved unreadable.

```bash
openssl rand -hex 32   # EXECUTOR_ENCRYPTION_KEY
openssl rand -hex 24   # EXECUTOR_API_KEY
```

## Start it

```bash
bun run executor
```

That starts the server and opens the dashboard in your browser.

| Command          | What it does                                                      |
| ---------------- | ----------------------------------------------------------------- |
| `executor`       | Start the server and open the dashboard.                          |
| `executor serve` | Start without opening a browser. Use this on a headless machine.  |
| `executor pair`  | Print a new connection link for a server that is already running. |

On a machine with no browser, run `executor serve`, then run `executor pair`
from a shell on that machine and open the printed link from your own computer.

## Connect an agent

The MCP endpoint is `http://127.0.0.1:4312/mcp`, authenticated with your API key
as a bearer token:

```bash
npx add-mcp 'http://127.0.0.1:4312/mcp' --transport http --name executor \
  --header 'Authorization: Bearer <EXECUTOR_API_KEY>'
```

The dashboard's **Connect** card shows this with your real port and key already
filled in. See [Add an MCP client](/mcp-clients) for Claude Code, Cursor
and Codex.

Keep the server running while a client is connected.

## Behind a reverse proxy

The server listens over HTTP. If a proxy terminates TLS in front of it, set
`EXECUTOR_BROWSER_ORIGIN` to the public HTTPS origin so generated links use it.

```bash
EXECUTOR_BROWSER_ORIGIN=https://executor.example.test executor serve
```

The value must be an exact origin: scheme, host and port, with no path. Origins
are never inferred from a request header.

## Your data

Everything lives under `EXECUTOR_DATA_DIR`, by default `.local/executor`. That
is the database, the encrypted credentials, and `diagnostics/`. Back up the
directory; there is nothing else to snapshot.

## What is coming later

- A published `executor` package, so the CLI installs without a clone.
- `executor dev`, a local loop for app authoring.
- A desktop app.
