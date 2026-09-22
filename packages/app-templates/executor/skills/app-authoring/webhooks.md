## Webhook subscriptions

Apps may return a `webhooks` catalog. Define an `account` slot, `config` and
`state` schemas, and async `register`, `handle`, and `unregister` callbacks.
Keep these callbacks together. The host supplies a stable `subscriptionId`,
`callbackUrl`, signing `secret`, and the selected source `account`; other saved
accounts are available in context. Use `WebhookContext<typeof requirements>` for
external lifecycle handlers. It exposes writable `ctx.db` when the app declares
a database, and excludes `elicit` in both the type and runtime object. Registration,
delivery and cleanup each own their storage transaction. Registration and cleanup must
be idempotent. A callback must verify the provider signature over raw bytes
before parsing the body or performing side effects.

Discover definitions/config schemas through the Executor app's webhook
operations. Create with a stable `key`, handler `name`, `config`, and an explicit
`sourceAccount` for a collection requirement. Check the returned `status` and
`failure`. Retry failed or interrupted registration/cleanup with `reconcile`.
Remove a subscription before deleting its app or connected accounts.
Subscriptions pin their original deployment/account IDs; recreate to upgrade.
Providers retry deliveries; Executor does not deduplicate or replay them.
`state` can be null during provider validation or cleanup after a lost
registration response. Local providers need a publicly reachable callback origin.

For providers without a registration API, replace `register` and `unregister`
with `setup: { instructions: "...", signingSecret: "executor" }`.
Keep `handle` and both schemas. `state` describes the private setup fields;
use `object({})` if only a signing secret is needed. `executor` means the operator
copies a generated secret into the provider; `provider` means they paste the
provider's secret into Executor's secure page.

When creation returns `setup-required`, request `webhookLinks_link({ path: { app, subscription } })` (local) or
the hosted `setupLink` operation and show the URL to the user. Do not ask for
signing secrets in chat or include them in tool arguments. Read status with
`webhooks_get`. Manual removal returns `disabled`; after removing it
in the provider, use `webhooks_confirmRemoval`. This confirms the
operator's action; Executor cannot verify external deletion without a provider API.
