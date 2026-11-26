---
title: Schedules
description: "Run app mutations on an interval or cron schedule with appInterval, appCron, userInterval, and userCron, and manage them on the Schedules tab."
---

Schedules run an app's mutations automatically on an interval or cron expression. Declare app-wide schedules with `appInterval` and `appCron`, or per-member schedules with `userInterval` and `userCron`, under `schedules` in `defineApp`, and control them on the app's **Schedules** tab (**Enable**, **Pause**, **Run now**, **Remove**). Schedules work on **Local**, **Self-host**, and **Cloud**.

**The step that matters most:** a new schedule declaration starts **Paused**—open the app's **Schedules** tab and click **Enable** first, then click **Run now** to queue a test run immediately.

**Prerequisites:** a deployed app with at least one mutation mounted once in `tools` and referenced by a schedule, plus any required accounts linked. On **Self-host** and **Cloud**, you need permission to manage the app to control an **App schedule**. With permission to use the app, you can enable and control your own copy under **Your schedule**. On **Local**, you can control both kinds.

**You'll know it worked when…** the schedule row shows the **Enabled** badge (or **Run active** while a run is outstanding) on the **Schedules** tab, and clicking **Run now** executes the mutation (or creates a pending request on **Approvals** when **Browser approvals** is selected).

## How to use it

Schedule authoring is identical across **Local**, **Self-host**, and **Cloud**. On **Local**, the background server must be running (`executor` or `executor service start`) for ticks to fire, and you can control both schedule kinds. On **Self-host** and **Cloud**, the hosted server dispatches ticks while your computer is off and enforces app-management permissions on app-wide schedules.

### 1. Declare schedules in app code

Use `userInterval(duration, mutation, input)` and `appInterval(duration, mutation, input)` for intervals, or `userCron({ expression, timezone? }, mutation, input)` and `appCron({ expression, timezone? }, mutation, input)` for cron:

- **App-wide (`appInterval`, `appCron`):** app-wide schedules run as the app using accounts linked for everyone. Type the target mutation's context as `MutationContext<typeof requirements, "app">` and omit any `approval` hook. On Self-host and Cloud, enabling, pausing, manually running, or removing them requires permission to manage the app.
- **Per-member (`userInterval`, `userCron`):** each member who enables a per-member schedule gets a copy that runs as them and uses their own links for user account requirements. The run can also use accounts linked for everyone.

Intervals take one positive integer unit (`seconds`, `minutes`, or `hours`) totaling at least 60 seconds. Cron schedules take a standard 5-field cron expression in UTC by default. Mount the target mutation once in the static `tools` router (not inside a dynamic router).

### 2. Enable and configure schedules in the dashboard

1. Open the app and select the **Schedules** tab.
2. Each row shows whether it is an **App schedule** or **Your schedule**, plus status badges such as `Paused`, `Enabled`, `Run active`, `Account required`, or `Waiting for reconnect`.
3. For a **Your schedule** row, pick the approval mode:
   - **Skip approvals** (`automatic`, default): automatically accepts the mutation's approval requests. Explicit denials still block execution.
   - **Browser approvals** (`browser`): if the mutation requests approval, the run holds the schedule's active slot while it waits. Answer within 15 minutes in an authorized browser session on the dashboard's **Approvals** page. MCP connection approval settings apply to calls made through that connection.
4. Click **Enable** to activate a new or paused schedule. Redeploying a compatible declaration keeps its saved settings.
5. Once enabled and no run is active, click **Run now** to queue a run immediately. Click **Pause** to stop future ticks (or after a test run), or **Remove** to delete saved settings for either kind (if the declaration is still in the app, it remains available to enable again).

## Example

Save the three files below in a folder (for example `./schedule-demo`). Set `dependencies.apps` in `package.json` to the version your host reports (`executor apps framework` on Local CLI):

`package.json`:
```json
{
  "name": "schedule-demo",
  "private": true,
  "type": "module",
  "dependencies": {
    "apps": "<framework-version>"
  }
}
```

`migrations/0001_sync_log.sql`:
```sql
CREATE TABLE sync_log (kind TEXT NOT NULL, ran_at TEXT NOT NULL);
```

`index.ts`:
```ts
import {
  appInterval,
  defineApp,
  mutation,
  type MutationContext,
  object,
  query,
  type QueryContext,
  router,
  userCron,
} from "apps";
import { always } from "apps/operations/approval";

const requirements = {};

const syncCatalog = mutation(
  { input: object({}) },
  async (ctx: MutationContext<typeof requirements, "app">) => {
    ctx.sql.exec(
      "INSERT INTO sync_log (kind, ran_at) VALUES ('app', datetime('now'))",
    );
    return { ok: true };
  },
);

const sendDigest = mutation(
  { input: object({}), approval: always() },
  async (ctx: MutationContext<typeof requirements>) => {
    ctx.sql.exec(
      "INSERT INTO sync_log (kind, ran_at) VALUES ('user', datetime('now'))",
    );
    return { sent: true };
  },
);

const listLog = query(
  { input: object({}) },
  async (ctx: QueryContext<typeof requirements>) =>
    ctx.sql.exec("SELECT kind, ran_at FROM sync_log ORDER BY rowid").toArray(),
);

export default defineApp(requirements, async () => ({
  tools: router({ syncCatalog, sendDigest, listLog }),
  schedules: {
    syncEveryHour: appInterval({ hours: 1 }, syncCatalog, {}),
    weekdayDigest: userCron({ expression: "0 9 * * 1-5" }, sendDigest, {}),
  },
}));
```

Run these commands from the parent of `./schedule-demo` with `jq` installed. On Local, use a CLI profile with no configured or remembered host. On Cloud, run `executor apps login` first. On Self-host, run `executor apps login --host https://executor.example.com` first, using your server's origin.

```bash
APP_ID="$(executor apps create --name "Schedule Demo" --files ./schedule-demo | jq -r .id)"
executor apps deploy --app "$APP_ID" --files ./schedule-demo
```

On the **Schedules** tab, click **Enable** on **syncEveryHour**, click **Run now**, and call the `listLog` tool to verify a new `'app'` row was recorded.

## Limits

- **Minimum cadence:** interval schedules must be at least 60 seconds and accept a single positive integer unit (`seconds`, `minutes`, or `hours`). Cron uses 5 fields and defaults to UTC.
- **Must be enabled to run:** **Run now** is unavailable on a new declaration without a saved copy and disabled on paused copies, copies with a run in progress, or declarations removed from source.
- **No overlap:** at most one active run per schedule at a time. Overdue ticks coalesce into a single run.
- **No `elicit`, retries, or checkpoints:** scheduled mutations cannot call `elicit` and do not get automatic retries or durable checkpoints. Start a [workflow](/docs/workflows) from the mutation when you need retries, sleeps, or multi-step durability.
- **Mutation placement:** the scheduled mutation must appear exactly once in `tools` outside dynamic routers. App schedules cannot target mutations with an `approval` handler.

## Related

- [Workflows](/docs/workflows)
- [Webhooks](/docs/webhooks)
- [Tools and approvals](/docs/concepts/tools-and-approvals)
- [Author an app](/docs/author-an-app)
