/** Each request keeps its recorded creator and destination when several apps share one authorization. */
import type {
  Executor,
  OwnerId,
  OAuthAdditionalConnection,
  AccountConnectionId,
  AccountId,
} from "@executor-js/sdk/core";
import { Effect } from "effect";
import { HostedExecutor } from "../contracts/executor.ts";
import { ScheduleWakeup } from "../contracts/schedules.ts";
import { ownedConnection } from "./access.ts";
import { checkConnection } from "./connection-policy.ts";
import { accountDestination } from "./resource-lifecycle.ts";
import { requireAccountAccess } from "./resource-policy.ts";

/** Check every saved intent before discovery or exchange; hooks recheck them at the atomic commit. */
export const checkOAuthConnections = (
  executor: Executor,
  owner: OwnerId,
  input: {
    readonly connection: AccountConnectionId;
    readonly sourceAccount?: AccountId | null | undefined;
    readonly additionalConnections?: ReadonlyArray<OAuthAdditionalConnection> | undefined;
  },
) =>
  Effect.gen(function* () {
    const connection = yield* ownedConnection(executor, owner, input.connection);
    const intent = yield* checkConnection(connection);
    for (const selected of input.additionalConnections ?? connection.additionalConnections ?? [])
      yield* checkConnection(yield* ownedConnection(executor, owner, selected.connection));
    const source =
      input.sourceAccount === undefined ? connection.sourceAccount : input.sourceAccount;
    if (source != null) yield* requireAccountAccess(source, "use");
    return { connection, intent };
  });

export const planOAuth = (
  owner: OwnerId,
  input: Omit<Parameters<Executor["accountConnections"]["planOAuth"]>[0], "owner">,
) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* checkOAuthConnections(executor, owner, input);
    return yield* executor.accountConnections.planOAuth({ ...input, owner });
  });

export const reuseOAuth = (
  owner: OwnerId,
  input: Omit<Parameters<Executor["accountConnections"]["reuseOAuth"]>[0], "owner">,
) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const { intent } = yield* checkOAuthConnections(executor, owner, {
      ...input,
      sourceAccount: input.account,
    });
    return yield* executor.accountConnections.reuseOAuth({ ...input, owner }).pipe(
      accountDestination(intent.destination),
      Effect.tap(() => Effect.flatten(ScheduleWakeup)),
    );
  });

export const cancelConnection = (
  owner: OwnerId,
  input: { readonly connection: AccountConnectionId },
) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* checkOAuthConnections(executor, owner, input);
    return yield* executor.accountConnections.cancel({ ...input, owner });
  });
