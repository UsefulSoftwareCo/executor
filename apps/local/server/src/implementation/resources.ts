/** Dashboard policy is pairing; the SDK owns account binding and durable execution. */
import { WebhookNotFound, type AppId, type Executor } from "@executor-js/sdk/core";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";
import { callerAccounts } from "./app-accounts.ts";
import { HttpApiBuilder } from "effect/http-api";
import { DashboardApi } from "../contracts/dashboard.ts";
/** Expose resource operations only inside the paired dashboard API. */
export const localResourceHandlers = (
  executor: Executor,
  sql: SqlClient.SqlClient,
  /** Wakes webhook source reconciliation after saved intent commits. */
  wakeWebhookSources: Effect.Effect<void>,
) => {
  /** Workflows run app code with the accounts linked to the app. */
  const accounts = (app: AppId) =>
    executor.apps
      .get({ app })
      .pipe(Effect.flatMap((found) => callerAccounts(sql, executor, found)));
  return Layer.mergeAll(
    HttpApiBuilder.group(DashboardApi, "workflows", (handlers) =>
      handlers
        .handle("definitions", ({ params, query }) =>
          accounts(params.app).pipe(
            Effect.flatMap((accounts) =>
              executor.apps.workflows.list({ ...params, ...query, accounts }),
            ),
          ),
        )
        .handle("start", ({ params, payload }) =>
          accounts(params.app).pipe(
            Effect.flatMap((accounts) =>
              executor.apps.workflowRuns.start({ ...params, ...payload, accounts }),
            ),
          ),
        )
        .handle("list", ({ params, query }) =>
          executor.apps.workflowRuns.list({ ...params, ...query }),
        )
        .handle("terminate", ({ params }) => executor.apps.workflowRuns.terminate(params)),
    ),
    HttpApiBuilder.group(DashboardApi, "webhooks", (handlers) =>
      handlers
        .handle("list", ({ params }) => executor.webhooks.list(params))
        .handle("reconcile", ({ params }) => executor.webhooks.reconcile(params))
        .handle("sources", ({ params }) =>
          executor.webhooks
            .sources(params)
            .pipe(
              Effect.map((sources) => sources.filter((source) => source.status !== "removing")),
            ),
        )
        // The source keeps its actor.
        .handle("configureSource", ({ params, payload }) =>
          Effect.gen(function* () {
            const source = (yield* executor.webhooks.sources({ app: params.app })).find(
              (item) => item.account === params.account,
            );
            if (source === undefined || source.status === "removing")
              return yield* new WebhookNotFound();
            // Saved only while the source is still the one read above.
            const saved = yield* executor.webhooks.configureSource({
              app: params.app,
              account: params.account,
              expected: { id: source.id, actor: source.actor, revision: source.revision },
              ...payload,
            });
            // The saved intent re-registers the source's subscriptions in the background.
            yield* wakeWebhookSources;
            return saved;
          }),
        ),
    ),
  );
};
