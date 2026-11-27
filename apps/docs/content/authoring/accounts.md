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

- **`user: { accounts: { github } }`** — each caller links their own account, read at `ctx.user.accounts.github`.
- **`app: { accounts: { service } }`** — an app manager links one shared account for the whole app, read at `ctx.app.accounts.service`. App-scoped schedules and app-account webhooks run without a user and use `app.accounts`.
- **`provider.many()`** — lets a caller link zero or more accounts of the same provider (for example multiple workspaces). In an async `defineApp` factory, combine them with `tools: await accountRouter(ctx.user?.accounts.linear ?? [], discover, { signal: ctx.signal })`, where `discover(account)` returns that account's router. Same-name tools are merged and accept `{ accountId, input }`. No linked accounts means no tools.

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

## App-owned sign-in

Use `interactive({ label })` when your app must acquire the credential itself.
Examples include a device code, a sign-in with a fixed loopback callback that
the person pastes back, or a backend that keeps the service's rotating tokens.
The same **Connect new account** dialog presents the steps your app returns.

Declare the method on a provider and implement `connect` on the app definition,
keyed by the account requirement's slot. The method declares the label; the
requiring app owns the handlers. These are ordinary async functions:

```ts
import {
  defineApp,
  defineProvider,
  interactive,
  type InteractiveStart,
  type InteractiveStatus,
} from "apps";
import { subscriptionBackend } from "./subscription-backend.ts";

const subscription = defineProvider({
  name: "Example subscription",
  auth: { signIn: interactive({ label: "Sign in" }) },
});

export default defineApp(
  { user: { accounts: { subscription } } },
  {
    connect: {
      subscription: {
        start: async (ctx): Promise<InteractiveStart> =>
          subscriptionBackend.start({ caller: ctx.user.id, signal: ctx.signal }),
        status: async (ctx, { session }): Promise<InteractiveStatus> =>
          subscriptionBackend.status({ caller: ctx.user.id, session, signal: ctx.signal }),
        submit: async (ctx, { session, value }): Promise<InteractiveStatus> =>
          subscriptionBackend.submit({ caller: ctx.user.id, session, value, signal: ctx.signal }),
        cancel: async (ctx, { session }) => {
          await subscriptionBackend.cancel({ caller: ctx.user.id, session, signal: ctx.signal });
        },
        remove: async (ctx, { ref }) => {
          await subscriptionBackend.remove({ caller: ctx.user.id, ref, signal: ctx.signal });
        },
      },
    },
  },
);
```

`subscriptionBackend` is your app's service adapter. Keep its credentials in
an app account and use `ctx.fetch` and that account's `headers()` for requests.
The `connect` context includes the app's and caller's linked accounts, but an
unfilled single-account requirement is optional while connecting. Check that
the backend account exists before using it. `ctx.user.id` is the host's opaque
caller identity, supplied outside public input; it can be undefined on a
subjectless portable host. Pass `ctx.signal` to cancellable I/O.

`start` returns `{ session, url?, code?, paste?, expiresAt?, message? }`.
Use `paste: { label, placeholder? }` to ask for a value, such as the browser's
final address. `expiresAt` is a Unix timestamp in milliseconds. The host keeps
`session` on the server; the dialog receives only the public instructions.

`status` and `submit` return `{ state: "waiting" }`,
`{ state: "failed", message }`, or
`{ state: "connected", ref, accountInfo? }`. The dialog polls `status` while
waiting and calls `submit` with the pasted value. `submit` is optional for
device-code methods. Closing an unfinished dialog calls `cancel`, if supplied.
Implement cancellation and removal so retries are safe.

Executor saves only the opaque `ref`, available as
`ctx.user.accounts.subscription.fields.ref`. The app or its backend owns token
storage, refresh and revocation. `health` continues to work and may report a
reference the backend no longer serves. `accountInfo` can supply `displayName`,
`email` or `username`; Executor uses that identity as the initial account name
and still offers to rename it.

The account is bound to the app that acquired it, even when another app declares
the same provider. Removing its final link calls `remove` before deleting the
local account. A failed explicit removal keeps local state so it can be retried.
A single-account replacement retires the previous reference too. Deleting the
app or its owner removes the local accounts, then attempts bounded backend
cleanup; backend failure does not block that deletion. Interactive accounts do
not support replacing credentials in place; connect a new account instead.
Keep the retained version's handlers usable until its references have been
retired.

## Host-owned sign-in

Use `interactive({ label: "Sign in", acquisition: "host" })` when the host
manages the credential backend and the saved account should work across apps.
The host must register a driver for the exact provider reference and method.
This declaration selects host acquisition; it does not register a driver or
supply backend credentials. Omit `connect` handlers for these methods.

The account survives removal of the app that first connected it. Other apps
with the same provider can link it when the caller has permission. Reconnecting
keeps its account ID and replaces its saved reference. Unlinking it does not
revoke the credential; explicit account deletion runs the host driver's removal
callback. App-owned sign-in above keeps its existing app-bound lifecycle.

Hosts supply Effect-native registrations through `ExecutorOptions.acquisition`
or `AccountAcquisitionConfiguration` from `@executor-js/sdk/core`.
`accountAcquisitionDriver` from `@executor-js/sdk` wraps Promise callbacks for
start, status, optional submit, cancel, remove and optional credential checks.
Callbacks receive the host's owner, operation ID, deadline, signal and fetch.
Removal must be idempotent for its operation ID. Keep retained driver revisions
available for pending sign-ins and saved accounts; only the current revision
accepts new sign-ins. Missing registrations fail without deleting the account.

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
