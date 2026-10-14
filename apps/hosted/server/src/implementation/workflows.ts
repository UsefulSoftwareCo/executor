import { requireWorkflowAccess, requireWorkflowReplayAccess } from "./workflow-access.ts";
/** Keep product permissions outside the reusable workflow SDK. */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HostedApi } from "../contracts/api.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { requireAppAccess } from "./resource-policy.ts";
import { actorManagerOwner, currentOwner, selectedApp } from "./access.ts";

/** Run reads check current membership and the run's accounts; starts use the caller's accounts. */
export const hostedWorkflowHandlers = HttpApiBuilder.group(HostedApi, "workflows", (handlers) =>
  handlers
    .handle("definitions", ({ params, query }) =>
      Effect.gen(function* () {
        const owner = yield* currentOwner,
          executor = yield* Effect.flatten(HostedExecutor);
        const { accounts } = yield* selectedApp(executor, owner, params.app);
        return yield* executor.apps.workflows.list({ ...params, ...query, accounts });
      }),
    )
    .handle("start", ({ params, payload }) =>
      Effect.gen(function* () {
        const owner = yield* currentOwner,
          executor = yield* Effect.flatten(HostedExecutor);
        const { accounts } = yield* selectedApp(executor, owner, params.app);
        yield* requireWorkflowReplayAccess(executor, owner, params.app, payload);
        const run = yield* executor.apps.workflowRuns.start({ ...params, ...payload, accounts });
        // A concurrent start may have saved this key after the preflight read.
        yield* requireWorkflowAccess(executor, owner, params.app, run.id);
        return run;
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const owner = yield* currentOwner,
          executor = yield* Effect.flatten(HostedExecutor);
        yield* requireWorkflowAccess(executor, owner, params.app, params.run);
        return yield* executor.apps.workflowRuns.get(params);
      }),
    )
    .handle("list", ({ params, query }) =>
      Effect.gen(function* () {
        const owner = yield* currentOwner,
          executor = yield* Effect.flatten(HostedExecutor);
        yield* requireAppAccess(params.app, "use");
        const page = yield* executor.apps.workflowRuns.list({ ...params, ...query });
        const items = yield* Effect.filter(page.items, (run) =>
          requireWorkflowAccess(executor, owner, params.app, run.id).pipe(
            Effect.as(true),
            Effect.catchTags({
              OrganizationForbidden: () => Effect.succeed(false),
              AccountNotFound: () => Effect.succeed(false),
            }),
          ),
        );
        return { ...page, items };
      }),
    )
    .handle("terminate", ({ params }) =>
      Effect.gen(function* () {
        const executor = yield* Effect.flatten(HostedExecutor),
          owner = yield* currentOwner;
        const saved = yield* requireWorkflowAccess(executor, owner, params.app, params.run);
        yield* actorManagerOwner(params.app, saved.actor);
        return yield* executor.apps.workflowRuns.terminate(params);
      }),
    ),
);
