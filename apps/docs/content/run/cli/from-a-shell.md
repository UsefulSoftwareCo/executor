---
title: Use Executor from a shell
description: "Sign in to Local, Self-host, or Cloud Executor, call app tools and skills from a terminal, and bridge MCP over stdio."
---

The `executor` CLI lets you call app tools, run JavaScript programs over your apps, read app skills, and bridge any Executor MCP endpoint over stdio from a shell (**Local**, **Self-host**, and **Cloud**).

In CLI `2.0.0-beta.79`, sign in to **Cloud** or **Self-host** with `executor login` for tool commands and `executor mcp`, and with `executor apps login` for `executor apps` commands. Tool and app-management commands can use the **Local** background Executor when no target host is selected.

**Prerequisites:** Executor `2.0.0-beta.79` installed ([Command line](/docs/run/cli)). For **Self-host** or **Cloud**, you need an account in the target organization and browser access to approve the sign-in code.

**You'll know it worked when** `executor search --namespace executor --limit 5` prints a JSON object containing `"items"` and `"namespaces"` (for **Self-host** or **Cloud**, verify tool sign-in with `executor whoami` and app-command sign-in with `executor apps list`).

## Sign in and choose a host

### Local

Without a named host, the CLI uses Local. The background server starts if needed with the default service settings. A supplied `EXECUTOR_API_KEY` takes precedence over the registered per-start credential. For an explicit loopback target, set `EXECUTOR_API_KEY` and clear any `EXECUTOR_ACCESS_TOKEN` override.

To confirm it works locally:

```bash
executor search --namespace executor --limit 5
```

You'll know it worked when the command prints JSON listing tools under `tools.executor.*`.

### Cloud and Self-host

In `2.0.0-beta.79`, tool commands and app management commands use separate browser device sign-ins. Both `executor login` and `executor apps login` honor `EXECUTOR_HOST` before defaulting to Cloud (`https://api.executor.sh`), so pass `--host` explicitly when switching targets.

Pick one target (`https://api.executor.sh` for **Cloud**, or replace `https://executor.example.com` with your **Self-host** origin):

- **Tool commands (`search`, `describe`, `call`, `execute`, `resume`, `skills`) and `executor mcp`:**

  ```bash
  HOST="https://api.executor.sh" # or your Self-host origin, e.g. https://executor.example.com
  executor login --host "$HOST"
  executor whoami --host "$HOST"
  ```

  `executor login` prints a URL and a short code. Open the URL in a browser where you are signed in, verify **Code**, select **Organization** if prompted, choose **All apps** or a named connection under **Access**, choose how approvals should be handled when offered, and click **Connect**.

  You'll know tool sign-in worked when `executor whoami --host "$HOST"` exits `0` and prints JSON showing your host, organization, grant scope, approval mode, and whether app commands are signed in.

- **App management commands (`executor apps list`, `create`, `deploy`, `publish`, `install`, etc.):**

  ```bash
  HOST="https://api.executor.sh" # or your Self-host origin, e.g. https://executor.example.com
  executor apps login --host "$HOST"
  executor apps list --host "$HOST"
  ```

  `executor apps login` opens the separate app-management consent screen: verify **Code**, select **Organization** if prompted, and click **Connect** (it does not show the MCP app-scope or approval choices).

  You'll know app sign-in worked when `executor apps list --host "$HOST"` exits `0` and prints your app list. (`executor whoami` requires the tools sign-in from `executor login` and fails after app-only sign-in.)

- **Sign out:**

  ```bash
  executor logout --host "$HOST"
  ```

  `executor logout` removes **both** saved local CLI sign-ins (tools and app commands) for that host and clears the remembered default host only if it matches that target. Server-side personal access tokens stay active until revoked or expired.

### Where sign-ins live and how the host is chosen

Tool and app-management operations select a host in this order:

1. `--host <origin>` on the command line
2. `EXECUTOR_HOST` environment variable
3. The remembered host from CLI sign-in
4. Local, using the background server by default

`executor whoami` and `executor logout` require a target from the first three options. Both login commands use the host flag or `EXECUTOR_HOST`, then default to Cloud.

The CLI tries your operating system's credential store first: tool sign-ins use service `Executor Tools`, app sign-ins use `Executor Registry`, and host mappings use `Executor Registry Git`. If writing to the OS credential store fails (even when an OS store exists), the CLI can save the session under `~/.local/state/executor/auth`. New session files request POSIX mode `0600` and the fallback directory requests `0700`. The CLI attempts to refresh saved sessions when it uses them within 60 seconds of expiry.

Tool and app commands resolve their hosted credentials separately. When supplying `EXECUTOR_ACCESS_TOKEN` for a named `executor apps` target, also pass `--organization`.

## Call tools and skills from a shell

Each tool command calls the matching [MCP tool](/docs/mcp#the-tools) and prints JSON to stdout. On failure, it exits with status `1` and prints the error message, code, and recovery hint to stderr; when stdout is not a terminal (piped or redirected), it also prints `{"error": {...}}` on stdout.

| Command | Key arguments and flags |
| --- | --- |
| `executor search [<query>]` | `--host <origin>`, `--namespace <app-or-path>`, `--limit <n>`, `--offset <n>` |
| `executor describe <path...>` | 1 to 20 exact tool paths from `search`; `--host <origin>` |
| `executor call [<path>]` | `--input <json>` (default `{}`), `--input-file <file\|->`, `--files <dir>`, `--host <origin>`. Omit `<path>` to pass a JSON array of `{"path", "input"}` calls that run concurrently. |
| `executor execute` | `--code <js>` or `--file <file\|->`, `--files <dir>`, `--host <origin>` |
| `executor resume <request-id>` | `--action accept\|decline\|cancel`, `--content <json>` or `--content-file <file\|->`, `--files <dir>`, `--host <origin>`. When approvals are answered in the browser, pass only `<request-id>`. |
| `executor skills` | `--app <slug>`, `--name <skill>`, `--file <path>`, `--version <id>`, `--revision <rev>`, `--host <origin>` |

Redirect large JSON results to a file (for example `> result.json`) so you or an agent can inspect only the slice you need. Binary outputs (images, audio, or files) are written into a fresh temporary directory — or the directory passed to `--files` — and their file paths are returned in the JSON output.

When a call pauses for approval or user input, `call` or `execute` prints the pending request (including `approvalUrl` in browser approval mode). Continue with `executor resume <request-id>` in the originating MCP session. Never re-run the original `call` or `execute`. When the response includes a browser approval URL and an MCP session is available, the CLI records the session ID and protocol version under `~/.local/state/executor/paused`. After a resume returns without the same browser-pause request, the CLI removes that request's saved record.

## Serve your tools to an MCP client

`executor mcp` exposes the resolved host's MCP endpoint over stdio for MCP clients that launch a local process, such as Claude Code:

```bash
claude mcp add executor -- executor mcp
```

Pass `--host <origin>` (or rely on `EXECUTOR_HOST` or your saved sign-in) to bridge a **Self-host** or **Cloud** host; with no host flag, `EXECUTOR_HOST`, or remembered host, `executor mcp` bridges Local, using the background server by default.

`executor mcp` forwards MCP requests and interactive messages (including approvals and questions from the host) and adds CLI instructions informing the agent that the `executor` command is available in its shell. If a request receives a missing-session (`404`) response after initialize, `executor mcp` tries to open a new MCP session and retry that request once.

## Example

These commands run against the built-in `executor` app on a fresh **Local** server (with no `EXECUTOR_HOST` or remembered remote host) and need no extra accounts:

```bash
# 1. Start the local background server (or let the next command start it)
executor service start

# 2. Find tools in the built-in executor app
executor search --namespace executor --limit 5

# 3. Inspect a tool's full TypeScript signature
executor describe tools.executor.appManagement.list

# 4. Call the tool directly
executor call tools.executor.appManagement.list

# 5. Run a short JavaScript program that returns only the count of apps
executor execute --code 'const apps = await tools.executor.appManagement.list(); return { count: apps.length };'

# 6. List available app skills
executor skills

# 7. Read the built-in executor skill instructions
executor skills --app executor --name executor
```

Step 5 prints:

```json
{
  "status": "completed",
  "execution": {
    "ok": true,
    "value": {
      "count": 1
    },
    "toolCalls": [
      {
        "name": "executor.appManagement.list",
        "outcome": "success",
        "durationMs": 36
      }
    ]
  },
  "unavailableApps": []
}
```

Step 7 prints a JSON object with `"file": "SKILL.md"` and its `"content"`.

## Limits

- In `2.0.0-beta.79`, `executor login` does not authenticate `executor apps` commands — run `executor apps login` separately for app management commands. There is no `executor apps logout` or `executor apps whoami`; use top-level `executor logout` and `executor whoami`.
- `executor whoami` fails with `NotSignedIn` when targeting the local background server without a named or signed-in remote host, or when only `executor apps login` has been completed.
- `executor describe` accepts at most 20 tool paths per call.
- `executor skills --name` requires `--app`, and `--file` requires `--name`.

## Related

- [Command line](/docs/run/cli)
- [Background server and key storage](/docs/run/cli/background-server)
- [MCP endpoint and tools](/docs/mcp)
- [Add an MCP client](/docs/mcp-clients)
- [Author an app](/docs/author-an-app)
