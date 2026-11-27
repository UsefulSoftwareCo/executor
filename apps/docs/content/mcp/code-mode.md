---
title: Code mode and tool execution
description: "Discover app tools with search and describe, invoke them directly with call, or chain and filter results in a JavaScript program with execute."
---

Executor's MCP endpoint gives agents four execution tools—`search`, `describe`, `call`, and `execute`—plus `skills` for app documentation and `resume` for paused approvals. Use `call` for one or a few direct tool invocations, and use **code mode** (`execute`) when one tool's output feeds the next call or when a large result needs to be filtered before entering the model's context window.

- **Available on:** Local, Self-host, and Cloud (same tool semantics; on Cloud, the MCP session runs in a Cloudflare isolate with a shared 128 MB memory limit).
- **Prerequisites:** An active MCP connection, or the `executor` CLI (`npm i -g executor@2.0.0-beta.79`) targeting a server with at least one deployed app and its required accounts linked. With no `--host`, `EXECUTOR_HOST`, or remembered sign-in, CLI tool commands start and use Local; for Cloud run `executor login`, and for Self-host run `executor login --host "$EXECUTOR_ORIGIN"`.
- **Main command (CLI):**

```bash
executor execute --code 'return await tools.search({ query: "apps" });'
```

You'll know it worked when the JSON output has `status: "completed"` and `execution.ok: true`, with your program's return value in `execution.value` and call summaries in `execution.toolCalls`.

## Discovering tools with `search` and `describe`

### `search`

`search` matches words against tool paths, descriptions, app names, account labels, router labels, and input names. Each page returns matching tools with their exact callable path (such as `tools.<app-slug>.<tool-name>` or bracket syntax like `tools["app-with-hyphens"].router.tool`), a description preview (up to 200 characters), and an input type preview (up to 1,000 characters, with `inputTruncated: true` when trimmed). Each app namespace and its linked user accounts appear once per page.

Pass the returned `next` object as the entire input to fetch the next page; `next` is `null` on the final page. Search uses the current app versions and account scope and may reuse evaluated tool listings—run discovery again after a deploy or account-link change.

### `describe`

Pass 1 to 20 exact tool paths from `search` to `describe` to retrieve complete descriptions, input types, and output types:

```json
{ "paths": ["tools.executor.appManagement.list"] }
```

Any unrecognized path is returned in `missing` alongside closest `matches`. Inside an `execute` program, call `tools.search(...)` and `tools.search.describe({ paths })` with the same shapes.

## Direct calls with `call`

Use `call` when you do not need loops, conditionals, or filtering. For one tool, pass `{ calls: { path, input } }`. For independent tools, pass an array as `calls`:

```json
{
  "calls": [
    { "path": "tools.executor.appManagement.list", "input": {} },
    { "path": "tools.executor.framework.release", "input": {} }
  ]
}
```

Multiple entries run concurrently. A completed response puts the outcome (or an array of outcomes in input order) in `execution.value`, each with `ok` and either `value` or `error`. A failed call does not cancel sibling calls. `call` returns full results without filtering; switch to `execute` when results are too large for model context.

## Running programs with `execute`

`execute` runs a JavaScript snippet inside Executor's interpreter where authorized app tools are async functions at the exact paths returned by `search` (for example, `tools.executor.appManagement.list` or `tools["app-with-hyphens"].router.tool`).

### How accounts are chosen

Every call inside `call` or `execute` uses the accounts linked to the app:

- With a single-account requirement, the tool gets the selected linked account from the app's **Accounts** tab.
- A `.many()` requirement gives the tool the allowed linked accounts as a list; a scoped connection may narrow that list, and the app chooses how to use it.
- Executor resolves app-scoped accounts from the app's links, subject to ordinary access checks.

Executor selects accounts from app links. In `execute`, a `$accounts` field produces `AccountChoiceUnsupported` when the tool’s input schema does not declare it. A declared field is ordinary app input. Change the app’s links to run with a different Executor account.

### Remote MCP tool results and `isError`

When an Executor app wraps a remote MCP server, the tool returns the remote server's MCP shape: `content`, and when present `structuredContent` and `isError`. If a remote server duplicates `structuredContent` as JSON text inside `content`, Executor strips the duplicate copy—read `structuredContent`.

When a remote tool reports `isError: true`, the call returns that result instead of throwing so programs checking `isError` keep working, while `execution.toolCalls` records the call's outcome as `failure`. An outcome of `success` only means no tool error was reported; inspect the returned payload before assuming an external action completed.

### Handling large results, images, audio, and files

Reduce large responses inside `execute` by mapping and returning only the fields the agent needs.

For binary outputs—screenshots, audio, or PDFs—Executor lifts matching blocks out of JSON so base64 data does not flood model context. Whenever `execute`, `call`, or `resume` returns a value containing:

- `{ type: "image", mimeType, data }`
- `{ type: "audio", mimeType, data }`
- `{ type: "resource", resource: { uri, mimeType?, blob } }`

with standard or URL-safe base64 bytes, Executor attaches each unique block as a separate MCP content item after the JSON text and replaces its bytes in JSON with a `contentIndex` pointing into the `content` array. Inside an `execute` program, the original bytes remain intact so one tool's output can be passed directly into another tool. Text resources stay in JSON.

From the CLI, `executor call`, `executor execute`, and `executor resume` write extracted binary blocks to files—in a new temporary directory or the directory passed to `--files <dir>`—and print each file's `path` beside `contentIndex`.

### Per-target execution steps

#### Local

With no `--host`, `EXECUTOR_HOST`, or remembered hosted target set, run directly from a shell without signing in:

```bash
executor execute --code 'const res = await tools.search({ query: "apps", limit: 3 }); return res.items.map((t) => t.path);'
```

You'll know it worked when the CLI prints a JSON envelope with `status: "completed"`, `execution.ok: true`, and `execution.value` containing an array of matching tool paths. (Exit code `0` alone does not guarantee success—always check `execution.ok`.)

#### Cloud and Self-host

For CLI tool commands, sign in with `executor login` for Cloud or set `EXECUTOR_ORIGIN` to your Self-host origin and run `executor login --host "$EXECUTOR_ORIGIN"`. Then run the example below in that CLI profile. You can pass `--host "$EXECUTOR_ORIGIN"` to target a specific host (`https://api.executor.sh` for Cloud) or redirect the output to a file with `> result.json`.

In an already connected MCP client, send the JavaScript from `list-app-tools.js` as the `code` argument to `execute`.

## Example

Save a script that searches for app tools and projects only their exact callable paths, then run it from a file (use the target setup above):

```bash
cat <<'EOF' > list-app-tools.js
const page = await tools.search({ query: "apps", limit: 3 });
return page.items.map(({ path }) => path);
EOF

executor execute --file list-app-tools.js --files ./out
```

Check that the printed JSON has `status: "completed"`, `execution.ok: true`, and `execution.value` containing up to three exact paths (which you can inspect with `describe` or invoke with `tools.<app-slug>.<tool-name>` or bracket syntax like `tools["app-with-hyphens"].router.tool`).

## Limits

MCP clients cannot raise server budgets. Local can configure `EXECUTOR_MCP_TIMEOUT_MS` and `EXECUTOR_MCP_MAX_TOOL_CALLS`; Self-host can configure `EXECUTOR_MCP_TIMEOUT_MS`:

| Limit | Default | Notes |
| --- | --- | --- |
| Program source size | 65,536 characters | Applies to `execute` source |
| Tool calls per `execute` | 100 calls | Configurable on Local (`EXECUTOR_MCP_MAX_TOOL_CALLS`) |
| Execution timeout | 5 minutes (`300,000` ms) of active work | Excludes time waiting for approval or input; configurable on Local and Self-host (`EXECUTOR_MCP_TIMEOUT_MS`); your client may give up earlier |
| App Worker RPC value size | 32 MiB | Applies to a single value crossing app Worker RPC |
| Cloud isolate memory | 128 MB shared | Cloudflare isolate limit (may be shared by Durable Objects); when Executor recognizes a reset due to that limit, it returns an error and the original result is lost |
| `search` page budget | 10 matches / ~25,000 bytes | Approximate page budget excluding outer MCP envelope and `unavailableApps` (admits at least one match); descriptions trim to 200 chars and input types to 1,000 chars |
| `describe` batch size | 1–20 paths | Extra paths must be split across calls |

- **Interpreter boundary:** The `execute` JavaScript interpreter exposes no direct `fetch`, `process`, filesystem API, timers, or module loading. Programs can discover and invoke authorized app tools, return values, and capture console output; those tools can make external changes. The interpreter enforces source size and call count and uses a cooperative execution deadline inside the server process.
- **No silent truncation on recognized overflows:** When Executor recognizes an RPC value-size or memory limit, it returns an error rather than a shortened tool value (separate from `search`'s explicit pagination and preview trimming).
- **No restart recovery:** Restart loses an in-flight program. Error or cancellation leaves earlier external effects in place—check what earlier calls did before deciding whether to run the program again.

## Related

- [The MCP endpoint](/docs/mcp)
- [Approval and elicitation modes](/docs/mcp/approval-modes)
- [Scoped connections](/docs/mcp/scoped-connections)
- [Tools tab](/docs/apps/tools)
- [Tools and approvals](/docs/concepts/tools-and-approvals)
