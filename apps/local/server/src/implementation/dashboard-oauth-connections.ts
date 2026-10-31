/** Browser selection uses the saved local destination and never changes a request's owner or scope. */
import { Effect } from "effect";
import { AccountConnectionRefused } from "@executor-js/sdk/core";
import type {
  Executor,
  AccountConnectionId,
  AppId,
  PlanConnectionOAuth,
  StartConnectionOAuth,
  ReuseConnectionOAuth,
} from "@executor-js/sdk/core";
import { localOwner } from "./owners.ts";

export const dashboardOAuthConnections = (executor: Executor, managedApp: AppId | undefined) => {
  const authorize = (input: {
    readonly connection: AccountConnectionId;
    readonly additionalConnections?:
      | readonly { readonly connection: AccountConnectionId }[]
      | undefined;
  }) =>
    Effect.gen(function* () {
      for (const connection of [
        input.connection,
        ...(input.additionalConnections ?? []).map((entry) => entry.connection),
      ]) {
        const saved = yield* executor.accountConnections.get({ connection, owner: localOwner });
        if (saved.target.app === managedApp || saved.reconnectAccount !== null)
          return yield* new AccountConnectionRefused(saved.target);
        yield* executor.apps.get({ app: saved.target.app, owner: localOwner });
      }
    });
  return {
    plan: (input: Omit<typeof PlanConnectionOAuth.Type, "owner">) =>
      authorize(input).pipe(
        Effect.andThen(executor.accountConnections.planOAuth({ ...input, owner: localOwner })),
      ),
    reuse: (input: Omit<typeof ReuseConnectionOAuth.Type, "owner">) =>
      authorize(input).pipe(
        Effect.andThen(executor.accountConnections.reuseOAuth({ ...input, owner: localOwner })),
      ),
    start: (input: Omit<typeof StartConnectionOAuth.Type, "owner">) =>
      authorize(input).pipe(
        Effect.andThen(executor.accountConnections.startOAuth({ ...input, owner: localOwner })),
        Effect.map((signIn) => ({ ...signIn, connection: input.connection })),
      ),
    cancel: (connection: AccountConnectionId) =>
      authorize({ connection }).pipe(
        Effect.andThen(executor.accountConnections.cancel({ connection, owner: localOwner })),
      ),
  };
};
