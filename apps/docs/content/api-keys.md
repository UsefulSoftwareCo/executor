---
title: API keys
description: "Create a personal access token for a script or agent. Tokens use your current permissions and can be expired or revoked independently."
---

## Personal access tokens

Executor API keys are personal access tokens (PATs), available on **Cloud** and **Self-host**. Local Executor has no user accounts or organizations and uses its installation's Local server key instead.

A token authenticates as you and uses your current permissions and membership in the organization targeted by each request. Tokens have no permission or tool-selection settings of their own. To limit what an agent reaches, connect it through a [scoped connection](/docs/mcp-clients#scoped-connections) instead.

**Prerequisites:** You must be signed in to Executor in a browser to create or revoke tokens. For requests, the token must be active and able to access the target organization.

Tokens belong to your account, not to an organization. They live under **Account settings → Tokens** (`/account/tokens`), reached from your avatar menu, and the same list shows every token you own across all your organizations.

1. Open **Account settings → Tokens** and select **Create token**.
2. Enter **Name**, choose **Scope** (one organization or **Full account**), and set **Expiry (optional)** if needed.
3. Select **Create token**, then **Copy token**. Save it in your script's secret manager. Executor shows the value once.

To verify the token, run the [inventory request](/docs/api-keys#use-a-token) below. Look for HTTP 200 with the available apps, accounts, and links.

A token limited to one organization only works there. Requests that target another organization return `403`, even if you belong to it. A **Full account** token works in every organization you belong to, including ones you join later, when you select the organization on each request. Choose the narrowest option the script needs. The organization cannot be changed after creation; create a new token instead.

Use a separate token for each script so you can revoke access independently. Keep tokens out of browser code and source control.

## Use a token

Each organization's **Connections** page has a **Personal access token** tab with the MCP and HTTP addresses for that organization. Set `EXECUTOR_API_ORIGIN` to `https://api.executor.sh` on Cloud or your deployment's origin on Self-host, set `ORG_ID` to your organization ID, and set `EXECUTOR_API_KEY` to your active token:

```sh
curl -i "$EXECUTOR_API_ORIGIN/api/organizations/$ORG_ID/inventory" \
  --header "Authorization: Bearer $EXECUTOR_API_KEY"
```

A successful request returns HTTP 200 and JSON with `apps`, `accounts`, `links`, `appLinks`, and `accountSetup`.

A **Full account** token can access your other organizations. Each request checks your current membership and role. Changing the organization URL does not grant access to an organization you do not belong to.

For `GET /api/context`, send `X-Executor-Organization: <organization-id-or-slug>` when authenticating with a **Full account** token:

```sh
curl "$EXECUTOR_API_ORIGIN/api/context" \
  --header "Authorization: Bearer $EXECUTOR_API_KEY" \
  --header "X-Executor-Organization: $ORG_ID"
```

A token pinned to one organization can omit the `X-Executor-Organization` header. Invalid, expired, or revoked tokens return `401`. Insufficient access returns `403`.

## Expiry and revocation

Signing out does not revoke tokens. Removing an organization membership deletes tokens pinned to that organization (subsequent requests return `401`) and stops **Full account** tokens from accessing that organization (`403`, while remaining usable in other organizations you belong to). Role changes apply to subsequent requests.

To replace a token, create another, update your script, then revoke the old one. Revocation blocks later requests using that token. Requests already running may finish.

The saved Executor app credential uses the same key system and appears as **Executor app (created automatically)** (with the badge **In use by the Executor app** where applicable). Executor can issue a replacement for an eligible automatically managed key after an upstream HTTP `401` if the old key record is absent and the recorded default app, linked account, and credential generation still match. Retry the failed call after renewal.

## Connect an MCP client

Use your PAT as the bearer token. The organization URL names where calls run:

```json
{
  "mcpServers": {
    "executor": {
      "type": "http",
      "url": "https://mcp.executor.sh/org/<organization-id-or-slug>/mcp",
      "headers": { "Authorization": "Bearer <YOUR_PAT>" }
    }
  }
}
```

The **Connections** page fills in your server URL and the organization you are viewing, and links to your tokens with that organization preselected. For Self-host, use your own origin. Keep the token in your client's private config or secret store.

A token limited to one organization also works on the bare `/mcp` URL with no extra configuration. A **Full account** token on `/mcp` must select the organization with an `X-Executor-Organization` header. A token limited to one organization is rejected on any other organization's URL.

The same token works with automatic, model, native, and browser approval delivery:

- The plain MCP URL defaults to **automatic** mode, which accepts app approval requests without a separate Executor prompt (explicit app denials still block the call). Your client may have its own permission prompts, though Executor cannot verify whether one was shown.
- Add `?elicitation_mode=browser` to answer in the token owner's signed-in Executor browser.
- With `?elicitation_mode=model`, Executor accepts the decision from the client.
- With `?elicitation_mode=native`, a compatible client handles approval forms for `execute`. Direct `call` uses the client-approved path. Executor cannot verify whether the client asked for confirmation.

Revocation or expiry stops new MCP calls and continuations, including on already-connected clients.

PATs do not require an OAuth sign-in flow. The existing [browser OAuth flow](/docs/mcp-clients) remains available. PATs do not create browser sessions; manage them from your signed-in browser. PATs and OAuth both check current organization membership and role. Scoped OAuth connections also enforce their current app, tool, and account policy.

## Related

- [Add an MCP client](/docs/mcp-clients)
- [Scoped connections](/docs/mcp-clients#scoped-connections)
- [Tools and approvals](/docs/concepts/tools-and-approvals)
- [Activity and tool call log](/docs/activity)
- [Account settings](/docs/account)
