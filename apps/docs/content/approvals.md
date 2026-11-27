---
title: Approvals
description: "Review and approve pending scheduled runs on the Approvals page and answer browser MCP tool approval or input requests on /mcp/approve/."
---

Review paused per-user schedules on the dashboard's **Approvals** page. When an MCP connection uses **In your browser** mode, open the request's `approvalUrl` to review a tool call or enter form input. Both flows are available on **Local**, **Self-host**, and **Cloud**.

MCP tool approval requests and scheduled browser reviews each expire after 15 minutes.

**MCP browser requests** need the credential owner's hosted browser session or a paired Local browser. **Scheduled browser reviews** need a browser session authorized to review the run. On **Cloud** and **Self-host**, the scheduled actor or a permitted app manager can review it when they have current access to the app and the invocation accounts.

**You'll know it worked when…** a scheduled review shows **Your response was saved** or an MCP review shows **Response saved**. Approved scheduled runs continue in the background.

## How to use it

### Scheduled runs on the Approvals page

Per-user schedules (`userCron` or `userInterval`) default to **Skip approvals**, which accepts approval requests using the schedule's authorized access while still honoring explicit denials from an app's rule. To review a per-user schedule's approvals in the browser, select **Browser approvals** under its approval setting on the app's **Schedules** tab. When its mutation asks for approval, the run pauses and appears on **Approvals**:

- **Local:** open **Approvals** in the sidebar (`/approvals`) in a paired browser. Pending runs list the app name, run name, and `"Expires <time>"`. Click **Review** to open `/approvals/<runId>`, inspect the tool name and saved arguments under **Review tool request**, and click **Approve**, **Decline**, or **Cancel**. Click **Back to approvals** when finished.
- **Cloud and Self-host:** open **Approvals** in your organization sidebar (`/org/<slug>/approvals`). Click **Review** on any pending run (`/org/<slug>/approvals/<runId>`), review the saved arguments, and click **Approve**, **Decline**, or **Cancel**.

When no runs are waiting, the page shows **No approvals waiting** (`"Scheduled runs that need your review will appear here."`).

### Browser approvals and input forms for MCP clients

When an MCP client connects in **In your browser** mode (`elicitation_mode=browser`; see [Choosing where approvals appear](/docs/mcp-clients#choosing-where-approvals-appear)), a tool call that pauses for approval (`approval-required`, ID prefix `apr_`) or mid-tool form input (`input-required`, ID prefix `elc_`) returns an `approvalUrl` pointing to `/mcp/approve/<requestId>?sessionId=<sessionId>&grantId=<grantId>` on the Executor **dashboard origin** (for example `https://app.executor.sh` on Cloud, even when your MCP client connects to `https://mcp.executor.sh`).

1. Open the `approvalUrl` in the credential owner's browser session on **Cloud** or **Self-host**, or in a paired dashboard browser on **Local**.
2. For an approval request (**Review tool request**), inspect the app name, tool name, and saved arguments, then click **Approve**, **Decline**, or **Cancel**.
3. For a mid-tool input form (**Input requested**), read the prompt, enter the requested values, and click **Submit**, **Decline**, or **Cancel**.
4. Return to the originating MCP client and connection so it can call `resume({ requestId })` to collect your recorded browser answer.

### Approvals started from the Tools tab

When you run a tool manually from an app's **Tools** tab in the dashboard, Executor shows a before-run approval prompt right on that tab rather than on **Approvals**. On **Cloud** and **Self-host**, only the user who started that run can answer it. On **Local**, use a paired dashboard browser.

## Example

First connect an MCP client in **In your browser** mode ([Choosing where approvals appear](/docs/mcp-clients#choosing-where-approvals-appear)). When a call pauses on a tool that asks for approval (such as `deleteArchive` from [Input prompts and tool approvals](/docs/build/input-and-approvals)), the response includes the saved invocation, consent preview, expiry, request ID (`apr_` for approvals, `elc_` for mid-tool forms), and `approvalUrl` (synthetic excerpt):

```json
{
  "status": "approval-required",
  "requestId": "apr_example",
  "invocation": {
    "app": "app_example",
    "version": "dpl_example",
    "tool": "deleteArchive",
    "input": { "archiveId": "arch-1" }
  },
  "elicitation": {
    "mode": "form",
    "message": "Approve deleteArchive?",
    "requestedSchema": { "type": "object", "properties": {} }
  },
  "expiresAt": 1795630000000,
  "approvalUrl": "https://app.executor.sh/mcp/approve/apr_example?sessionId=sess_example&grantId=grant_example"
}
```

Open `approvalUrl` as described above and approve the saved invocation. Return to the originating MCP session to call `resume({ requestId: "apr_example" })`. For a browser-mode request started by the CLI, run `executor resume "$REQUEST_ID"` with the same CLI target and sign-in.

## Limits

- **Browser answer endpoints:** the POST must come from an authorized browser context with an accepted origin. A missing valid session can return HTTP `401`. A bearer authorization header or a disallowed origin can return HTTP `403`. For approval delivery outside the browser, see [Choosing where approvals appear](/docs/mcp-clients#choosing-where-approvals-appear).
- **Saved-version resume:** a paused MCP call can resume on its saved, retained version after a new deploy. Executor rechecks the saved invocation and applicable access.
- **Pending scheduled reviews:** a per-user schedule in **Browser approvals** mode holds its active run slot while a request is pending.
- **Saved invocation:** an answer applies to the saved call. Separate calls evaluate their own approval rules.
- **Declined tool approvals:** declining or cancelling a before-run approval prevents the tool call from running. An unhandled tool failure can end the program. Earlier external effects remain in place.

## Related

- [Input prompts and tool approvals](/docs/build/input-and-approvals)
- [Tools and approvals](/docs/concepts/tools-and-approvals)
- [Connect MCP clients](/docs/mcp-clients)
- [Organizations and access](/docs/concepts/organizations-and-access)
