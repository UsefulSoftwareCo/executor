import type {
  Executor,
  OwnerId,
  OAuthAdditionalConnection,
  AccountConnectionId,
  AccountId,
} from "@executor-js/sdk/core";
import { Effect } from "effect";
import { AccountTargets } from "../contracts/account-grants.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { ScheduleWakeup } from "../contracts/schedules.ts";
import { ownedConnection } from "./access.ts";
import { checkConnection } from "./connection-policy.ts";
import { AccountGrants } from "./proofs/account-access.ts";

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
    yield* checkConnection(connection);
    for (const selected of input.additionalConnections ?? connection.additionalConnections ?? [])
      yield* checkConnection(yield* ownedConnection(executor, owner, selected.connection));
    const source =
      input.sourceAccount === undefined ? connection.sourceAccount : input.sourceAccount;
    if (source != null)
      yield* AccountGrants.use.pipe(Effect.provideService(AccountTargets.use, { account: source }));
    return connection;
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
    yield* checkOAuthConnections(executor, owner, {
      ...input,
      sourceAccount: input.account,
    });
    return yield* executor.accountConnections
      .reuseOAuth({ ...input, owner })
      .pipe(Effect.tap(() => Effect.flatten(ScheduleWakeup)));
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
