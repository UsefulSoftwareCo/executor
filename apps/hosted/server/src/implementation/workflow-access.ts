import {
  WorkflowFailure,
  WorkflowRunId,
  type Executor,
  type StartWorkflow,
  type OwnerId,
  type AppId,
} from "@executor-js/sdk/core";
import { Effect } from "effect";
import { CurrentUserId } from "../contracts/auth.ts";
import { OrganizationForbidden } from "../contracts/organization.ts";
import { requireCurrentAppAccess, type ResourceAuthority } from "./resource-policy.ts";
import { checkScopedAccountsAs } from "./access.ts";
export const requireWorkflowAccess = (
  executor: Executor,
  owner: OwnerId,
  app: AppId,
  run: string,
) =>
  Effect.gen(function* () {
    const { actor } = yield* requireCurrentAppAccess(app, "use");
    return yield* workflowRunAccessAs(executor, owner, app, actor, run);
  });
export const workflowRunAccessAs = (
  executor: Executor,
  owner: OwnerId,
  app: AppId,
  actor: ResourceAuthority,
  run: string,
) =>
  Effect.gen(function* () {
    const saved = yield* executor.apps.workflowRuns
      .pinned({ owner, app, run: WorkflowRunId.make(run) })
      .pipe(
        Effect.catchTag("AppNotFound", () =>
          Effect.fail(new WorkflowFailure({ reason: "not_found", retryable: false })),
        ),
      );
    if (saved.actor !== null && saved.actor !== actor.user)
      return yield* new OrganizationForbidden();
    yield* checkScopedAccountsAs(actor, owner, app, saved.accounts);
    return saved;
  });

export const requireWorkflowReplayAccess = (
  executor: Executor,
  owner: OwnerId,
  app: AppId,
  input: Pick<typeof StartWorkflow.Type, "key">,
) =>
  Effect.gen(function* () {
    if (input.key === undefined) return;
    const actor = (yield* CurrentUserId) ?? null;
    const page = yield* executor.apps.workflowRuns.list({ app, key: input.key, limit: 100 });
    let retained: (typeof page.items)[number] | undefined;
    for (const item of page.items) {
      const pinned = yield* executor.apps.workflowRuns.pinned({ owner, app, run: item.id });
      if (pinned.actor === actor) {
        retained = item;
        break;
      }
    }
    if (retained !== undefined) yield* requireWorkflowAccess(executor, owner, app, retained.id);
  });
