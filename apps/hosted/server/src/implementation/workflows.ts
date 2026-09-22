import { requireWorkflowAccess } from "./workflow-access.ts";
/** Keep product permissions and execution admission outside the reusable workflow SDK. */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HostedApi } from "../contracts/api.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { CurrentOrganization } from "../contracts/organization.ts";
import { ExecutionAdmission } from "../contracts/execution-admission.ts";
import { executionManagerOwner, currentOwner, selectedApp } from "./access.ts";

/** Run reads check current membership; writes require current administrator authority. */
export const hostedWorkflowHandlers = HttpApiBuilder.group(HostedApi, "workflows", (handlers) =>
  handlers
    .handle("definitions", ({ params, query }) =>
      Effect.gen(function* () {
        const owner = yield* currentOwner,
          executor = yield* Effect.flatten(HostedExecutor);
        yield* selectedApp(executor, owner, params.app, query.profile);
        return yield* executor.apps.workflows.list({ ...params, ...query });
      }),
    )
    .handle("start", ({ params, payload }) =>
      Effect.gen(function* () {
        const owner = yield* currentOwner,
          executor = yield* Effect.flatten(HostedExecutor);
        yield* selectedApp(executor, owner, params.app, payload.profile);
        yield* (yield* ExecutionAdmission)((yield* CurrentOrganization).organization);
        return yield* executor.apps.workflowRuns.start({ ...params, ...payload });
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
        yield* selectedApp(executor, owner, params.app, query.profile);
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
        yield* executionManagerOwner(executor, params.app, saved.profile ?? undefined);
        return yield* executor.apps.workflowRuns.terminate(params);
      }),
    ),
);
