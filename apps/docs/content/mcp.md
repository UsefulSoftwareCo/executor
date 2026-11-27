---
title: The MCP endpoint
description: "Connect a compatible MCP client over streamable HTTP or stdio and discover and call the app tools your connection authorizes."
---

Executor stores credentials for your connected accounts and exposes one streamable HTTP MCP endpoint at `/mcp` so an agent can use authorized app tools through a single server. Connect your client to `https://mcp.executor.sh/mcp` (**Cloud**), `<your origin>/mcp` (**Self-host**), or `http://127.0.0.1:4312/mcp` (**Local**, default port), or run `executor mcp` over stdio.

- **Available on:** Local, Self-host, and Cloud.
- **Prerequisites:** At least one app in Executor with its required accounts linked (see [Connect an account](/docs/connect-an-account)) and an MCP client that supports streamable HTTP or stdio commands. For the stdio bridge, install the Executor 2 CLI first (`npm i -g executor@2.0.0-beta.79`). With no host selected or remembered, `executor mcp` starts or uses Local; for Cloud, sign in with `executor login` first; for Self-host, sign in with `executor login --host "$EXECUTOR_ORIGIN"`.
- **Main command (stdio bridge):**

```bash
claude mcp add executor -- executor mcp
```

You'll know it worked when your client lists Executor's tools (`skills`, `search`, `describe`, `call`, `execute`, and `resume` outside `native` mode) and `search` returns tools from your apps.

## Endpoint URLs by target

| Target | Streamable HTTP URL | Auth method |
| --- | --- | --- |
| **Cloud** | `https://mcp.executor.sh/mcp` | Browser OAuth or personal access token (see below) |
| **Self-host** | `<your origin>/mcp` | Browser OAuth or personal access token (see below) |
| **Local** | `http://127.0.0.1:4312/mcp` (default port) | Local browser OAuth (requires a running service and paired dashboard), or local server API key (`Authorization: Bearer <key>`) |

On Cloud, use `https://mcp.executor.sh/mcp`—the dashboard origin `app.executor.sh` does not serve `/mcp`. On Local, use the server's reported port if you changed it, and make sure the MCP client can reach the loopback listener.

For a personal access token (PAT) on Cloud or Self-host, use the organization-specific MCP URL from **Connections** (`/org/<slug>/mcp`). If the token is pinned to one organization, you can also use the plain `/mcp` URL. A full-account PAT using plain `/mcp` requires the `X-Executor-Organization` header to select the organization.

## The tools

The endpoint keeps a fixed `tools/list` surface no matter how many apps you add (the server also registers event and skill extensions). The MCP instructions direct clients to the built-in Executor app's `executor` skill. Reading it requires access to the app and any required linked account. The skill points to `code-mode` and `app-authoring`.

- **`skills`**: `skills({})` lists available app skills and `skills({ app, name })` reads one. The skill reader returns UTF-8 files as text and does not execute the returned file, though listing or reading can evaluate the app's code and run its dynamic skill loader with linked accounts. Some app skills require a linked account. Skill text and `allowed-tools` metadata grant no permissions.
- **`search`**: Finds app tools by words in their paths, descriptions, and labels, returning each tool's exact path and input type.
- **`describe`**: Returns the full description and input/output signatures for up to 20 exact tool paths from `search`.
- **`call`**: Calls one `{ path, input }` or an array of independent tool calls concurrently under the `calls` key.
- **`execute`**: Runs a JavaScript program inside Executor's interpreter over your apps to chain calls or filter large responses before they enter model context.
- **`resume`**: Continues a `call` or `execute` request that paused for approval or user input. Not exposed in `native` mode, where the client answers in place.

## Direct calls

Pass `{ calls: { path, input } }` for one direct call or `{ calls: [{ path, input }, ...] }` for concurrent calls:

```json
{ "calls": { "path": "tools.executor.appManagement.list", "input": {} } }
```

A completed response puts the outcome in `execution.value`. If you pass an array, the outcomes keep the same order. Each outcome has `ok` and either `value` or `error`; one failed call does not stop the others. Paused requests return an interaction instead. See [Code mode and tool execution](/docs/mcp/code-mode) for full `call`, `search`, `describe`, and `execute` semantics.

## Codemode

Use `execute` when one tool's output feeds the next call or when a large payload should be reduced before returning to the model. Inside `execute`, tools are async functions on `tools.<app-slug>.<tool-name>` (or bracket syntax such as `tools["app-with-hyphens"].router.tool`), alongside `tools.search` and `tools.search.describe`. Read the full reference, interpreter limits, and media/file handling in [Code mode and tool execution](/docs/mcp/code-mode).

## Signing in from the browser

### Cloud and Self-host

1. Add the `/mcp` URL to your MCP client (see [Add an MCP client](/docs/mcp-clients)).
2. Your client registers via OAuth and opens `/mcp/authorize` in your browser.
3. Sign in to Executor, choose an **Organization**, choose **Access** (**All apps**, a saved scoped connection, or **New connection**), and choose **Approvals** (**Automatic**, **Through your agent**, **In your browser**, or **In your client**).
4. Approve the connection. The client receives an OAuth token bound to that organization, access scope (for a scoped grant, the connection ID), and approval mode—the OAuth exchange does not issue your password or service credentials. Note that app tools can still return values their code can read.

Hosted MCP requests check the OAuth token, grant, and current membership. A revoked grant can return HTTP `401`. An otherwise valid grant without the required organization membership can return HTTP `403`. Switching organizations in the dashboard never retargets an existing MCP grant—connect again to authorize a second organization.

You'll know it worked when `GET /mcp/whoami` with the bearer token returns your organization, scope, and approval mode, or when your agent runs `search` and receives matching tool paths.

### Local

1. Start Executor locally (via the desktop app or CLI) so it listens on `http://127.0.0.1:4312` (or your configured port) and pair the local dashboard in your browser if you plan to use browser OAuth.
2. Point your MCP client on the same machine at `http://127.0.0.1:4312/mcp` (or `http://127.0.0.1:4312/mcp?connection=<id>` for a scoped connection).
3. On the local browser consent page, pick the **Approvals** mode and approve the client. Alternatively, pass the local server API key as a `Bearer` token at `/mcp` (not at scoped `?connection=` URLs).

You'll know it worked when your client lists Executor's tools and `search` returns tools from your local server.

## Scoped connections

A **scoped connection** restricts an MCP client to the apps, linked user accounts, tool subsets (**All tools**, **Read-only tools**, or **Specific tools**), and app events allowed by that connection. Create and manage them on the **Connections** page and connect via `/mcp?connection=<id>` or the sign-in screen. See [Scoped connections](/docs/mcp/scoped-connections).

## Elicitation modes

When a tool requires approval or asks for input, the grant's approval mode (`automatic`, `model`, `browser`, or `native`) controls how Executor handles it. For browser review, use `?elicitation_mode=browser` and confirm **In your browser** on the consent screen. Select **Through your agent** on the consent screen to use `model` (`?elicitation_mode=model` still initializes the selector to **Automatic**). Once granted, the OAuth grant keeps that selection. See [Approval and elicitation modes](/docs/mcp/approval-modes).

## From a shell

The `executor` CLI calls the same MCP tools from a terminal and prints JSON: `executor search`, `executor describe`, `executor call`, `executor execute`, `executor resume`, and `executor skills`.

- The CLI picks an explicit `--host` (or `EXECUTOR_HOST`), then the remembered host from a prior sign-in, then the Local service.
- On **Local**, with no host selected or remembered, run tool commands directly—the CLI starts the local server if needed.
- On **Cloud**, sign in with `executor login`. On **Self-host**, run `EXECUTOR_ORIGIN="https://executor.example.com"` and `executor login --host "$EXECUTOR_ORIGIN"` to authorize tool commands and `executor mcp` in your browser. In `2.0.0-beta.79`, `executor apps` commands use a separate sign-in via `executor apps login`.

`executor mcp` runs a local stdio MCP server that forwards messages to the selected host and refreshes its session automatically. Its instructions also tell the agent that the `executor` CLI is available in the shell so large results can be written to disk with `executor execute --file list-app-tools.js > result.json`.

## Example

Verify your local endpoint from a shell using `executor@2.0.0-beta.79` with no hosted target selected or remembered:

```bash
executor search "apps"
```

Inspect a specific tool returned by `search`:

```bash
executor describe tools.executor.appManagement.list
```

You'll know it worked when `search` returns a JSON page of matching tools (with `items` and `next`) and `describe` prints the full description and input/output schema for `tools.executor.appManagement.list`.

## Limits

- **Five vs. six tools:** `resume` is omitted in `native` mode (5 tools total); `automatic`, `model`, and `browser` modes expose all 6 tools.
- **One organization per grant:** A hosted OAuth grant stays bound to the organization selected at sign-in, even after token refresh.
- **Query string does not override a grant:** Changing `?connection=` or `?elicitation_mode=` after OAuth sign-in never widens access or weakens approvals.
- **Personal access tokens and local API key:** Neither can be used at `/mcp?connection=<id>`; Executor refuses them rather than falling back to unscoped access. Use OAuth for scoped connections.

### What is coming later

- **Remembering prior approvals:** Executor does not yet remember past approvals across separate calls.
- **Resuming after a server restart:** A paused `execute` program cannot continue after its server restarts. Check what its earlier calls did before deciding whether to run it again.

## Related

- [Code mode and tool execution](/docs/mcp/code-mode)
- [Approval and elicitation modes](/docs/mcp/approval-modes)
- [Scoped connections](/docs/mcp/scoped-connections)
- [MCP events](/docs/mcp/events)
- [Add an MCP client](/docs/mcp-clients)
- [Personal access tokens](/docs/api-keys)
- [Tools and approvals](/docs/concepts/tools-and-approvals)
