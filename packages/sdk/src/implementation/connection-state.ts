/** Persisted connection transitions shared by secrets and OAuth completion. */
import { Clock, type Crypto, Effect, Option, Schema } from "effect";
import {
  AccountConnectionClosed,
  AccountConnectionFailure,
  AccountConnectionNotFound,
  type AccountConnectionState,
  type GetAccountConnection,
} from "../contracts/account-connection.ts";
import type { Account } from "../contracts/account.ts";
import { StorageError } from "../contracts/shared.ts";
import { StoredConnectionState, StoredConnectionTarget } from "../contracts/storage.ts";
import { applyConnectionTarget } from "./connection-target.ts";
import { query, transaction, type Query } from "./database.ts";

const StoredState = Schema.toCodecJson(StoredConnectionState);
const encodeState = Schema.encodeSync(StoredState);
const RecordedFailure = Schema.toCodecJson(AccountConnectionFailure);
const encodeFailure = Schema.encodeSync(RecordedFailure);
const decodeFailure = Schema.decodeUnknownOption(RecordedFailure);

/**
 * The recorded failure, read in this release's vocabulary. One it cannot read, such as a failure
 * whose reason a later release removed, describes an earlier sign-in. It is left out, so the
 * request stays readable and can start a new sign-in, and the span records that it was.
 */
const recordedFailure = (stored: Schema.Json | undefined) =>
  Effect.gen(function* () {
    if (stored === undefined) return {};
    const failure = decodeFailure(stored);
    if (Option.isSome(failure)) return { failure: failure.value };
    yield* Effect.annotateCurrentSpan("connection.failure.unreadable", true);
    return {};
  });

/** Parse a stored request and apply its optional owner constraint. */
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
    const target = yield* Schema.decodeUnknownEffect(Schema.NullOr(StoredConnectionTarget))(
      row.target,
    ).pipe(Effect.mapError(() => new StorageError()));
    const now = yield* Clock.currentTimeMillis;
    // An expired request keeps the failure that ended its latest sign-in.
    const state: AccountConnectionState =
      stored.status === "pending"
        ? {
            status: row.expiresAt.getTime() <= now ? "expired" : "pending",
            ...(yield* recordedFailure(stored.failure)),
          }
        : stored;
    return { ...row, target, state };
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

/** A parsed connection row. */
export type ConnectionRow = Effect.Success<ReturnType<typeof readConnection>>;
/** Reject a completed, cancelled or expired request. */
export const requireOpen = (input: typeof GetAccountConnection.Type, row: ConnectionRow) =>
  row.state.status === "pending"
    ? Effect.succeed(row)
    : Effect.fail(new AccountConnectionClosed(input));
/** Read and check outside a transaction; transactions check the row returned by `lockConnection`. */
export const openConnection = (db: Query, input: typeof GetAccountConnection.Type) =>
  Effect.flatMap(readConnection(db, input), (row) => requireOpen(input, row));
/**
 * Commit with the account write, never as a later, independently failing update. `claimed` is the
 * row `lockConnection` returned in this transaction. Writers claim the row first, so it is current.
 */
export const finishConnection = (db: Query, claimed: ConnectionRow, account: Account) =>
  Effect.gen(function* () {
    if (claimed.target !== null)
      yield* applyConnectionTarget(db, claimed.target, claimed.provider, account);
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

/**
 * Point a pending request at the sign-in that just started. That sign-in has no outcome yet, so
 * the failure recorded for an earlier one is cleared. Runs in the transaction that claimed `row`.
 */
export const startSignIn = (db: Query, row: ConnectionRow, attempt: string) =>
  query(() =>
    db.updateMany("accountConnections", {
      where: (b) => b("id", "=", row.id),
      set: { state: encodeState({ status: "pending" }), oauthAttempt: attempt },
    }),
  );

/**
 * Record why the request's latest sign-in failed, so agents reading the request learn what the
 * person connecting saw. `attempt` is the sign-in the failure ended, or for a failed start the
 * sign-in that was current when it began. When another sign-in has started since, or the request
 * is no longer pending, the newer state stands and nothing is recorded.
 */
export const recordSignInFailure = (
  db: Query,
  crypto: Crypto.Crypto,
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
