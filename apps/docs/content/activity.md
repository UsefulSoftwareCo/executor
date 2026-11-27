---
title: Activity and tool call log
description: "Inspect tool calls across your organization on the Activity page, filter by member, app, status, agent, or connection, and look up failed calls by reference."
---

The **Activity** page (`/org/<slug>/activity`) records tool calls made through Executor over the last 30 days, showing which tool ran, who or what called it, which account it used, whether it succeeded, and how long it took. Open **Activity** in the sidebar to filter calls or paste a `call_...` reference into the search box (`Search or paste a reference`).

Available on **Self-host** and **Cloud** with identical steps. Local Executor does not have an Activity page.

**Prerequisites:** Any signed-in member of the organization can open **Activity**, but visibility depends on your role:

- **Owners and admins** see every logged tool call across the organization and can filter by **Member**.
- **Members** see only their own tool calls, do not see the **Member** filter, and see `An app you can no longer use` in place of the app name (the tool name still appears on visible rows) for any app they no longer have access to.
- **Personal account privacy:** Even owners and admins do not see another member's personal account labels in Activity. Other members' personal accounts appear only as `Personal account`; only your own personal accounts show their saved labels.
- **Metadata only:** Activity stores call metadata (tool, app, version, caller, source, connection, status, error type, HTTP status code, approval decision, timing, and call reference). It omits tool input arguments, tool outputs, and credentials. Pending tool approvals are kept in a separate store.

**You'll know it worked when:** The summary line above the table updates with the matching count (for example `12 tool calls in the last 7 days` or `1 tool call with this reference`), and clicking a row expands its full detail panel with **Reference**, **Started**, **Duration**, and any **Approval** or **Failure** details.

## Filter and search tool calls

1. Open **Activity** (`/org/<slug>/activity`) from the sidebar. By default, Executor shows calls from the **Last 7 days**, newest first.
2. Type in **Search or paste a reference** to match tool names, visible app names, caller names, agent or API key names, or your own account labels.
3. Click **Filters** to narrow the list by:
   - **Member** (owners and admins only; default **All members**)
   - **App** (**All apps**)
   - **Status** (**All statuses**: **Succeeded**, **Failed**, **Needs approval**, **Denied**, **Expired**)
   - **Agent** (**All agents and keys** — MCP clients, API keys, and other callers)
   - **Connection** (**All connections** — scoped MCP connections)
   - **Time range** (**Last 24 hours**, **Last 7 days**, or **Last 30 days**)
4. Remove an active filter by clicking its chip above the table, or open **Filters → Clear filters**.
5. Click **Load more tool calls** at the bottom of the list to load older pages (50 calls per page).

Each row shows five columns — **Tool** (with a `write` badge on mutations), **Called by** (the member and source: **Agent**, **API key**, **Dashboard**, **Schedule**, **Webhook**, or **Workflow**), **Account**, **Status**, and **Time** (start timestamp and duration). App-initiated calls such as schedules, webhooks, and workflows show `The <app> app, on its own`.

## Inspect a call and pivot to related calls

Click any row to open its detail panel:

- **Called by** and source (**Agent**, **API key**, **Made from**, **Schedule**, **Webhook**, or **Workflow**)
- **Connection** (when called through a scoped MCP connection)
- **Tool** (annotated `Reads only` or `Can make changes`) and **Version**
- **Account** or **Accounts** used by the call
- **Approval** (the decision — **Approved** or **Denied** — or status such as **Waiting for an answer** or **No answer was recorded** with expiry timestamps, plus who decided and when when recorded)
- **Failure** or **Reason** (a plain-language explanation when a call fails or is denied)
- **Reference** (`call_...`) with a **Copy reference** button
- **Started** (exact timestamp) and **Duration**
- **MCP session** and **Run** (for multi-call `execute` runs)

Inside the expanded panel, use the drill-down links — **Show this agent's calls**, **Show this key's calls**, **Show this connection's calls**, **Show this session's calls**, or **Show the run** — to filter directly to related calls.

## Look up a call reference

Logged calls receive a reference shaped like `call_` followed by 14 lowercase characters (`/^call_[0-9a-hjkmnp-tv-z]{14}$/`). If a failed or denied call returns a `call_...` reference, paste it into the search box to inspect that call.

To inspect a quoted reference:

1. Paste the full `call_...` reference into **Search or paste a reference**.
2. Exact references ignore active filters and search across the past 30 days; when filters are active, the page notes `Filters do not apply to a reference.`.
3. If the call exists and your role allows you to see it, Executor displays that single call and expands its detail panel automatically.

## Example

You can query the same log through the organization HTTP API using a [personal access token](/docs/api-keys) that can access this organization. Set `EXECUTOR_API_KEY` to your token, `ORG_ID` to your organization ID, and `EXECUTOR_API_ORIGIN` to `https://api.executor.sh` on Cloud or your deployment's origin on Self-host:

```sh
# List failed calls from the last 24 hours
curl "$EXECUTOR_API_ORIGIN/api/organizations/$ORG_ID/tool-calls?range=24h&status=failed" \
  --header "Authorization: Bearer $EXECUTOR_API_KEY"

# Look up one exact call reference across the past 30 days
# Replace CALL_REF with a call_... reference from a failed call or the list above
curl "$EXECUTOR_API_ORIGIN/api/organizations/$ORG_ID/tool-calls?search=$CALL_REF" \
  --header "Authorization: Bearer $EXECUTOR_API_KEY"
```

The endpoint enforces the same role visibility and 30-day window as the dashboard. For the second command, confirm the response returns the matching call entry.

## Limits

- **30-day window:** Activity shows records from the past 30 days. Executor periodically deletes older records.
- **Pagination and count cap:** The UI loads 50 calls per page (API `limit` allows 1–200). Matching totals are capped at 10,000 (`More than 10,000 tool calls`), search text is capped at 200 characters, and each filter menu lists up to 200 recent choices.
- **Query timeout:** Activity queries have a 5-second database statement timeout. Broad queries can return HTTP `503` (`ToolCallLogBusy`); narrow the time range or add a filter and try again.
- **Reference visibility:** Regular members looking up another member's call reference see `No tool call has this reference`.
- **No payloads in Activity:** Input arguments and tool responses are not stored in the Activity log (pending tool approvals are stored separately).

## Related

- [Tools and approvals](/docs/concepts/tools-and-approvals)
- [Organizations and access](/docs/concepts/organizations-and-access)
- [API keys](/docs/api-keys)
- [Members and roles](/docs/organizations/members)
- [How Executor protects credentials](/docs/security/credentials)
