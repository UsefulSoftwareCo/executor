---
title: Workflows
description: "Write durable multi-step workflows in an Executor app, start and inspect runs on the Workflows tab, and terminate active runs."
---

Workflows run durable, multi-step TypeScript jobs inside an Executor app with per-step checkpoints, retries, and sleeps. Declare them with `workflow` under `workflows` in `defineApp`, call `step.do`, `step.runQuery`, `step.runMutation`, `step.sleep`, and `step.sleepUntil`, and manage runs from app code (`ctx.workflows`) or the app's **Workflows** tab (**Start workflow**, **Terminate run**). Workflows work on **Local**, **Self-host**, and **Cloud**.

**The step that matters most:** export `workflows: { ... }` from `defineApp`, deploy the app, and start a run from the **Workflows** tab or `ctx.workflows.start`.

**Prerequisites:** a deployed Executor app that defines at least one workflow and has any required accounts linked. On **Self-host** and **Cloud**, you need permission to use the app and access to its required accounts to start a run, and permission to manage the app to terminate an app-scoped run.

**You'll know it worked when…** the run appears in **All runs** on the app's **Workflows** tab, reaches `Complete`, and opening the row shows the expected output under **Result**.

## How to use it

Workflow authoring is the same on **Local**, **Self-host**, and **Cloud**. On **Local**, runs execute in the local server's workflow runtime for the single local user; on **Self-host** and **Cloud**, runs execute in the hosted runtime and enforce app, account, and ownership checks.

### 1. Define a workflow in app code

Use `workflow({ input, output?, description? }, async (ctx, input) => result)` and return it in `workflows` from `defineApp`:

- **Step durability (`step.do`):** wrap external API calls or non-deterministic work in `ctx.step.do(name, options?, async (stepCtx) => value)`. Each step receives `stepCtx.app.accounts`, `stepCtx.user.accounts` (when started by a caller), `stepCtx.fetch`, `stepCtx.signal`, and `stepCtx.idempotencyKey`. Configure retries with `{ retries: { limit, delay, backoff }, timeout }`, and throw `NonRetryableError` to fail immediately without retrying.
- **Database reads and writes:** workflow bodies do not have `ctx.sql`. Read data with `ctx.step.runQuery(name, queryFn, input, options?)` and write data with `ctx.step.runMutation(name, mutationFn, input, options?)`. Mount operations used by `step.runQuery` or `step.runMutation` in the static `tools` router. Inside a workflow step mutation, write through the transaction's `tx` argument in one synchronous `ctx.sql.transaction((tx) => ...)` callback and return the step mutation's result from that callback.
- **Delays:** pause without holding a worker open using `ctx.step.sleep(name, duration)` or `ctx.step.sleepUntil(name, timestampOrDate)` (accepts an epoch timestamp in milliseconds or a `Date`).
- **App-only vs caller-started:** type the workflow for the context it receives—use `WorkflowContext<typeof requirements, "app">` for runs started by an app-scoped mutation, or `WorkflowContext<typeof requirements>` for caller-started runs. The invocation sets the actual scope.

### 2. Start and manage runs from tools or the dashboard

- **From app code:** queries and mutations can call `ctx.workflows.get({ run })` and `ctx.workflows.list({ workflow?, limit?, cursor? })`. Mutations can also call `ctx.workflows.start({ workflow, input, key? })` and `ctx.workflows.terminate({ run })`. Within the same app, caller, and account scope, resubmit the same `key`, workflow name, and input to get the existing run; reusing that key with a different workflow name or input fails with `conflict`.
- **From the dashboard:** open the app and select the **Workflows** tab.
  1. Select a workflow in the sidebar to show **Input schema**, **Input**, and **Start workflow** (or stay on **All runs** to inspect runs you can access across every workflow).
  2. Paste JSON matching **Input schema** into **Input** and click **Start workflow**.
  3. Open a run row to check its status (`Queued`, `Running`, `Waiting`, `Paused`, `Pausing`, `Complete`, `Failed`, or `Terminated`—a run without a sleep can complete without showing `Waiting`). Open a completed row for **Result** or a failed row for **Failure reason**.
  4. Click **Terminate run** to stop an active run (on Self-host and Cloud, you can inspect and terminate your own runs while you still have access; terminating an app-scoped run requires permission to manage the app). Use **Newer runs** and **Older runs** to page through history.

## Example

Save the three files below in a folder (for example `./workflow-demo`). Set `dependencies.apps` in `package.json` to the version your host reports (`executor apps framework` on Local CLI):

`package.json`:
```json
{
  "name": "workflow-demo",
  "private": true,
  "type": "module",
  "dependencies": {
    "apps": "<framework-version>"
  }
}
```

`migrations/0001_items.sql`:
```sql
CREATE TABLE items (name TEXT NOT NULL, summary TEXT NOT NULL);
```

`index.ts`:
```ts
import {
  defineApp,
  mutation,
  type MutationContext,
  number,
  object,
  query,
  type QueryContext,
  router,
  string,
  workflow,
  type WorkflowContext,
} from "apps";

const requirements = {};

const recordItem = mutation(
  { input: object({ item: string(), summary: string() }) },
  async (ctx: MutationContext<typeof requirements>, input) =>
    ctx.sql.transaction((tx) => {
      tx.exec(
        "INSERT INTO items (name, summary) VALUES (?, ?)",
        input.item,
        input.summary,
      );
      return { saved: true };
    }),
);

const processItem = workflow(
  {
    description: "Summarize an item and record the result",
    input: object({ item: string() }),
    output: object({ item: string(), saved: number() }),
  },
  async (ctx: WorkflowContext<typeof requirements>, input) => {
    const summary = await ctx.step.do(
      "build-summary",
      { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } },
      async (stepCtx) => `Processed ${input.item} (${stepCtx.idempotencyKey})`,
    );

    await ctx.step.runMutation("save-item", recordItem, {
      item: input.item,
      summary,
    });

    return { item: input.item, saved: 1 };
  },
);

export default defineApp(requirements, async () => ({
  tools: router({
    recordItem,
    start: mutation(
      { input: object({ item: string(), key: string().optional() }) },
      async (ctx: MutationContext<typeof requirements>, input) =>
        ctx.workflows.start({
          workflow: "processItem",
          input: { item: input.item },
          ...(input.key ? { key: input.key } : {}),
        }),
    ),
    status: query(
      { input: object({ run: string() }) },
      async (ctx: QueryContext<typeof requirements>, input) =>
        ctx.workflows.get({ run: input.run }),
    ),
  }),
  workflows: { processItem },
}));
```

Run these commands from the parent of `./workflow-demo` with `jq` installed. On Local, use a CLI profile with no configured or remembered host. On Cloud, run `executor apps login` first. On Self-host, run `executor apps login --host https://executor.example.com` first, using your server's origin.

```bash
APP_ID="$(executor apps create --name "Workflow Demo" --files ./workflow-demo | jq -r .id)"
executor apps deploy --app "$APP_ID" --files ./workflow-demo
```

In **Workflows**, select **processItem**, enter `{"item":"sample"}`, and click **Start workflow**. Open the completed run. Under **Result**, check that `item` is `sample` and `saved` is `1`.

## Limits

- **Names and payloads:** workflow names and step names must be 1–200 characters. Workflow input JSON is capped at 1 MiB. Idempotency `key` values must be 1–128 characters. `ctx.workflows.list` accepts `limit` from 1 to 100 (default 20).
- **No direct I/O in the workflow body:** `ctx.sql`, accounts, and `elicit` are unavailable directly in the workflow body; use `step.do`, `step.runQuery`, and `step.runMutation`.
- **Single synchronous SQL transaction per step mutation:** workflow step mutations may open at most one synchronous `ctx.sql.transaction` and cannot return a Promise from the transaction callback.
- **No event waits or interactive elicitation:** workflows cannot wait for inbound webhooks or pause for durable `elicit` prompts. Background operations that require live user input fail.
- **Version and account pinning:** a workflow run keeps the app version and account IDs selected when it starts. Executor resolves current credentials for those accounts when it executes a step that can use them.

## Related

- [Schedules](/docs/schedules)
- [Webhooks](/docs/webhooks)
- [Author an app](/docs/author-an-app)
- [Apps and versions](/docs/concepts/apps-and-versions)
