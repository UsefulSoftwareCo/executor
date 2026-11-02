/** Shared cloud/self-host policy for app-owned sign-ins. Each call rechecks the saved intent. */
import { InteractiveHost, type AccountConnectionId } from "@executor-js/sdk/core";
import { Effect } from "effect";
import { HostedExecutor } from "../contracts/executor.ts";
import { ScheduleWakeup } from "../contracts/schedules.ts";
import { currentOwner, ownedConnection } from "./access.ts";
import { checkConnection, connectionAccess } from "./connection-policy.ts";
import { accountDestination } from "./resource-lifecycle.ts";
import { activeVersion, versionAccounts } from "./app-accounts.ts";

const connectionContext = (connection: AccountConnectionId) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const owner = yield* currentOwner;
    const pending = yield* ownedConnection(executor, owner, connection);
    const access = yield* checkConnection(pending);
    const app = yield* executor.apps.get({ owner, app: pending.target.app });
    const accounts = yield* versionAccounts(
      activeVersion(app),
      undefined,
      pending.target.requirement,
    );
    return { executor, input: { owner, connection, accounts }, access };
  });

export const startInteractive = (connection: AccountConnectionId, method: string) =>
  Effect.gen(function* () {
    const { executor, input } = yield* connectionContext(connection);
    return yield* executor[InteractiveHost].start({ ...input, method });
  });

/** Status may complete the account, so it uses the same destination and wakeup as submit. */
export const interactiveStatus = (connection: AccountConnectionId) =>
  Effect.gen(function* () {
    const { executor, input, access } = yield* connectionContext(connection);
    return yield* executor[InteractiveHost].status(input).pipe(
      accountDestination(access.destination),
      Effect.tap((result) =>
        result.state === "connected" ? Effect.flatten(ScheduleWakeup) : Effect.void,
      ),
    );
  });
export const submitInteractive = (connection: AccountConnectionId, value: string) =>
  Effect.gen(function* () {
    const { executor, input, access } = yield* connectionContext(connection);
    return yield* executor[InteractiveHost].submit({ ...input, value }).pipe(
      accountDestination(access.destination),
      Effect.tap((result) =>
        result.state === "connected" ? Effect.flatten(ScheduleWakeup) : Effect.void,
      ),
    );
  });
export const cancelInteractive = (connection: AccountConnectionId) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const owner = yield* currentOwner;
    // The creator can release their attempt after the saved account is gone or changed.
    const access = yield* connectionAccess(connection);
    const app = yield* executor.apps.get({ owner, app: access.target.app });
    const accounts = yield* versionAccounts(
      activeVersion(app),
      undefined,
      access.target.requirement,
    );
    yield* executor[InteractiveHost].cancel({ owner, connection, accounts });
  });
