---
title: Approval and elicitation modes
description: "Control where Executor handles tool approvals and user input using elicitation_mode: automatic, model, native, or browser."
---

An app's tool rule can allow, deny, or request approval (app setup can run before the rule, and an explicit denial always blocks the call). When a tool requests approval or asks for user input mid-call, Executor's **approval mode** (`elicitation_mode`) decides where that prompt is handled: **Automatic** (`automatic`), **Through your agent** (`model`), **In your browser** (`browser`), or **In your client** (`native`).

- **Available on:** Local, Self-host, and Cloud.
- **Prerequisites:** An MCP client connected to `/mcp` (with MCP form elicitation support for `native`), or key-authenticated HTTP calls (personal access token or local server API key). For `browser` mode, you also need a signed-in browser session for the credential's owner on the same hosted server, or a paired Local browser.
- **Main URL parameter (for OAuth preselection or key-authenticated HTTP calls):**

```text
https://mcp.executor.sh/mcp?elicitation_mode=browser
```

You'll know it worked when triggering a tool with an approval rule behaves according to the chosen mode (proceeds without a separate Executor prompt in `automatic`, returns an `approvalUrl` in `browser`, prompts through the agent in `model`, or sends a client form for `execute` in `native`).

## The four modes

| Mode (`elicitation_mode`) | Sign-in screen label | How approvals and input are handled | `resume` tool exposed? |
| --- | --- | --- | --- |
| `automatic` | **Automatic** | Executor accepts app approval requests without a separate Executor prompt. A client may ask for its own permission first, though Executor cannot verify a client confirmation happened. Explicit denials still block execution, and tool input requests still go through the agent. | Yes |
| `model` | **Through your agent** | Accepts the decision from the client: your agent displays the request and calls `resume({ requestId, response: { action, content? } })`. | Yes |
| `browser` | **In your browser** | Requires the credential owner's hosted browser session (or a paired Local browser) to open `approvalUrl` (**Review tool request** or **Input requested**) and choose **Approve** / **Submit**, **Decline**, or **Cancel**. Your agent then calls `resume({ requestId })` in the originating MCP session. | Yes |
| `native` | **In your client** | Native `execute` sends approval and input forms to the client via MCP form elicitation while the request stays open. Native `call` uses the client-approved path, advertises potentially destructive and open-world hints, and skips a second Executor approval prompt. Client confirmation behavior depends on the client, and Executor cannot verify a client confirmation happened. | No |

Use `browser` mode when you want approvals recorded through a signed-in browser session rather than accepted from the agent's `resume` request—having `approvalUrl` alone is not enough without that browser session.

## How defaults and grant locking work

The default mode depends on how the client authenticates:

- **OAuth sign-in (`/mcp/authorize`):** The default `/mcp` URL preselects **Automatic** (`automatic`) on the consent screen. Adding `?elicitation_mode=browser` or `?elicitation_mode=native` preselects that option. Passing `?elicitation_mode=model` still starts on **Automatic**—select **Through your agent** on the consent screen to use `model`. The issued grant saves the chosen mode and keeps it on subsequent requests; changing `?elicitation_mode=` later does not change the grant's mode.
- **Hosted personal access tokens (Cloud and Self-host):** Bare hosted PAT requests default to `automatic` and read `?elicitation_mode=<mode>` on each request.
- **Local server API key (Local):** Bare Local server API key requests at `http://127.0.0.1:4312/mcp` default to `model` and read `?elicitation_mode=<mode>` on each request.
- **CLI tool commands (`executor`):** For CLI tool commands, choose **Approvals** during `executor login` on Cloud or `executor login --host "$EXECUTOR_ORIGIN"` on Self-host. With the default Local service and no host selected, tool commands use `model` mode. To choose another Local mode, use a compatible MCP client with browser OAuth or an authorized direct HTTP request with `?elicitation_mode=<mode>`.

## Choosing and changing a mode

### Cloud and Self-host (OAuth)

1. Point your MCP client at the endpoint URL with your preferred preselected mode, for example `https://mcp.executor.sh/mcp?elicitation_mode=browser` (Cloud) or `<your origin>/mcp?elicitation_mode=browser` (Self-host).
2. On the `/mcp/authorize` consent page, confirm **Approvals** (**Automatic**, **Through your agent**, **In your browser**, or **In your client**) and approve the connection.
3. To change the mode later, invalidate the hosted grant by selecting **Revoke** under **Connected agents** on the **Connections** page (disconnecting in a client locally does not revoke the server grant), then sign in again with the new mode.

You'll know it worked when `GET /mcp/whoami` with the client's bearer token reports your chosen mode, or when `executor whoami` prints the mode for your CLI credential after `executor login`.

### Local

For Local CLI tool commands, leave the host unset and run a tool command such as `executor search apps`. The CLI starts the Local service if needed.

To select a mode for a Local MCP connection:

1. Start Executor locally and pair the local dashboard in your browser if you will use browser OAuth or `browser` mode.
2. Point your MCP client at `http://127.0.0.1:4312/mcp?elicitation_mode=browser` (or another mode) and confirm **Approvals** on the local consent page.
3. For direct key-authenticated HTTP calls, pass the local server API key as a `Bearer` token with `?elicitation_mode=<mode>`.

You'll know it worked when running a tool with an approval rule uses the selected mode (for example, returning an `approvalUrl` in `browser` mode).

### Answering a browser approval

When a tool pauses in `browser` mode:

1. Executor returns `requestId` and `approvalUrl` to the agent.
2. Open `approvalUrl` in a browser signed in as the credential's owner on the same hosted Executor server (still authorized for the grant's organization), or in a paired Local browser.
3. Review the app, tool, account, and input on the **Review tool request** (or **Input requested**) page, then click **Approve** (or **Submit**), **Decline**, or **Cancel**.
4. Resume in the originating MCP session by calling `resume({ requestId })`. If the CLI started the paused call, run `executor resume "$REQUEST_ID"` in that same CLI profile (CLI `resume` uses its locally stored pause session and cannot pick up another client's pause by request ID alone).

For `model` or `automatic` pauses (such as tool input requests), pass the decision in `resume({ requestId, response: { action, content? } })`.

You'll know it worked when the browser page confirms the decision and `resume` returns `status: "completed"` with the tool's outcome.

## Example

Configure Claude Code against Executor Cloud with browser approvals preselected:

```bash
claude mcp add --transport http executor "https://mcp.executor.sh/mcp?elicitation_mode=browser"
```

When a CLI call pauses, capture the top-level `requestId` from the paused JSON response and resume in that same CLI profile:

```bash
# Given a paused JSON response saved to pause.json from executor call or executor execute:
REQUEST_ID=$(node -e 'const fs = require("node:fs"); console.log(JSON.parse(fs.readFileSync("pause.json", "utf8")).requestId);')
```

After answering in the browser, resume to collect the saved decision:

```bash
executor resume "$REQUEST_ID"
```

In model mode, send the decision through the client. After the user approves through the agent, resume with:

```bash
executor resume "$REQUEST_ID" --action accept
```

If the user declines or cancels through the agent, pass `--action decline` or `--action cancel` to match their decision.

## Limits

- **15-minute approval window:** MCP approval requests expire after 15 minutes (`900,000` ms). An expired request cannot continue; check what earlier calls did before deciding whether to run a new call.
- **Saved-call and version check:** Approval applies to the saved call, including its retained version, arguments, and selected accounts. A paused call can resume on its saved, retained version even after a new active version is deployed. Executor rechecks the saved invocation and applicable access before continuing; if Executor cannot confirm the invocation or access changed, inspect the error before deciding whether to start a new call.
- **`native` mode client requirement:** `native` mode requires an MCP client that supports MCP form elicitation. Clients without form elicitation should use `browser`, `model`, or `automatic`.
- **Input requests in `automatic` mode:** `automatic` accepts app approval requests without a separate Executor prompt, while explicit app denials still block execution and tool input requests still go through the agent.
- **No approval memory:** Executor does not yet remember past approvals across separate calls.

## Related

- [The MCP endpoint](/docs/mcp)
- [Scoped connections](/docs/mcp/scoped-connections)
- [Code mode and tool execution](/docs/mcp/code-mode)
- [Tools and approvals](/docs/concepts/tools-and-approvals)
- [Personal access tokens](/docs/api-keys)
