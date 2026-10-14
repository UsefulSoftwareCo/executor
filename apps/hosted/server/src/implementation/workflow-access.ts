/** Run history is protected by its actor and pinned accounts, not a later replacement link. */
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
import { requireAppAccess } from "./resource-policy.ts";
import { checkScopedAccounts } from "./access.ts";
/**
 * Check current app use, that the run is the caller's own or was started without an actor, and
 * every account that contributed to the retained run, by the scope its requirement had on the
 * run's pinned deployment: an app account by its current app link, a user account by the caller's
 * use.
 */
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
    if (saved.actor !== null && saved.actor !== (yield* CurrentUserId))
      return yield* new OrganizationForbidden();
    yield* checkScopedAccounts(owner, app, saved.accounts);
    return saved;
  });

/** Authorize a retained idempotency key before start can wake its saved execution. */
export const requireWorkflowReplayAccess = (
  executor: Executor,
  owner: OwnerId,
  app: AppId,
  input: Pick<typeof StartWorkflow.Type, "key">,
) =>
  Effect.gen(function* () {
    if (input.key === undefined) return;
    const actor = (yield* CurrentUserId) ?? null;
    // The SDK reuses a run with this key started by the same actor; other actors' runs with the
    // same key stay theirs.
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
