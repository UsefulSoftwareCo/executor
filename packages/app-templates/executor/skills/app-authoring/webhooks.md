## Webhook subscriptions

Apps may return a `webhooks` catalog. Define the `account` requirement whose
accounts are its source, `config` and `state` schemas, and async `register`,
`handle`, and `unregister` callbacks. Keep these callbacks together. The host
supplies a stable `subscriptionId`, `callbackUrl`, signing `secret`, and the
source `account`; the other accounts are available in context.

`account` names the requirement with its scope. `account: { user: "github" }`
registers the webhook for each account a member links, which runs as that
member: its context has `ctx.user.accounts` and `ctx.app.accounts`.
`account: { app: "datadog" }` registers it for the account linked to the app
for everyone, without a caller: its context has only `ctx.app.accounts`. Linking
the account registers it and unlinking removes it. Use `WebhookContext<typeof requirements>`
or `WebhookContext<typeof requirements, "app">` for external lifecycle handlers.
A webhook written inline in `defineApp` cannot infer its scope from `account`, so
state it to type the handlers:

```ts
const empty = object({});
const alerts = {
  account: { app: "datadog" },
  config: empty,
  state: empty,
  register: async (ctx) => ({}),
  unregister: async () => {},
  handle: async (ctx, { request }) => new Response(null, { status: 204 }),
} satisfies Webhook<WebhookContext<typeof requirements, "app">, typeof empty, typeof empty>;
```

An account has one webhook source per app. The same account may be linked for
everyone and by members; it then serves only as the app's account, for the
`app` webhooks of the requirements it is linked to. When its last app link is
removed, a member who links it becomes the source.

Webhook contexts expose writable `ctx.sql` when the app declares `sql`, and
exclude `elicit` in both the type and runtime object. No handler runs
inside a transaction, so `register` can wait on a provider that verifies the
callback URL by calling `handle` before it answers. Registration and cleanup must
be idempotent. A callback must verify the provider signature over raw bytes
before parsing the body or performing side effects.

`handle`, `register` and `unregister` each have 45 seconds. Providers often
resend a delivery much sooner, some after 5 seconds, so answer fast: verify,
store the event or start a workflow with `ctx.workflows.start`
([workflows.md](workflows.md)), then reply.

Discover definitions/config schemas through the Executor app's webhook
operations. Create with a stable `key`, handler `name`, `config`, and an explicit
`sourceAccount` for a collection requirement. Check the returned `status` and
`failure`. Retry failed or interrupted registration/cleanup with `reconcile`.
Remove a subscription before deleting its app or connected accounts.
Subscriptions pin their original version and account IDs; recreate to upgrade.
Providers retry deliveries; Executor does not deduplicate or replay them.
`state` can be null during provider validation or cleanup after a lost
registration response. Local providers need a publicly reachable callback origin.

For providers without a registration API, replace `register` and `unregister`
with `setup: { instructions: "...", signingSecret: "executor" }`.
Keep `handle` and both schemas. `state` describes the private setup fields;
use `object({})` if only a signing secret is needed. `executor` means the operator
copies a generated secret into the provider; `provider` means they paste the
provider's secret into Executor's secure page. A version that keeps `signingSecret`
and the fields `state` accepts keeps the subscription, callback URL and secret,
also when an earlier version is activated again; reordering fields is no change.
Changing either needs a new setup at the provider.

An `app` webhook's subscription comes from linking an account to the app, so
`webhooks.create` refuses it with `reason: "input"` and a message saying so;
find it with `webhooks.list`.

When creation returns `setup-required`, request `webhookLinks.link({ path: { app, subscription } })` (local) or
the hosted `setupLink` operation and show the URL to the user. Do not ask for
signing secrets in chat or include them in tool arguments. Read status with
`webhooks.get`. Manual removal returns `disabled`; after removing it
in the provider, use `webhooks.confirmRemoval`. This confirms the
operator's action; Executor cannot verify external deletion without a provider API.
