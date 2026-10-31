/** A response never changes the workflow's saved execution actor. */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { AppId } from "@executor-js/sdk/core";
import { HostedApi } from "../contracts/api.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { currentOwner, browserOnly } from "./access.ts";
import { requireAppAccess } from "./resource-policy.ts";
import { requireWorkflowAccess } from "./workflow-access.ts";

export const hostedWorkflowInputHandlers = HttpApiBuilder.group(
  HostedApi,
  "workflowInputs",
  (handlers) =>
    handlers
      .handle("list", ({ query }) =>
        Effect.gen(function* () {
          const owner = yield* currentOwner;
          const executor = yield* Effect.flatten(HostedExecutor);
          const page = yield* executor.workflowInputs.list({ ...query, owner });
          const items = yield* Effect.filter(page.items, (input) =>
            requireWorkflowAccess(executor, owner, AppId.make(input.app), input.run).pipe(
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
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          yield* browserOnly;
          const owner = yield* currentOwner;
          const executor = yield* Effect.flatten(HostedExecutor);
          yield* requireAppAccess(params.app, "use");
          const input = yield* executor.workflowInputs.get({ ...params, owner });
          yield* requireWorkflowAccess(executor, owner, params.app, input.run);
          return input;
        }),
      )
      .handle("answer", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* browserOnly;
          const owner = yield* currentOwner;
          const executor = yield* Effect.flatten(HostedExecutor);
          yield* requireAppAccess(params.app, "use");
          const input = yield* executor.workflowInputs.get({ ...params, owner });
          yield* requireWorkflowAccess(executor, owner, params.app, input.run);
          return yield* executor.workflowInputs.answer({ ...params, ...payload, owner });
        }),
      )
      .handle("updateEvidence", ({ params, payload }) =>
        Effect.gen(function* () {
          const owner = yield* currentOwner;
          const executor = yield* Effect.flatten(HostedExecutor);
          yield* requireAppAccess(params.app, "use");
          const input = yield* executor.workflowInputs.get({ ...params, owner });
          yield* requireWorkflowAccess(executor, owner, params.app, input.run);
          return yield* executor.workflowInputs.updateEvidence({ ...params, ...payload, owner });
        }),
      )
      .handle("withdraw", ({ params }) =>
        Effect.gen(function* () {
          const owner = yield* currentOwner;
          const executor = yield* Effect.flatten(HostedExecutor);
          yield* requireAppAccess(params.app, "use");
          const input = yield* executor.workflowInputs.get({ ...params, owner });
          yield* requireWorkflowAccess(executor, owner, params.app, input.run);
          return yield* executor.workflowInputs.withdraw({ ...params, owner });
        }),
      ),
);
