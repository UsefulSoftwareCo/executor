## Workflows

Register `workflow({ input, output?, description? }, async (ctx, input) => result)`
in `defineApp(requirements, { ..., workflows: { name: declaration } })`.
Import `WorkflowContext<typeof requirements>` for handlers in separate files, or
`WorkflowContext<typeof requirements, "app">` for a workflow app-scope work
starts, such as an app schedule's mutation; its steps have no `user`.
The body has `runId` and `step`; it has no `ctx.sql`, accounts or `elicit`.

Use `step.do("name", async (ctx) => value)` for external work. Its context has fresh
accounts (`ctx.app.accounts`, and `ctx.user.accounts` in a run started by a
caller), fetch, signal and a stable `idempotencyKey`. Retry options can precede
the callback: `{ retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
timeout: "30 seconds" }`. Throw `NonRetryableError` for permanent failure.
Return bounded JSON, or `null` when no result is needed.

Use `step.runQuery("name", registeredQuery, input)` and
`step.runMutation("name", registeredMutation, input)` for app storage. Register
those declarations in the normal query/mutation catalogs too. A mutation run as a
step writes only inside one `ctx.sql.transaction(...)`, which also records the
step's receipt, so a retried step never repeats its writes. A write outside that
transaction, or a second transaction, fails the step. External API writes still
need idempotency.

Use `step.sleep("name", "1 minute")` or `step.sleepUntil("name", timestamp)` for
waiting. Put time reads, randomness and I/O inside steps; use their results for
branches and loops. `Promise.all` works for independent steps. Runs pin deployed
code and account IDs, but each executing step resolves current credentials.

App mutations/webhooks can call `ctx.workflows.start({ workflow, input, key? })`
and `terminate({ run })`. Queries also have `get({ run })` and `list(options?)`.
Controls cannot target another app. Use stable start keys when retrying a caller;
starting a workflow is never part of a SQL transaction.

Limits: workflow and step names are 1–200 characters, `start` input is JSON of at
most 1 MiB, a `key` is 1–128 characters, and `list` takes `limit` 1–100 (default
20). A start with the same key and input returns that run; the same key with
other input fails with reason `conflict`. Controls throw `WorkflowFailure` with
`reason`, `retryable` and a `message`. Reason `input` is refused before any run
starts; fix the call. A `start` that fails with reason `engine` and
`retryable: false` may still have started its run: start again with the same key
and input, or check `list`, before starting a run without a key.
The SDK namespace is `executor.apps.workflowRuns`, with discovery through
`executor.apps.workflows.list`. Do not invent `executor.workflowRuns`.

## Waiting for a person

A user workflow can persist a question, then park until its saved actor answers:

```ts
const question = await ctx.step.requestInput("pick an action", {
  timeoutMs: 7 * 24 * 60 * 60 * 1000,
  form: {
    mode: "form",
    message: "What should happen next?",
    requestedSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["continue", "defer"] } },
      required: ["action"],
    },
  },
  links: [{ label: "Open Accounts", href: "/accounts" }],
});
// The question is committed before a separate step sends its reviewUrl through a connector.
const answer = await ctx.step.waitForInput("wait for action", question);
if (answer.status === "answered" && answer.response.action === "accept") {
  // Recheck the resource and the chosen action's permission before acting.
}
```

`requestInput` uses the standard flat form schema. `timeoutMs` is required and
ranges from 1 millisecond to 30 days. The question retains its stable run/step
identity across replay; changing a replayed request fails with `conflict`.
`waitForInput` returns `answered` with an accept/decline/cancel response, or
`expired` or `withdrawn`. A valid first answer wins, including across restarts.
Invalid responses leave the question pending. Terminating the run withdraws it.

Hosted and local Approvals routes require the initiating person's signed-in
browser and current app/account access. The response never changes the run's
execution actor. Questions cannot currently be assigned to another person or
role, and app-scope workflows cannot request one. A review URL locates the
question; it grants no access. Answering a form grants no downstream tool
permission and does not establish that a repair succeeded.

The SDK's `workflowInputs` operations list, read, answer and withdraw questions.
Listings return `{ items, next? }`, at most 100 in ID order; pass `next` as `after`
to continue, including when a page has no currently accessible items.
Browser-only reads/answers are not exposed through the local bearer API.
`workflowInputs.updateEvidence` replaces bounded display facts while the question
is pending. It preserves the form, deadline, identity and any saved response.
Use it for later observations of the same decision. Use withdrawal when recovery
makes a pending decision obsolete; a changed
decision needs a new question. A schedule pause alone does not cancel its runs.
Background tools still cannot use live `elicit`; use a durable question in the
workflow instead. General event waits and restart controls are not exposed.

## Scheduled mutations

Declare schedules against the same mutation objects registered on the app. A
schedule has one of two scopes:

- `appInterval` and `appCron`: one schedule for the app. Someone who can edit
  the app enables it, and it runs without a caller, with the app's accounts only
  (`ctx.app.accounts`). Its mutation takes a context of the `"app"` scope,
  `MutationContext<typeof requirements, "app">`, which has no `user`, or
  declares no parameters, and declares no `approval`: nobody is there to ask.
  A context declared without a type is the caller's, so the types reject it,
  and an approval also fails the app's evaluation. `mutation<Input, Output>(…)`
  with explicit type arguments has the caller's context too, even with no
  parameters; pass the `"app"` context as the third type argument.
- `userInterval` and `userCron`: each member enables their own copy, at most one
  per declaration, which runs as them with the accounts they linked to the app
  (`ctx.user.accounts`).

```ts
import {
  appInterval,
  defineApp,
  mutation,
  type MutationContext,
  object,
  router,
  string,
  userCron,
} from "apps";

const requirements = {};

// An app schedule's mutation takes a context of the "app" scope: it runs without a caller.
const record = mutation(
  { input: object({ message: string() }) },
  async (ctx: MutationContext<typeof requirements, "app">, { message }) =>
    ctx.sql.exec("INSERT INTO notes (message) VALUES (?) RETURNING message", message).one(),
);

export default defineApp(requirements, {
  tools: router({ record }),
  schedules: {
    heartbeat: appInterval({ minutes: 5 }, record, { message: "Heartbeat" }),
    morning: userCron({ expression: "0 9 * * MON-FRI", timezone: "America/Los_Angeles" }, record, {
      message: "Morning",
    }),
  },
});
```

Intervals accept one positive integer unit: `seconds`, `minutes` or `hours`,
and must resolve to at least 60 seconds. A shorter interval fails when the app
is evaluated. Use Run now to try a schedule without waiting for its next tick.
Calendar schedules accept five-field cron expressions and default to UTC.
The mutation must appear once in the app's `tools` router, outside dynamic routers. Its input is
checked during app evaluation. External handlers use
`MutationContext<typeof requirements>` for a user schedule, exactly as ordinary
mutations do, and `MutationContext<typeof requirements, "app">` for an app
schedule. No factory that supplies accounts and no storage-specific mutation constructor is
needed. A workflow such a mutation starts declares `WorkflowContext<typeof requirements, "app">`.

Schedules start paused. Use the app's Schedules tab or the Executor management
app's schedule definitions/configure operations to enable them. The management
API also lists saved schedules and runs, pauses, removes and runs one now. Only
people who can edit an app enable, pause, run or remove its app schedules. Each
run uses the current version and, at that moment, the member's linked
accounts for a user schedule or the accounts linked for everyone for an app
schedule. A schedule whose plain requirement has no account skips its
occurrences and shows "Account required" until one is linked. Only one run is
active per schedule; overdue ticks coalesce into one run after downtime.

For a user schedule, the default `automatic` approval mode accepts approval
prompts using the saved schedule authorization. Explicit denials still block execution. Select `browser`
to review requests on the Approvals page. These requests expire after 15 minutes
and occupy the active slot while waiting. Browser review requires the normal
signed-in user; an agent cannot answer through the management app.
Background input requests (`elicit`) are unsupported. No automatic retries,
workflow checkpoints or replay of uncertain side effects are provided.
