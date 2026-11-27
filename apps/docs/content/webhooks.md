---
title: Webhooks
description: "Receive provider events in an Executor app. Set up webhooks and retry failed registration or removal from the Webhooks tab."
---

Providers send HTTP callbacks to your app's webhook handler. Executor runs the handler on the server. Verify the provider's signature before acting on an event. Declare handlers in `webhooks` on `defineApp` with automatic lifecycle hooks (`register`, `unregister`, `handle`) or manual setup (`setup` and `handle`), and manage subscriptions on the app's **Webhooks** tab (**Complete setup**, **Finish removal**, **Retry webhook**, **Save webhook configuration**). Webhooks work on **Local**, **Self-host**, and **Cloud**.

**The step that matters most:** declare the webhook in `defineApp`, link the required account, and save any required webhook configuration. For a manual webhook, open **Complete setup** and copy the **Callback URL** into your provider. If Executor generates the signing secret, copy it into your provider. If your provider supplies the secret, enter it under **Provider signing secret** in Executor.

**Prerequisites:** a deployed app with a `webhooks` catalog and its required account linked. On **Self-host** and **Cloud**, a member completes setup for their own user-linked account, while setup for an account linked for everyone requires permission to manage the app. On **Local**, open the setup page from your dashboard session. For a provider that sends callbacks over the internet, use a publicly reachable HTTPS callback origin.

**You'll know it worked when…** the subscription shows **Webhook ready** on its setup page or `active` on the **Webhooks** tab. With the example below, a correctly signed POST to its **Callback URL** returns HTTP 200 and a missing or invalid signature returns HTTP 401.

## How to use it

Every subscription's **Callback URL** ends in `/api/webhooks/<appId>/<subscriptionId>` and retains the URL it was issued. Callback origins differ by target:

- **Cloud:** Executor supplies the public `https://api.executor.sh` origin automatically; no network configuration is needed.
- **Self-host:** set your public HTTPS origin in `BETTER_AUTH_URL` (or use the configured Railway public origin) and forward `/api/webhooks/...` to Executor through your reverse proxy.
- **Local:** a process on your machine can call the loopback callback (`http://localhost:4312/...`). For an internet provider, point a reachable HTTPS tunnel at the local callback route, run `executor service set env EXECUTOR_WEBHOOK_ORIGIN https://<tunnel-host>`, and then run `executor service start` (setting `env` stops the service) before linking the account or creating the subscription. Outside the packaged CLI service, set `EXECUTOR_WEBHOOK_ORIGIN` on the server process directly.

### 1. Declare webhooks in app code

Add a `webhooks` object to `defineApp`. Each webhook declares:

- `account`: `{ app: "<key>" }` for an account linked for everyone, or `{ user: "<key>" }` for an account members link for themselves. Linking a matching account queues reconciliation of its webhook definitions for either scope.
- `config` and `state` schemas (both are required on every declaration, even if `object({})`).
- Either **automatic lifecycle** (`register`, `unregister`, `handle`) where Executor calls the provider API to create and delete the webhook, or **manual setup** (`setup: { instructions, signingSecret: "executor" | "provider" }`, `handle`) where you copy values into the provider UI.
- Write `async handle(ctx, { request, secret })`, reading headers and raw bytes from `request` and verifying the signature with `secret` before parsing the event or changing data. Type an app-scoped webhook with `satisfies Webhook<WebhookContext<typeof requirements, "app">, typeof config, typeof state>`.

To create an additional user-scoped subscription, call `webhooks.create` in the built-in Executor app. Read its signature on your target, then supply the webhook's `name`, the linked `sourceAccount` ID, a stable `key`, and the definition's `config`. App-scoped subscriptions come from linking an app account.

### 2. Configure, finish setup, retry, or remove in the dashboard

Open the app and select the **Webhooks** tab:

1. **Configure:** if a webhook defines required `config` fields, open **Webhook configuration for `<label>`**, enter a JSON object keyed by webhook name (for example `{"issueEvents":{"project":"demo"}}`), and click **Save webhook configuration**.
2. **Complete manual setup:** once the subscription appears with `setup required`, click **Complete setup** (opens `/webhooks/<app>/<subscriptionId>` locally or `/org/<slug>/webhooks/<app>/<subscriptionId>` on hosted—keep this setup URL if you need to remove the active subscription later).
   - Copy **Callback URL**.
   - If `signingSecret` is `"executor"`, click **Show**/**Hide** or copy **Signing secret** and paste it into your provider. If `"provider"`, paste the secret from your provider into **Provider signing secret**.
   - Fill any setup fields (or **Setup details (JSON)**), check **"I added this webhook in the provider."**, and click **Finish setup** to reach **Webhook ready** (**Cancel setup** disables the subscription instead).
3. **Retry lifecycle failures:** if automatic registration or removal fails (`Registration failed.` or `Removal failed.`), click **Retry webhook** to reconcile the subscription (it does not replay past event deliveries).
4. **Remove a manual webhook:** reopen the active subscription's setup page and click **Remove webhook** (status becomes **Webhook disabled**), or if the subscription is already disabled (for example via the management API), click **Finish removal** on the **Webhooks** tab. Delete the webhook in the provider, check **"This webhook is no longer registered with the provider."**, and click **Confirm removal** (**Removal confirmed**).

## Example

Save the three files below in a folder (for example `./webhook-demo`). Set `dependencies.apps` in `package.json` to the version your host reports (`executor apps framework` on Local CLI):

`package.json`:
```json
{
  "name": "webhook-demo",
  "private": true,
  "type": "module",
  "dependencies": {
    "apps": "<framework-version>"
  }
}
```

`migrations/0001_webhook_events.sql`:
```sql
CREATE TABLE webhook_events (body TEXT NOT NULL);
```

`index.ts`:
```ts
import {
  defineApp,
  defineProvider,
  object,
  query,
  type QueryContext,
  router,
  secrets,
  string,
  type Webhook,
  type WebhookContext,
} from "apps";

const service = defineProvider({
  name: "Acme",
  hosts: ["api.example.com"],
  auth: {
    token: secrets({
      label: "API token",
      fields: object({ token: string() }),
    }),
  },
});

const requirements = { app: { accounts: { service } } };
const config = object({ project: string() });
const state = object({});

const issueEvents = {
  account: { app: "service" },
  config,
  state,
  setup: {
    instructions:
      "Add a webhook in your provider settings pointing at the Callback URL with the signing secret.",
    signingSecret: "executor",
  },
  async handle(ctx, { request, secret }) {
    const bytes = await request.arrayBuffer();
    const signature = request.headers.get("x-acme-signature");
    if (signature === null || !/^sha256=[a-f0-9]{64}$/.test(signature)) {
      return new Response("Invalid signature", { status: 401 });
    }
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const digest = Uint8Array.from(
      signature.slice(7).match(/../g) ?? [],
      (pair) => Number.parseInt(pair, 16),
    );
    if (!(await crypto.subtle.verify("HMAC", key, digest, bytes))) {
      return new Response("Invalid signature", { status: 401 });
    }
    const body = new TextDecoder().decode(bytes);
    ctx.sql.exec("INSERT INTO webhook_events (body) VALUES (?)", body);
    return new Response("ok", { status: 200 });
  },
} satisfies Webhook<
  WebhookContext<typeof requirements, "app">,
  typeof config,
  typeof state
>;

const listEvents = query(
  { input: object({}) },
  async (ctx: QueryContext<typeof requirements>) =>
    ctx.sql.exec("SELECT body FROM webhook_events ORDER BY rowid").toArray(),
);

export default defineApp(requirements, async () => ({
  tools: router({ listEvents }),
  webhooks: { issueEvents },
}));
```

Run these commands from the parent of `./webhook-demo` with `jq` installed. On Local, use a CLI profile with no configured or remembered host. On Cloud, run `executor apps login` first. On Self-host, run `executor apps login --host https://executor.example.com` first, using your server's origin.

```bash
APP_ID="$(executor apps create --name "Webhook Demo" --files ./webhook-demo | jq -r .id)"
executor apps deploy --app "$APP_ID" --files ./webhook-demo
```

To test delivery on Local:

1. Open **Accounts** and connect a dummy API token to **Acme**.
2. Open **Webhooks**, enter `{"issueEvents":{"project":"demo"}}` under **Webhook configuration for** that account, and click **Save webhook configuration**.
3. Click **Complete setup**, copy **Callback URL** (`CALLBACK_URL`) and **Signing secret** (`SECRET`), check **"I added this webhook in the provider."**, and click **Finish setup**.
4. In Bash with curl, OpenSSL, and awk installed, set `CALLBACK_URL` and `SECRET` to the values you copied. Send an unsigned request and a validly signed request, then call `listEvents` to confirm only the valid event was stored:
   ```bash
   BODY='{"event":"opened","id":"1"}'
   # Expect HTTP 401:
   curl -i -X POST "$CALLBACK_URL" -H "content-type: application/json" -d "$BODY"

   # Expect HTTP 200:
   SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')"
   curl -i -X POST "$CALLBACK_URL" -H "content-type: application/json" -H "x-acme-signature: $SIG" -d "$BODY"
   ```

## Limits

- **45-second timeout and 1 MiB body limit:** `handle`, `register`, and `unregister` each time out after 45 seconds. Requests over 1 MiB receive HTTP 413; stopping, disabled, and stopped subscriptions return HTTP 410; delivery failures return HTTP 503.
- **Synchronous HTTP response, no `elicit`:** the callback HTTP request waits for `handle` to return a `Response`, and there is no live user session to answer `elicit`. Return quickly and start a [workflow](/docs/workflows) with `ctx.workflows.start` for longer work.
- **No automatic deduplication or replay:** Executor forwards each delivery directly to `handle`. Implement idempotency checks (for example by provider event ID in SQLite) inside your handler.
- **Reconciliation across versions and removal:** each subscription has a source account, and Executor reconciles account-linked subscriptions when the app version changes. A compatible managed manual subscription can keep the same callback URL and signing secret across versions. Before deleting an app or unlinking an account, finish any manual provider removal and resolve any failed cleanup.

## Related

- [Workflows](/docs/workflows)
- [Schedules](/docs/schedules)
- [Author an app](/docs/author-an-app)
- [Self-host Executor](/docs/run/self-host)

Using Executor CLI 2.0.0-beta.79? For app management and Git, run `executor apps login --host <your origin>`. For tool commands and MCP, run `executor login --host <your origin>`.
