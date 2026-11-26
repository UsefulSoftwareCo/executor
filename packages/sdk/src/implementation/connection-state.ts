import { Clock, Effect, Option, Schema } from "effect";
import type { HostCrypto } from "./host-crypto.ts";
import {
  AccountConnectionClosed,
  AccountConnectionFailure,
  AccountConnectionNotFound,
  type AccountConnectionState,
  type GetAccountConnection,
} from "../contracts/account-connection.ts";
import type { Account } from "../contracts/account.ts";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import { StorageError } from "../contracts/shared.ts";
import { StoredConnectionState, StoredConnectionTarget } from "../contracts/storage.ts";
import { applyConnectionTarget } from "./connection-target.ts";
import { query, transaction, type Query } from "./database.ts";

export const StoredState = Schema.toCodecJson(StoredConnectionState);
const encodeState = Schema.encodeSync(StoredState);
const RecordedFailure = Schema.toCodecJson(AccountConnectionFailure);
const encodeFailure = Schema.encodeSync(RecordedFailure);
const decodeFailure = Schema.decodeUnknownOption(RecordedFailure);

const recordedFailure = (stored: Schema.Json | undefined) =>
  Effect.gen(function* () {
    if (stored === undefined) return {};
    const failure = decodeFailure(stored);
    if (Option.isSome(failure)) return { failure: failure.value };
    yield* Effect.annotateCurrentSpan("connection.failure.unreadable", true);
    return {};
  });

export const readConnection = (db: Query, input: typeof GetAccountConnection.Type) =>
  Effect.gen(function* () {
    const row = yield* query(() =>
      db.findFirst("accountConnections", { where: (b) => b("id", "=", input.connection) }),
    );
    if (row === null || (input.owner !== undefined && row.owner !== input.owner))
      return yield* new AccountConnectionNotFound(input);
    const stored = yield* Schema.decodeUnknownEffect(StoredState)(row.state).pipe(
      Effect.mapError(() => new StorageError()),
    );
    const target = yield* Schema.decodeUnknownEffect(StoredConnectionTarget)(row.target).pipe(
      Effect.mapError(() => new StorageError()),
    );
    const now = yield* Clock.currentTimeMillis;
    const state: AccountConnectionState =
      stored.status === "pending"
        ? {
            status: row.expiresAt.getTime() <= now ? "expired" : "pending",
            ...(yield* recordedFailure(stored.failure)),
          }
        : stored;
    return { ...row, target, state };
  });
export const lockConnection = (
  db: Query,
  input: typeof GetAccountConnection.Type,
  crypto: HostCrypto,
) =>
  Effect.gen(function* () {
    const claim = yield* crypto.random.uuidV4();
    while (true) {
      const row = yield* readConnection(db, input);
      if (row.state.status !== "pending") return row;
      yield* query(() =>
        db.updateMany("accountConnections", {
          where: (b) => b.and(b("id", "=", row.id), b("revision", "=", row.revision)),
          set: { revision: claim },
        }),
      );
      const current = yield* readConnection(db, input);
      if (current.revision === claim || current.state.status !== "pending") return current;
    }
  });

export type ConnectionRow = Effect.Success<ReturnType<typeof readConnection>>;
export const requireOpen = (input: typeof GetAccountConnection.Type, row: ConnectionRow) =>
  row.state.status === "pending"
    ? Effect.succeed(row)
    : Effect.fail(new AccountConnectionClosed(input));
export const openConnection = (db: Query, input: typeof GetAccountConnection.Type) =>
  Effect.flatMap(readConnection(db, input), (row) => requireOpen(input, row));
export const finishConnection = (
  db: Query,
  claimed: ConnectionRow,
  account: Account,
  lifecycle: ResourceLifecycle | undefined,
) =>
  Effect.gen(function* () {
    yield* applyConnectionTarget(
      db,
      claimed.id,
      claimed.target,
      claimed.provider,
      account,
      lifecycle,
    );
    yield* query(() =>
      db.updateMany("accountConnections", {
        where: (b) => b("id", "=", claimed.id),
        set: {
          state: encodeState({ status: "completed", account }),
          oauthAttempt: null,
        },
      }),
    );
  });

export const startSignIn = (db: Query, row: ConnectionRow, attempt: string) =>
  query(() =>
    db.updateMany("accountConnections", {
      where: (b) => b("id", "=", row.id),
      set: { state: encodeState({ status: "pending" }), oauthAttempt: attempt },
    }),
  );

export const recordSignInFailure = (
  db: Query,
  crypto: HostCrypto,
  input: typeof GetAccountConnection.Type,
  attempt: string | null,
  error: AccountConnectionFailure["error"],
) =>
  Effect.gen(function* () {
    const at = new Date(yield* Clock.currentTimeMillis);
    yield* transaction(db, (tx) =>
      Effect.gen(function* () {
        const row = yield* lockConnection(tx, input, crypto);
        if (row.state.status !== "pending" || row.oauthAttempt !== attempt) return;
        yield* query(() =>
          tx.updateMany("accountConnections", {
            where: (b) => b("id", "=", row.id),
            set: {
              state: encodeState({ status: "pending", failure: encodeFailure({ at, error }) }),
            },
          }),
        );
      }),
    );
  }).pipe(Effect.withSpan("sdk.connections.recordSignInFailure"));
