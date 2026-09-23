/** Persisted connection transitions shared by secrets and OAuth completion. */
import { Clock, type Crypto, Effect, Schema } from "effect";
import {
  AccountConnectionClosed,
  AccountConnectionNotFound,
  AccountConnectionState,
  type GetAccountConnection,
} from "../contracts/account-connection.ts";
import type { Account } from "../contracts/account.ts";
import { StorageError } from "../contracts/shared.ts";
import { StoredConnectionTarget } from "../contracts/storage.ts";
import { applyConnectionTarget } from "./connection-target.ts";
import { query, type Query } from "./database.ts";

/** Parse a stored request and apply its optional owner constraint. */
export const readConnection = (db: Query, input: typeof GetAccountConnection.Type) =>
  Effect.gen(function* () {
    const row = yield* query(() =>
      db.findFirst("accountConnections", { where: (b) => b("id", "=", input.connection) }),
    );
    if (row === null || (input.owner !== undefined && row.owner !== input.owner))
      return yield* new AccountConnectionNotFound(input);
    const state = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(AccountConnectionState))(
      row.state,
    ).pipe(Effect.mapError(() => new StorageError()));
    const target = yield* Schema.decodeUnknownEffect(Schema.NullOr(StoredConnectionTarget))(
      row.target,
    ).pipe(Effect.mapError(() => new StorageError()));
    const now = yield* Clock.currentTimeMillis;
    return {
      ...row,
      target,
      state:
        state.status === "pending" && row.expiresAt.getTime() <= now
          ? { status: "expired" as const }
          : state,
    };
  });
/** Claim by revision inside a transaction, including on databases without explicit row-lock APIs. */
export const lockConnection = (
  db: Query,
  input: typeof GetAccountConnection.Type,
  crypto: Crypto.Crypto,
) =>
  Effect.gen(function* () {
    const claim = yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()));
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

/** Check inside the committing transaction so cancellation and expiry win over late callbacks. */
export const openConnection = (db: Query, input: typeof GetAccountConnection.Type) =>
  Effect.gen(function* () {
    const row = yield* readConnection(db, input);
    if (row.state.status !== "pending") return yield* new AccountConnectionClosed(input);
    return row;
  });
/** Commit with the account write, never as a later, independently failing update. */
export const finishConnection = (
  db: Query,
  connection: typeof GetAccountConnection.Type,
  account: Account,
) =>
  Effect.gen(function* () {
    const row = yield* readConnection(db, connection);
    if (row.target !== null) yield* applyConnectionTarget(db, row.target, row.provider, account);
    yield* query(() =>
      db.updateMany("accountConnections", {
        where: (b) => b("id", "=", connection.connection),
        set: {
          state: Schema.encodeSync(Schema.toCodecJson(AccountConnectionState))({
            status: "completed",
            account,
          }),
          oauthAttempt: null,
        },
      }),
    );
  });
