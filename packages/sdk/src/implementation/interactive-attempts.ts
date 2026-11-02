/** Abandon a pending app session without ending the connection or holding SQL during cancel. */
import { type Crypto, Effect } from "effect";
import { CurrentActor, type ResourceLifecycle } from "../contracts/executor.ts";
import { AuthMethodInvalid } from "../contracts/provider.ts";
import type { AppAccounts } from "../contracts/apps.ts";
import type { Runtime } from "../contracts/runtime.ts";
import type { AccountConnectionId, OwnerId } from "../contracts/shared.ts";
import type { makeOAuth } from "./oauth.ts";
import { backgroundAccounts } from "./background-accounts.ts";
import { lockConnection, requireOpen, type ConnectionRow } from "./connection-state.ts";
import { requireTargetProvider } from "./connection-target.ts";
import { query, transaction, type Query } from "./database.ts";
import { pendingInteractive } from "./interactive-state.ts";
import { interactiveRunner } from "./interactive-runner.ts";

export const interactiveCancelMillis = 5_000;
export const makeInteractiveAttempts = (
  db: Query,
  crypto: Crypto.Crypto,
  runtime: Runtime,
  resolveAccount: ReturnType<typeof makeOAuth>["resolveSelected"],
  lifecycle?: ResourceLifecycle,
  hostApi?: import("../contracts/executor.ts").HostApi,
) => {
  const invoke = interactiveRunner(db, runtime, resolveAccount, hostApi);
  const cancelAttempt = (row: ConnectionRow, supplied?: AppAccounts) =>
    Effect.gen(function* () {
      const session = pendingInteractive(row);
      if (session?.session === undefined) return;
      const accounts =
        supplied ??
        (yield* backgroundAccounts(db, lifecycle, {
          app: row.target.app,
          version: session.version,
          actor: yield* CurrentActor,
          connecting: row.target.requirement,
        }));
      yield* invoke({
        owner: row.owner,
        accounts,
        acquisition: {
          app: row.target.app,
          slot: row.target.requirement,
          version: session.version,
        },
        command: {
          operation: "connect",
          slot: row.target.requirement,
          step: "cancel",
          input: { method: session.method, session: session.session },
        },
      });
    }).pipe(
      Effect.timeout(interactiveCancelMillis),
      Effect.catchCause(() =>
        Effect.logWarning("Abandoned interactive attempt cleanup did not finish"),
      ),
    );
  const clearAttempt = (input: {
    readonly owner?: OwnerId | undefined;
    readonly connection: AccountConnectionId;
    readonly method: string;
    readonly type: "secrets" | "oauth2";
  }) =>
    Effect.gen(function* () {
      const previous = yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          const row = yield* lockConnection(tx, input, crypto);
          if (row.state.status !== "pending" || pendingInteractive(row) === undefined)
            return undefined;
          yield* requireOpen(input, row);
          const provider = yield* requireTargetProvider(tx, row);
          const selected = Object.hasOwn(provider.definition.auth, input.method)
            ? provider.definition.auth[input.method]
            : undefined;
          if (selected?.type !== input.type)
            return yield* new AuthMethodInvalid({ provider: row.provider, method: input.method });
          yield* query(() =>
            tx.updateMany("accountConnections", {
              where: (b) => b("id", "=", row.id),
              set: { state: { status: "pending" }, oauthAttempt: null },
            }),
          );
          return row;
        }),
      );
      if (previous !== undefined) yield* cancelAttempt(previous);
    });
  return { cancelAttempt, clearAttempt };
};
