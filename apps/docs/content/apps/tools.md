---
title: Tools tab
description: "Browse an app's tools, inspect their effect badges and input/output schemas, and run tools directly from the dashboard with Form or JSON input."
---

An app's **Tools** tab lets you browse every tool exposed by the app's active version, inspect its effect badge and schemas, and invoke it directly from the dashboard using **Run tool**. The dashboard uses the same tool runtime as MCP: dashboard calls use the app's linked accounts and review requests inline, while MCP calls also follow the client's grant and approval mode.

- **Available on:** Local, Self-host, and Cloud (Local has its own readiness and reconnect views).
- **Prerequisites:** The app must have an active deployed version, and required accounts must be linked and healthy on the app's **Accounts** tab. On Self-host and Cloud, you must also have access to use the app (see [Share and copy apps](/docs/apps/share-and-copy)).
- **Main UI action:** Open an app → click the **Tools** tab → select a tool → fill **Input** (**Form** or **JSON**) → click **Run tool**.

You'll know it worked when the **Tool result** panel appears below the form with the JSON response and a **Copy result** button (**Call reference** appears when the server includes one).

## Browsing tools and reading schemas

The left sidebar lists every tool organized into collapsible router groups, with a total count and a **Search tools…** box that filters by tool name and description. For grouped tools, use **Collapse all** or **Expand all** with the search cleared.

Selecting a tool opens its detail view on the right:

- **Header:** Shows the app-relative tool name (`<group>.<name>`) with a **Copy name** button, a humanized title, and an effect badge derived from the tool's annotations (explicit `readOnly` wins over `readOnlyHint`; `destructiveHint` applies when the tool is not read-only; unknown effects show no badge):
  - **Only reads data** (`readOnly: true`, or `readOnlyHint: true` when `readOnly` is not set)
  - **Makes changes** (effective read-only value is false and `destructiveHint` is unset or false)
  - **Can delete data** (`destructiveHint: true` when not read-only)
  Effect badges reflect the author's metadata and do not guarantee what an external service will do.
- **Description:** Renders Markdown descriptions; long descriptions collapse with a **Show more** / **Show less** toggle.
- **Inputs** and, when present, **Returns:** Displays the tool's input and output schemas in human-readable form alongside raw JSON Schema.

If the app has not been deployed yet, the tab shows `"Deploy this app to load its tools."`. If a required account is missing, it links to **Accounts**. On Self-host and Cloud, an app with no available tools and no links for a multi-account requirement can show **No accounts linked**. Link required and healthy accounts before running a tool.

## Running a tool

### Local, Self-host, and Cloud

Running a tool from the dashboard follows the same steps on every target:

1. Open the app and select the **Tools** tab.
2. Find and select the tool in the left sidebar.
3. If **Running as** appears under **Input**, check the listed accounts.
4. Enter arguments using either tab:
   - **Form** (default when the input schema is a renderable JSON object): Pre-populates required fields with type defaults and validates required and typed fields inline.
   - **JSON**: Edit raw JSON directly. To switch back to **Form**, enter valid JSON containing an object.
5. Click **Run tool**. While executing, the button shows **Running…**.
6. If the tool's approval rule requires confirmation—or the tool requests extra input—an inline review card appears right below the button (**Review tool request** or **Input requested**). Click **Approve** (or **Submit**), **Decline**, or **Cancel**.

You'll know it worked when **Tool result** renders the returned JSON payload (with **Copy result**). **Call reference** appears when the server includes one.

### Running the same tool from the CLI

Use **Copy name** to identify the tool in the dashboard. Because MCP paths escape reserved segments and use bracket notation for hyphenated slugs (such as `tools["hello-copy"].greet`), run `executor search` and pass the result's exact `path` to `executor call`:

```bash
TOOL_PATH=$(executor search "appManagement.list" | node -e 'const d = JSON.parse(require("node:fs").readFileSync(0, "utf8")); console.log(d.items[0].path);')
executor call "$TOOL_PATH" --input '{}'
```

On Local, make sure no hosted target is configured or remembered. On Cloud or Self-host, sign in first with `executor login` (or `executor login --host "$EXECUTOR_ORIGIN"`) and choose a grant that includes the tool. In the completed response, check that `status` is `"completed"`, `execution.ok` is `true`, and `execution.value.ok` is `true`, then inspect `execution.value.value`.

## Example

Call a read-only tool on the built-in `executor` app directly on Local (with no hosted target selected or remembered):

```bash
executor call tools.executor.appManagement.list --input '{}'
```

Or discover a tool's exact path with `executor search`, inspect its input schema with `executor describe`, and call it with `"$TOOL_PATH"`:

```bash
TOOL_PATH=$(executor search "framework.release" | node -e 'const d = JSON.parse(require("node:fs").readFileSync(0, "utf8")); console.log(d.items[0].path);')
executor describe "$TOOL_PATH"
executor call "$TOOL_PATH" --input '{}'
```

You'll know each call succeeded when the JSON envelope reports `status: "completed"`, `execution.ok: true`, and `execution.value.ok: true`.

## Limits

- **Active version and accounts required:** Tools cannot be listed or run until the app has been deployed at least once and all required accounts are linked and healthy.
- **Account choice is fixed per app:** Just like MCP calls, **Run tool** runs with the accounts linked on the app's **Accounts** tab and does not let you pick a different account per invocation.
- **Non-object schemas use JSON mode:** If a tool's input schema cannot be rendered as a form, the **Form** / **JSON** switcher is hidden and Executor shows the raw JSON editor directly.
- **Inline approval expiry and context checks:** An inline review request expires after 15 minutes. If the saved version or account context is no longer usable, run the tool again to review the new request.
- **Provider errors during runs:** If a tool fails during an initial run or after approval, Executor can warn that the external service may already have made changes—check the target service before retrying.

## Related

- [Apps](/docs/apps)
- [Code mode and tool execution](/docs/mcp/code-mode)
- [Approval and elicitation modes](/docs/mcp/approval-modes)
- [Connect an account](/docs/connect-an-account)
- [Tools and approvals](/docs/concepts/tools-and-approvals)
