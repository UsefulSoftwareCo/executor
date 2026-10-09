/** Run history is protected by its pinned accounts, not a later replacement app binding. */
import {
  WorkflowFailure,
  WorkflowRunId,
  type Executor,
  type StartWorkflow,
  type OwnerId,
  type AppId,
} from "@executor-js/sdk/core";
import { Effect } from "effect";
import { requireAppAccess } from "./resource-policy.ts";
import { checkAccounts, ownProfile } from "./access.ts";
/** Check current app use and every account that contributed to the retained run. */
export const requireWorkflowAccess = (
  executor: Executor,
  owner: OwnerId,
  app: AppId,
  run: string,
) =>
  Effect.gen(function* () {
    yield* requireAppAccess(app, "use");
    const saved = yield* executor.apps.workflowRuns
      .pinned({ owner, app, run: WorkflowRunId.make(run) })
      .pipe(
        Effect.catchTag("AppNotFound", () =>
          Effect.fail(new WorkflowFailure({ reason: "not_found", retryable: false })),
        ),
      );
    if (saved.profile !== null) yield* ownProfile(executor, owner, app, saved.profile);
    yield* checkAccounts(owner, saved.accounts);
    return saved;
  });

/** Authorize a retained idempotency key before start can wake its saved execution. */
export const requireWorkflowReplayAccess = (
  executor: Executor,
  owner: OwnerId,
  app: AppId,
  input: Pick<typeof StartWorkflow.Type, "key" | "profile">,
) =>
  Effect.gen(function* () {
    if (input.key === undefined) return;
    const page = yield* executor.apps.workflowRuns.list({
      app,
      key: input.key,
      ...(input.profile === undefined ? {} : { profile: input.profile }),
      limit: 1,
    });
    const retained = page.items.find((item) => (item.profile ?? undefined) === input.profile);
    if (retained !== undefined) yield* requireWorkflowAccess(executor, owner, app, retained.id);
  });
