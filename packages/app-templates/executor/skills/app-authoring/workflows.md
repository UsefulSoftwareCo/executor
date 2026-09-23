## Workflows

Register `workflow({ input, output?, description? }, async (ctx, input) => result)`
in `defineApp(requirements, { ..., workflows: { name: declaration } })`.
Import `WorkflowContext<typeof requirements>` for handlers in separate files.
The body has `runId` and `step`; it has no database, accounts or `elicit`.

Use `step.do("name", async (ctx) => value)` for external work. Its context has fresh
accounts, fetch, signal and a stable `idempotencyKey`. Retry options can precede
the callback: `{ retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
timeout: "30 seconds" }`. Throw `NonRetryableError` for permanent failure.
Return bounded JSON, or `null` when no result is needed.

Use `step.runQuery("name", registeredQuery, input)` and
`step.runMutation("name", registeredMutation, input)` for app storage. Register
those declarations in the normal query/mutation catalogs too. A mutation's
receipt commits atomically with its database writes, so lost checkpoints do not
repeat a committed database mutation. External API writes still need idempotency.

Use `step.sleep("name", "1 minute")` or `step.sleepUntil("name", timestamp)` for
waiting. Put time reads, randomness and I/O inside steps; use their results for
branches and loops. `Promise.all` works for independent steps. Runs pin deployed
code and account IDs, but each executing step resolves current credentials.

App mutations/webhooks can call `ctx.workflows.start({ workflow, input, key? })`
and `terminate({ run })`. Queries also have `get({ run })` and `list(options?)`.
Controls cannot target another app. Use stable start keys when retrying a caller;
starting a workflow is not part of the calling app database transaction.
The SDK namespace is `executor.apps.workflowRuns`, with discovery through
`executor.apps.workflows.list`. Do not invent `executor.workflowRuns`.

V1 has no webhook/event wait, durable human-input request, or restart helper.
Background operations retain approval rules and fail if they require live input.

## Scheduled mutations

Declare schedules against the same mutation objects registered on the app:

```ts
import { defineApp, mutation, interval, cron, object, string } from "apps";

const record = mutation({ input: object({ message: string() }) }, async (_ctx, { message }) => ({
  message,
}));

export default defineApp({ accounts: {} }, async () => ({
  mutations: { record },
  schedules: {
    heartbeat: interval({ minutes: 5 }, record, { message: "Heartbeat" }),
    morning: cron({ expression: "0 9 * * MON-FRI", timezone: "America/Los_Angeles" }, record, {
      message: "Morning",
    }),
  },
}));
```

Intervals accept one positive integer unit: `seconds`, `minutes` or `hours`,
and must resolve to at least 60 seconds. A shorter interval fails when the app
is evaluated. Use Run now to try a schedule without waiting for its next tick.
Calendar schedules accept five-field cron expressions and default to UTC.
The mutation must appear once in the app's mutation catalog. Its input is
checked during app evaluation. External handlers use
`MutationContext<typeof requirements>`, exactly as ordinary mutations do. Read
selected providers through `ctx.accounts` and declared storage through `ctx.db`;
`interval` and `cron` retain that handler context type. No account-binding factory
or database-specific mutation constructor is needed.

Schedules start paused. Use the app's Schedules tab or the Executor management
app's schedule definitions/configure operations to enable them. The management
API also lists saved settings and runs, pauses schedules and requests a run now.
Each run uses the current deployment and selected accounts. Only one run is
active per schedule; overdue ticks coalesce into one run after downtime.

The default `automatic` approval mode accepts approval prompts using the saved
schedule authorization. Explicit denials still block execution. Select `browser`
to review requests on the Approvals page. These requests expire after 15 minutes
and occupy the active slot while waiting. Browser review requires the normal
signed-in user; an agent cannot answer through the management app.
Background input requests (`elicit`) are unsupported. No automatic retries,
workflow checkpoints or replay of uncertain side effects are provided.
