/** Local setup has the paired dashboard's authority and one fixed local subject. */
import type { Executor } from "@executor-js/sdk/core";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { DashboardApi } from "../contracts/dashboard.ts";
/** All execution mechanisms use these same durable account bindings. */
export const localProfileHandlers = (executor: Executor) =>
  HttpApiBuilder.group(DashboardApi, "profiles", (handlers) =>
    handlers
      .handle("webhooks", ({ params }) => executor.webhooks.list(params))
      .handle("list", ({ params }) =>
        executor.apps.profiles.list({
          ...params,
          subject: "local",
        }),
      )
      .handle("get", ({ params }) => executor.apps.profiles.get(params))
      .handle("create", ({ params, payload }) =>
        Effect.gen(function* () {
          const app = yield* executor.apps.get(params);
          return yield* executor.apps.profiles.create({
            ...params,
            ...payload,
            owner: app.owner,
            subject: "local",
          });
        }),
      )
      .handle("update", ({ params, payload }) =>
        executor.apps.profiles.update({ ...params, ...payload }),
      )
      .handle("setEnabled", ({ params, payload }) =>
        executor.apps.profiles.setEnabled({ ...params, ...payload }),
      )
      .handle("reconcile", ({ params }) => executor.apps.profiles.reconcile(params))
      .handle("remove", ({ params }) => executor.apps.profiles.remove(params)),
  );
