---
title: How Executor protects credentials
description: "Learn where Executor stores credentials, how to enter them through browser connection links, and when app code receives an opaque credential handle."
---

Executor encrypts saved account fields at rest with **AES-256-GCM**, uses browser **connection links** so users can enter secrets or finish OAuth outside chat, and — on compatible app builds when a resolved provider has a host allowlist — issues short-lived opaque **credential handles** (`exsec_..._` or `exsec2_..._`) for eligible secret string fields.

Applies to **Local** (including Desktop running Local), **Self-host**, and **Cloud**, with per-target storage and key rules below. Desktop signed into a hosted server follows that server's rules, with its own sign-in storage.

**Prerequisites:** On current app builds, declare `hosts` on `defineProvider` and use `request` placement for credentials sent through `fetch`. Redeploy older app builds with a current framework before relying on credential handles.

**You'll know it worked when:** In the Local example below, the eligible token field becomes an opaque `exsec2_..._` handle. The loopback service receives the expected authorization header. Sending the handle to the undeclared host returns `NetworkRefused` (`refusal.reason: "credential_host"`).

## Credential storage

Every Executor target encrypts saved account fields with **AES-256-GCM**, a 64-hex-character (32-byte) key, and a fresh 12-byte random nonce on every write, binding each record to its account ID as additional authenticated data. OAuth client records bind their own identity the same way.

| Target | Where encrypted account records live | Where the encryption key (`EXECUTOR_ENCRYPTION_KEY`) lives |
| --- | --- | --- |
| **Local / Desktop Local** | Embedded PGlite database at `EXECUTOR_DATA_DIR/executor.pglite`. Desktop and CLI share `~/.executor/v2/cli` by default; Desktop can override its directory. | A new directory tries the OS credential store (macOS Keychain, Windows Credential Manager, or Linux Secret Service). File mode (`EXECUTOR_KEY_STORAGE=file`), or an absent store without `EXECUTOR_KEY_STORAGE=os`, uses `keys.json` (POSIX `0600`). A denied or locked store can stop startup. Initialized directories keep their key source. Supply `EXECUTOR_API_KEY` and `EXECUTOR_ENCRYPTION_KEY` together: server startup leaves supplied keys in their original source, while saving them through background service settings writes them to `service.json`. |
| **Self-host** | In the released Docker image, the live product database lives in `/app/data/product`. Persist and back up the entire `/app/data` volume and original key. The source-run server uses `hosted.pglite`. | Read from `EXECUTOR_ENCRYPTION_KEY` (64 hex characters) if set, or generated on first start and saved to `encryption.key` (POSIX `0600`). |
| **Cloud** | Cloud product PostgreSQL database. | Supplied to the server through the `EXECUTOR_ENCRYPTION_KEY` secret. |

When Desktop or the CLI signs into a hosted server, Desktop stores refresh tokens in Electron safe storage (with a warned Linux `basic_text` fallback or sign-in refusal if storage fails), and the CLI can fall back to files under `~/.local/state/executor/auth` if writing to an OS store fails.

Copying an app between Local, Self-host, and Cloud copies its source, not its connected accounts or credentials. Connect accounts on the destination target.

## How secrets reach services

On compatible app builds, when the resolved provider has a host allowlist, Executor provides opaque `exsec_..._` or `exsec2_..._` handles for eligible secret string fields:

- **What is sealed and what stays readable:** For ordinary accounts, fields wrapped in `plain(...)`, `raw(...)`, and non-string primitive values remain readable to app code. Older app protocols can receive ordinary account fields directly. Managed OAuth uses separate sealing with its configured header and host limits.
- **Effective host allowlist:** The saved account grant can narrow allowed hosts or keep previous grants when a redeploy omits `hosts`.
- **Proxy handle checks:** For recognized handles, the outbound fetch proxy checks the issuing app (`credential_app`), allowed destination (`credential_host` — exact host, optional `:port`, or single-level wildcard such as `*.example.com`), and one-hour expiry (`credential_expired`) using the handle's saved data.
- **Placement and transport rules:** Request helpers (`bearer(...)`, `basic(...)`, `header(...)`, `query(...)`) constrain where the proxy inserts a placed secret (`credential_placement`). Placed handles require **HTTPS** (`credential_transport`), with a loopback HTTP exception when the host allows private addresses. `TRACE` requests with recognized handles are refused (`credential_method`). The proxy handles credential-bearing redirects manually (`redirect: "manual"`) without automatic credential forwarding. Ordinary `fetch` requests — and destination checks before opening handles — follow the deployment's own network policy.
- **Bounded response masking:** After substituting a credential on a request, the proxy masks matching values in response headers and in supported text, JSON, and `application/x-www-form-urlencoded` bodies up to **1 MiB** (`1,048,576` bytes). This is pattern-based protection: event streams (`text/event-stream`), oversized or unsupported bodies, and transformed values can pass through. Ordinary transport failures normally surface as `NetworkUnreachable`.

## Agents and MCP access

- **Browser connection links:** When an agent needs an account connected or reconnected, it calls `appAccounts.userConnect` or `appAccounts.appConnect` on Local, Self-host, or Cloud and gives you the complete returned URL. On Local, that URL points to `/account-connect/<con_id>` with a signed fragment; on Self-host and Cloud, it opens `/org/<slug>/connections/<con_id>`. Open the link in your browser to enter secrets or finish OAuth and keep secrets out of chat. Pending links expire after **30 minutes**. Completing an app-specific connection can save and link the account together if the requirement and access checks still pass.
- **Bounded API metadata vs. app output:** The account, connection status (`accounts.connection` on Hosted, `accountConnections.get` on Local), and OAuth client management APIs return status and metadata and omit saved secret fields and OAuth tokens. Apps using sealed credentials see opaque values for sealed fields, while app tool output is controlled by the app's code and can return any values the app can read. Use apps you trust.
- **PATs vs. scoped MCP connections:** On Hosted, [personal access tokens](/docs/api-keys) act with your current permissions and organization membership, can be pinned to one organization, can expire, and can be revoked independently. A [scoped MCP connection](/docs/mcp-clients#scoped-connections) uses OAuth and enforces its current app, tool, and account policy; PATs and Local server keys are refused at scoped URLs. Revoking an OAuth grant or connection blocks subsequent requests using it.
- **Read-only tools and events:** **Read-only tools** filters tools by classification. Event access is separate and defaults to **All events** for an enabled app, including future events. With the draft `2026-07-28` MCP protocol, clients can subscribe to allowed app events; delivery checks active subscriptions and current authority (Hosted checks membership and access to recorded accounts; Local OAuth checks grant scope; Local API-key delivery uses installation-admin authority).

## Team visibility (Self-host and Cloud)

- **Apps and source:** An app's audience controls who can use its tools. Its creator and organization admins and owners can manage it and read its private source and Git history; sharing tool access alone leaves source under manage permissions.
- **Personal vs. app-wide accounts:** Personal account management checks who connected the account, including for admins. An app-wide link lets authorized callers use that account through the app's tools without granting direct management access to the account.
- **Groups and Activity:** In **Groups**, regular members see only the groups they belong to and those groups' rosters; admins and owners see all groups. In **Activity**, admins and owners see organization-wide call metadata and members see their own; other members' personal account labels appear as `Personal account`. Activity omits tool arguments and outputs (pending tool approvals are stored separately) and shows the past 30 days with periodic pruning.

## Example

This Local example verifies one authorized request to a loopback upstream (permitted by the Local loopback HTTP exception; use a reachable HTTPS upstream on Hosted) and one refused request to an undeclared host.

1. Start a synthetic loopback upstream on `127.0.0.1:18080` that checks `Authorization` without echoing the secret back:

```js
// upstream.mjs — run with: node upstream.mjs
import http from "node:http";
const expected = "Basic " + Buffer.from("demo@example.test:synthetic-token").toString("base64");
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ authorized: req.headers.authorization === expected }));
}).listen(18080, "127.0.0.1");
```

2. Create `package.json` (pinning the `apps` package version) and `index.ts`:

```json
{
  "dependencies": {
    "apps": "0.0.1-beta.148"
  }
}
```

```ts
import {
  base64,
  defineApp,
  defineProvider,
  header,
  object,
  plain,
  query,
  router,
  secrets,
  string,
  t,
} from "apps";

const service = defineProvider({
  name: "Example API",
  hosts: ["127.0.0.1:18080"],
  auth: {
    key: secrets({
      label: "API token",
      fields: object({
        email: plain(string()),
        token: string(),
      }),
      request: ({ email, token }) =>
        header("authorization", t`Basic ${base64(t`${email}:${token}`)}`),
    }),
  },
});

export default defineApp({ user: { accounts: { service } } }, {
  tools: router({
    me: query({ input: object({}) }, async ({ user: { accounts } }) => {
      const response = await fetch("http://127.0.0.1:18080/v1/me", {
        headers: accounts.service.headers(),
      });
      return {
        handlePrefix: accounts.service.fields.token.slice(0, 7),
        email: accounts.service.fields.email,
        upstream: await response.json(),
      };
    }),
    wrongHost: query({ input: object({}) }, async ({ user: { accounts } }) => {
      const response = await fetch("https://example.invalid/v1/me", {
        headers: accounts.service.headers(),
      });
      return await response.text();
    }),
  }),
});
```

3. Deploy the app to Local, connect the `service` account via the dashboard or `appAccounts.userConnect` (with `email: "demo@example.test"` and `token: "synthetic-token"`), confirm `connection.state.status === "completed"` via `accountConnections.get`, then run both tools:

- Calling `me` returns `{ handlePrefix: "exsec2_", email: "demo@example.test", upstream: { authorized: true } }`: app code saw `email` directly (`plain(...)`) and only an `exsec2_..._` handle for `token`, while the proxy attached the real Basic header to `127.0.0.1:18080`.
- Calling `wrongHost` returns the proxy's `NetworkRefused` JSON payload (`refusal.reason: "credential_host"`, naming `example.invalid` and `allowedHosts: ["127.0.0.1:18080"]`) instead of forwarding the credential.

## Limits

- **Unsealed fields and protocols:** Providers without a resolved host allowlist, `plain(...)` and `raw(...)` fields, non-string primitives, and older app protocols pass values directly to app code.
- **Handle lifetime and scope:** Recognized handles expire after **1 hour**, are bound to their issuing app (`credential_app`), and validate against the handle's saved data when opened.
- **Response masking boundaries:** Body masking covers matching patterns in text, JSON, and form bodies up to **1 MiB** (`1,048,576` bytes); event streams, oversized or unsupported bodies, and transformed values are outside body protection.
- **Connection links:** Pending browser links expire after **30 minutes** and fail if the target requirement changed before submission (`AccountConnectionTargetChanged`).
- **Fixed Local key source:** After a Local data directory is initialized, Executor keeps its configured key source (OS credential store vs. `keys.json`).

## Related

- [Providers and accounts](/docs/concepts/providers-and-accounts)
- [Connect an account](/docs/connect-an-account)
- [Organizations and access](/docs/concepts/organizations-and-access)
- [Activity and tool call log](/docs/activity)
- [Author an app](/docs/author-an-app)
