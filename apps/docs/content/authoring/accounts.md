---
title: Accounts and providers
description: "Declare providers, user and app account requirements, credential placements, account health checks, and setup help in an Executor app."
slug: "/build/accounts"
---

An Executor app requests credentials with `defineProvider` and lists requirements under `user.accounts` or `app.accounts` in `defineApp`. Providers declare `secrets` or `oauth2` methods, allowed `hosts`, outbound `request` placements, a `health` check, and Markdown setup help (`guide`, `clientGuide`, field `description`). This works on **Local**, **Self-host**, and **Cloud**.

Declare a host allowlist and explicit `request` placements. Compatible app builds receive opaque handles for eligible secret strings when the resolved provider has an allowlist.

**Prerequisites and permissions:** a deployable app ([Build an app](/docs/build)). On **Cloud** and **Self-host**, members with app use access can maintain their own links under the connection policy. Linking an account for everyone requires app management.

**You'll know it worked when…** connecting an account on the **Accounts** tab passes your `health` check and a tool call reaches the upstream API.

## How to use it

The provider code is the same across **Local**, **Self-host**, and **Cloud**.

### 1. Define a provider with `hosts` and `request`

Call `defineProvider({ name, hosts, auth, health })`:

- **`auth`** maps method names to `secrets({ label, guide?, fields, request? })` or `oauth2({ ..., clientGuide?, request? })`.
- **`hosts`** declares the host allowlist (exact hostnames, optional explicit ports, or single-level wildcards such as `["api.linear.app"]`). In compatible app builds, when the resolved provider has a host allowlist, eligible secret strings reach app code as opaque `exsec_` or `exsec2_` handles. The fetch proxy substitutes a recognized handle only after checking the issuing app, the effective allowed destination, and the handle's one-hour expiry. The saved account grant can narrow allowed hosts or keep them when a redeploy omits the declaration. Adding a host can require reconnecting the existing account.
- **`request`** constrains where the proxy inserts a placed secret using `bearer(token)`, `basic(user, pass)`, `header(name, value)`, `query(name, value)`, `base64(value)`, and the `t` template helper. Call `account.headers()` or `account.url(baseUrl)` inside your tools to render the declared placements. Placed handles require HTTPS (except permitted loopback HTTP), and the proxy handles credential-bearing redirects manually.
- Non-string primitives and fields marked `plain(string())` (non-secret config such as a base URL or workspace subdomain) or `raw(string())` (a secret app code must inspect directly, such as an HMAC signing key) reach app code as readable values. Older protocols can also receive ordinary fields directly. Instance-managed OAuth uses separate sealing and supplies its own configured header and host limits.

### 2. Declare `user` vs `app` requirements

Pass requirements as the first argument to `defineApp`:

- **`user: { accounts: { github } }`** — each caller links their own account, read at `ctx.user.accounts.github`. The caller's own opaque identity is `ctx.user.id` (see [Caller identity](#caller-identity)).
- **`app: { accounts: { service } }`** — an app manager links one shared account for the whole app, read at `ctx.app.accounts.service`. App-scoped schedules and app-account webhooks run without a user and use `app.accounts`.
- **`provider.many()`** — lets a caller link zero or more accounts of the same provider (for example multiple workspaces). In an async `defineApp` factory, combine them with `tools: await accountRouter(ctx.user?.accounts.linear ?? [], discover, { signal: ctx.signal })`, where `discover(account)` returns that account's router. Same-name tools are merged and accept `{ accountId, input }`. No linked accounts means no tools.

### Caller identity

`ctx.user.id` identifies the caller in the host product. It is an opaque value that stays the same across that person's calls, including calls to apps with no account requirements. It is independent of `ctx.user.accounts` and of the accounts linked for everyone under `app`.

Use the ID to attribute app records or enforce per-user limits. It is not an account ID or an app owner, and grants no permissions. The host supplies it after authentication; tool input cannot choose another caller.

In a factory, use `ctx.user?.id`: app-scoped background work evaluates the factory without `ctx.user`. App-scoped handlers and workflow steps also have no `ctx.user`. A host without user identities may leave `ctx.user.id` undefined even in user scope; require an ID before relying on per-user attribution.

The app database and `ctx.cache` are shared by callers. Include the caller ID in cache keys and filter stored rows when their contents belong to one caller.

### 3. Add a `health` check

Add `health: async ({ account, fetch, signal, deadline }) => { ... }` to `defineProvider`. Make one safe authenticated read (never a write) that proves the account works. Returning marks the check healthy; throwing `ProviderError` or a status failure from `decodeJson` helps the connect form distinguish rejected credentials, insufficient access, and upstream failures. Keep secrets out of authored error messages. For MCP servers, use `mcpHealth` from `apps/mcp`.

### 4. Write setup help

Add setup help alongside the provider's account fields and authorization methods.

- Put per-field instructions in top-level field options (`string({ title: "...", description: "..." })`), where `description` is Markdown.
- Add `guide` on a `secrets` method for ordered setup steps, prerequisites, or warnings shown above the form.
- Add `clientGuide` on an `oauth2` method for manual OAuth client entry. In browser redirect flows, Executor displays **Redirect URL** above your `clientGuide` (client-credentials flows show `clientGuide` without a redirect URL).

## Example

Save this as `index.ts` beside the pinned `package.json` from [Build an app](/docs/build), deploy the app, and connect a Linear personal API key that has access to the `viewer` query. Linear's GraphQL API expects `Authorization: <API_KEY>` (without a `Bearer` prefix) for personal API keys.

```ts index.ts
import {
  decodeJson,
  defineApp,
  defineProvider,
  header,
  object,
  plain,
  ProviderError,
  query,
  router,
  secrets,
  string,
  type QueryContext,
} from "apps";

const linear = defineProvider({
  name: "Linear",
  hosts: ["api.linear.app"],
  auth: {
    apiKey: secrets({
      label: "Personal API key",
      guide: `
        1. Open [Linear Security & access](https://linear.app/settings/account/security).
        2. Create a personal API key and paste it below.
      `,
      fields: object({
        apiKey: string({ description: "Personal API key starting with `lin_api_`." }),
        teamKey: plain(
          string({ description: "Optional default team key, such as `ENG`." }),
        ).optional(),
      }),
      request: ({ apiKey }) => [header("Authorization", apiKey)],
    }),
  },
  health: async ({ account, fetch, signal }) => {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        ...account.headers(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "{ viewer { id } }" }),
      signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError({
        reason: res.status === 401 ? "unauthorized" : "rejected",
        status: res.status,
      });
    }
    if (!res.ok) {
      throw new ProviderError({ reason: "unavailable", status: res.status });
    }
    await decodeJson(res, object({ data: object({ viewer: object({ id: string() }) }) }));
  },
});

const requirements = { user: { accounts: { linear } } };

const viewer = query(
  {
    description: "Return the signed-in Linear viewer",
    input: object({}),
    output: object({ id: string(), name: string() }),
  },
  async ({ fetch, signal, user }: QueryContext<typeof requirements>) => {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        ...user.accounts.linear.headers(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "{ viewer { id name } }" }),
      signal,
    });
    const body = await decodeJson(
      res,
      object({ data: object({ viewer: object({ id: string(), name: string() }) }) }),
    );
    return body.data.viewer;
  },
);

export default defineApp(requirements, { tools: router({ viewer }) });
```

## Limits

- **Setup help limits:** `guide` and `clientGuide` allow at most 4,000 characters, and each visible top-level account-field `description` allows at most 1,000 characters. Links must be absolute `https:` URLs; HTML tags and Markdown images are rejected. Common leading indentation is stripped automatically.
- **Request body inspection and response masking:** outbound JSON, form, and text request bodies are inspected up to 1 MiB; larger or unsupported bodies pass through without credential substitution. After substitution, the fetch proxy masks matching credential values in response headers and supported text, JSON, or form bodies up to 1 MiB; event streams, oversized or unsupported bodies, and unrecognized transformations can pass through. Ordinary `fetch` follows the deployment's own network policy, and ordinary transport failures become `NetworkUnreachable`. Place credentials in declared headers or query parameters via `request`, and choose upstream hosts you trust.
- **Health check deadline:** Executor passes a `deadline` timestamp on `AccountCheckContext`. Pass `signal` to every `fetch` call and return or throw before `deadline` to supply your own result; otherwise Executor may report a timeout.
- **Account ownership and isolation:** on **Cloud** and **Self-host**, personal account management checks who connected the account, including for admins. An app-wide `app.accounts` link lets authorized callers use the shared account through app tools.

## Related

- [Build an app](/docs/build)
- [Import MCP, OpenAPI, and GraphQL](/docs/build/import)
- [Connect an account](/docs/connect-an-account)
- [Providers and accounts](/docs/concepts/providers-and-accounts)
