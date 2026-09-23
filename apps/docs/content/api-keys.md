---
title: API keys
description: "Create a personal access token for a script or agent. Tokens use your current permissions and can be expired or revoked independently."
---

## Personal access tokens

Executor API keys are personal access tokens (PATs). A token authenticates as you
and uses your current permissions in the organization targeted by each request.
There are no extra permission or tool-selection settings for tokens in v1.

1. Open **API keys** and select **Create token**.
2. Give the token a name.
3. Choose an organization, or **Full account**.
4. Optionally set an expiry.
5. Copy the token into your script's secret manager. It is shown only once.

A token limited to one organization only works there. Requests that target another
organization return `403`, even if you belong to it. A full-account token works in
every organization you belong to, including ones you join later. Choose the
narrowest option the script needs. The organization cannot be changed after creation;
create a new token instead.

Use a separate token for each script so you can revoke access independently.
Keep tokens out of browser code and source control.

## Use a token

The page provides an example for the organization you are viewing:

```sh
curl '<your-origin>/api/organizations/<organization-id>/inventory' \
  --header "Authorization: Bearer $EXECUTOR_API_KEY"
```

A full-account token can access your other organizations. Each request checks your
current membership and role. Changing the organization URL does not grant access
to an organization you do not belong to. Tool approval rules still apply.

For `GET /api/context`, pass `?organization=<organization-id-or-slug>` instead. A token
limited to one organization can omit it.
Invalid, expired, or revoked tokens return `401`. Insufficient access returns `403`.

## Expiry and revocation

Signing out does not revoke tokens. Removing an organization membership stops
access to that organization, and role changes apply to subsequent requests.

To replace a token, create another, update your script, then revoke the old one.
Revocation prevents new requests. Requests already running may finish. Revoking
one token does not affect other tokens. The saved Executor app credential uses
the same key system and appears as **Executor app**. Revoking that key also stops
the saved connection. Revoked tokens are removed from the list.

## Connect an MCP client

Use your PAT as the bearer token. The organization URL names where calls run:

```json
{
  "mcpServers": {
    "executor": {
      "type": "http",
      "url": "https://v2.executor.sh/org/<organization-id-or-slug>/mcp",
      "headers": { "Authorization": "Bearer <YOUR_PAT>" }
    }
  }
}
```

The **API keys** page fills in your server URL and current organization. For
self-host, use your own origin. Keep the token in your client's private config
or secret store.

A token limited to one organization also works on the bare `/mcp` URL with no
extra configuration. A full-account token on `/mcp` must say which organization
to use with an `X-Executor-Organization` header. A token limited to one
organization is rejected on any other organization's URL.

The same token works with model, native, and browser approval delivery. Add
`?elicitation_mode=native` or `?elicitation_mode=browser` to the MCP URL when
needed. Tool approval rules still apply. Browser approvals require the token
owner to sign in. Revocation or expiry stops new MCP calls and continuations,
including on already-connected clients.

PATs do not require an OAuth sign-in flow. The existing [browser OAuth flow](/mcp-clients)
remains available. PATs do not create browser sessions; manage them from your
signed-in browser. Both methods use the same authorization checks and current
organization roles.
