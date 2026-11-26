---
title: Scoped connections
description: "Create named MCP URLs that limit an agent to specific apps, linked accounts, tools, and events, then monitor and revoke connected agents."
---

A **scoped connection** is a named MCP URL (`/mcp?connection=<id>`) using OAuth that restricts an agent to the apps, linked user accounts, tools, and app events allowed by the connection's current policy. Create and edit connections on the **Connections** page (**New connection**), authorize an MCP client through OAuth, and revoke a connection or an individual agent at any time without rotating service credentials.

- **Available on:** Local (`/connections`), Self-host (`/org/<slug>/connect`), and Cloud (`/org/<slug>/connect`).
- **Prerequisites:** Access to use each app you want to include, plus ownership or authorization for any user accounts you select (linked on each app's **Accounts** tab). On hosted targets, an organization admin role or app edit access is not required for your own scoped connections.
- **Main UI action:** Open **Connections** → click **New connection** → pick apps, accounts, tools, and events → click **Create connection**.

You'll know it worked when the new connection appears on **Connections** and a client authorized through it sees the expected tools—and excludes a known disallowed tool—when calling `search`.

## Creating and editing a scoped connection

On **Local**, **Self-host**, and **Cloud**, the connection editor works the same way:

1. Open **Connections** in the dashboard. The built-in **Full access** card gives an agent every app you can use; click **New connection** to create a restricted one.
2. Enter a **Name** (1 to 80 characters, with at least one non-whitespace character).
3. Use **Search apps** and turn on each app to include. Previously saved apps appear under **Can use** (or **Apps** if none are saved yet); newly selected apps can remain under **Other apps** until you save.
4. For each app you enable, review **Runs as**, **Tools**, and **Events** separately:
   - **Runs as** (shown when the app offers user-account selection): Pick which of your linked user accounts the connection may use. App-scoped accounts are selected by app requirements and do not appear in this picker.
   - **Tools**: Choose **All tools**, **Read-only tools**, or **Specific tools** (filterable by **All**, **Read**, **Write**, and **Selected**). **Read-only tools** limits tool calls to tools classified as read-only (classification uses tool metadata and does not prove a remote or custom tool has no side effects). **All tools** and **Read-only tools** match future applicable tools.
   - **Events**: Event access is separate from tool access and starts with **All events**, including future events, even if you chose **Read-only tools**. If **Events** is visible, clear **All events**, then clear the individual selections. If the app declares no events, the editor has no **Events** picker. Leave the app out of the connection if it must have no future event access.
5. Click **Create connection** (or **Save changes** when editing; click **Discard** to revert unsaved edits).

Policy edits apply to the next authorization check for agents already authorized through that connection—no reconnect required (edits do not undo work already underway or external effects already made). App approval rules still come from app code and the grant's approval mode.

## Authorizing a client

### Cloud and Self-host

You can attach a scoped connection to an MCP client in either of two ways:

1. **From the connection's URL:** On **Connections**, click **Connect** on the scoped connection (or open **More actions** → **Copy MCP URL**) to get `<origin>/mcp?connection=<id>`, and add that URL to your MCP client. When the browser opens `/mcp/authorize`, that connection is preselected.
2. **From the plain `/mcp` URL:** Add `https://mcp.executor.sh/mcp` (Cloud) or `<your origin>/mcp` (Self-host) to your client. On `/mcp/authorize`, choose **Organization**, pick the saved connection under **Access** (or click **New connection**, which opens the connection editor in a new tab—save there, then return to consent and select the saved connection), pick **Approvals**, and approve.

Either way, the issued OAuth grant binds to that connection ID and follows its current policy. Changing the request URL later never widens access.

You'll know it worked when **Connected agents** on **Connections** lists `Scoped connection: <name>` (or a summary such as `Selected tools in 1 app`), and running `search` in that same MCP client returns the expected tools while excluding a known disallowed tool.

### Local

1. On **Connections** (`/connections`), create your scoped connection and click **Connect** (or **More actions** → **Copy MCP URL**) to copy `http://127.0.0.1:4312/mcp?connection=<id>` (use your server's reported port if changed).
2. Add that exact URL to your MCP client. (On Local, the browser consent screen chooses **Approvals** only; the connection comes from the URL you hand the client.)
3. Approve the client in your paired local browser.

You'll know it worked when that MCP client calls `search` and returns only tools allowed by that connection.

## Managing connected agents and revoking access

- **Revoking a scoped connection (Local, Self-host, Cloud):** On **Connections**, open the connection's **More actions** menu, click **Revoke connection**, and confirm. Revoking the connection blocks later MCP requests using grants issued through it. On hosted targets, a revoked grant can return HTTP 401.
- **Revoking an individual agent (Self-host and Cloud):** Scroll to **Connected agents** on **Connections** to view each authorized MCP client and its connection label or scope summary. Click **Revoke** and confirm **Revoke agent** to block subsequent requests from that client while leaving other agents using the same connection active.

Revoking a grant or connection blocks later requests without undoing work already underway or external effects already made. On hosted Executor, a client with access to the built-in Executor app's connection-listing tool can list your connections. Manage connections through **Connections** in the dashboard; Executor exposes no MCP tools to create, edit, or revoke them.

## Example

After copying a connection's ID from **Connections** (for example, a connection configured with **Read-only tools** and event selections cleared for an app that declares events), add it to Claude Code on Executor Cloud with browser approvals preselected:

```bash
CONNECTION_ID="replace-with-your-connection-id"
claude mcp add --transport http executor-readonly \
  "https://mcp.executor.sh/mcp?connection=${CONNECTION_ID}&elicitation_mode=browser"
```

After approving in your browser, check `Scoped connection: <name>` under **Connected agents** and ask that same MCP client to run `search` to verify it sees only the expected tools and excludes a known disallowed tool.

## Limits

- **Connection name length:** 1 to 80 characters, requiring at least one non-whitespace character.
- **No PATs or local API key at connection URLs:** Personal access tokens (which act with the user's current permissions in their authorized organization) and the local server API key are refused at `/mcp?connection=<id>` instead of falling back to unscoped access. Use OAuth for scoped connections.
- **No Connected agents list on Local:** Local Executor supports creating, editing, and revoking scoped connections, but only Self-host and Cloud display the per-client **Connected agents** section.
- **Dashboard management only:** Executor exposes no MCP tools to create, edit, or revoke scoped connections.
- **Retained client state on Self-host:** Self-host retains state for up to 512 MCP clients per server and 256 per user by default, counting OAuth grants and personal access tokens in use, and can evict idle client state. Configure these limits with `EXECUTOR_MCP_CLIENTS` and `EXECUTOR_MCP_CLIENTS_PER_USER`.

## Related

- [The MCP endpoint](/docs/mcp)
- [Approval and elicitation modes](/docs/mcp/approval-modes)
- [MCP events](/docs/mcp/events)
- [Add an MCP client](/docs/mcp-clients)
- [Personal access tokens](/docs/api-keys)
