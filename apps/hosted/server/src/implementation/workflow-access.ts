/** Run history is protected by its pinned accounts, not a later replacement app binding. */
import {
  SelectedAccounts,
  StorageError,
  WorkflowFailure,
  type Executor,
  type OwnerId,
  type AppId,
} from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { policyDatabase, requireAppAccess } from "./resource-policy.ts";
import { checkAccounts } from "./access.ts";
/** Check current app use and every account that contributed to the retained run. */
export const requireWorkflowAccess = (
  executor: Executor,
  owner: OwnerId,
  app: AppId,
  run: string,
) =>
  Effect.gen(function* () {
    yield* requireAppAccess(app, "use");
    const sql = yield* policyDatabase;
    const rows =
      yield* sql`select accounts from executor_workflow_runs where id = ${run} and app = ${app} and owner = ${owner}`;
    const saved = (yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ accounts: SelectedAccounts })),
    )(rows))[0];
    if (saved === undefined)
      return yield* new WorkflowFailure({ reason: "not_found", retryable: false });
    yield* checkAccounts(executor, owner, saved.accounts);
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );
