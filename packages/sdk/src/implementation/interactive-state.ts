/** Acquisition provenance shares the completed connection's existing JSON column. */
import { Clock, type Crypto, Effect, Option, Schema } from "effect";
import { Account } from "../contracts/account.ts";
import {
  InteractiveBinding,
  InteractiveSession,
  InteractiveConnectionFailed,
  type InteractiveHost,
} from "../contracts/interactive-accounts.ts";
import { StorageError, type AccountId, type OwnerId } from "../contracts/shared.ts";
import { query, transaction, type Query } from "./database.ts";
import { storedApp, storedVersion } from "./apps.ts";
import { requireTargetProvider } from "./connection-target.ts";
import {
  StoredState,
  lockConnection,
  requireOpen,
  type ConnectionRow,
} from "./connection-state.ts";

const completed = Schema.toCodecJson(
  Schema.Struct({
    status: Schema.Literal("completed"),
    account: Account,
    interactive: InteractiveBinding,
  }),
);
const decodeCompleted = Schema.decodeUnknownOption(completed);

/** Read acquisition metadata once for a group of accounts, newest provenance first. */
export const interactiveBindings = (
  db: Query,
  input: { readonly accounts: ReadonlyArray<AccountId>; readonly owner?: OwnerId },
) =>
  Effect.gen(function* () {
    const bindings = new Map<AccountId, InteractiveBinding>();
    if (input.accounts.length === 0) return bindings;
    const wanted = new Set(input.accounts);
    const rows = yield* query(() =>
      db.findMany("accountConnections", {
        select: ["state"],
        where: (b) => (input.owner === undefined ? true : b("owner", "=", input.owner)),
        orderBy: ["createdAt", "desc"],
      }),
    );
    for (const row of rows) {
      const parsed = decodeCompleted(row.state);
      if (
        Option.isSome(parsed) &&
        wanted.has(parsed.value.account.id) &&
        !bindings.has(parsed.value.account.id)
      )
        bindings.set(parsed.value.account.id, parsed.value.interactive);
    }
    return bindings;
  });

/** An interactive account without provenance is never reusable in another app. */
export const interactiveBinding = (
  db: Query,
  input: { readonly account: AccountId; readonly owner?: OwnerId },
) =>
  interactiveBindings(db, {
    accounts: [input.account],
    ...(input.owner === undefined ? {} : { owner: input.owner }),
  }).pipe(Effect.map((bindings) => bindings.get(input.account)));

export const pendingInteractive = (row: ConnectionRow): InteractiveSession | undefined =>
  row.storedState.status === "pending" ? row.storedState.interactive : undefined;

const encode = Schema.encodeSync(StoredState);
/** The revision claim belongs to this transition, which runs inside its caller's transaction. */
export const writeInteractive = (db: Query, row: ConnectionRow, interactive: InteractiveSession) =>
  query(() =>
    db.updateMany("accountConnections", {
      where: (b) => b("id", "=", row.id),
      set: { state: encode({ status: "pending", interactive }), oauthAttempt: null },
    }),
  );

export type InteractiveInput = Parameters<InteractiveHost["status"]>[0];
export type InteractiveClaim = {
  readonly row: ConnectionRow;
  readonly session: InteractiveSession;
  readonly token: string;
};
/** Persist claims and their outcomes independently of handler execution. */
export const interactiveClaims = (
  db: Query,
  crypto: Crypto.Crypto,
  stepMillis: number,
  startMillis = stepMillis,
) => {
  const failure = () => new InteractiveConnectionFailed({ reason: "step" });
  const claim = (input: InteractiveInput, method?: string) =>
    transaction(db, (tx) =>
      Effect.gen(function* () {
        let row = yield* lockConnection(tx, input, crypto);
        if (method !== undefined && row.state.status === "cancelled") {
          const expiresAt = new Date((yield* Clock.currentTimeMillis) + 30 * 60_000);
          yield* query(() =>
            tx.updateMany("accountConnections", {
              where: (b) => b("id", "=", row.id),
              set: { state: { status: "pending" }, expiresAt },
            }),
          );
          row = {
            ...row,
            expiresAt,
            state: { status: "pending" },
            storedState: { status: "pending" },
          };
        }
        yield* requireOpen(input, row);
        const provider = yield* requireTargetProvider(tx, row);
        const now = yield* Clock.currentTimeMillis;
        const previous = pendingInteractive(row);
        if (method === undefined && previous?.running !== undefined) {
          // An expired lease is an uncertain invocation, not permission to repeat a mutation.
          if ((previous.leaseExpiresAt ?? 0) <= now)
            yield* writeInteractive(tx, row, {
              ...previous,
              failed: "The previous sign-in step did not finish. Cancel and start again.",
            });
          return undefined;
        }
        if (method === undefined && previous?.failed !== undefined) return yield* failure();
        if (
          method === undefined &&
          previous?.instructions?.expiresAt !== undefined &&
          previous.instructions.expiresAt <= now
        )
          return yield* failure();
        let session = previous;
        if (method !== undefined) {
          const selected = Object.hasOwn(provider.definition.auth, method)
            ? provider.definition.auth[method]
            : undefined;
          if (selected?.type !== "interactive") return yield* failure();
          if (
            previous?.method === method &&
            previous.running !== undefined &&
            (previous.leaseExpiresAt ?? 0) > now &&
            previous.failed === undefined &&
            (previous.instructions?.expiresAt === undefined ||
              previous.instructions.expiresAt > now)
          )
            return undefined;
          const app = yield* storedApp(tx, { app: row.target.app, owner: row.target.owner });
          const version = yield* storedVersion(tx, app);
          session = { method, version: version.id };
          if (row.reconnectAccount !== null) {
            const previous = yield* interactiveBinding(tx, {
              account: row.reconnectAccount,
              owner: row.owner,
            });
            if (previous !== undefined) return yield* failure();
          }
        }
        if (session === undefined) return yield* failure();
        const token = yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()));
        const claimed = {
          ...session,
          running: token,
          leaseExpiresAt: now + (method === undefined ? stepMillis : startMillis),
        };
        yield* writeInteractive(tx, row, claimed);
        return { row, session: claimed, token };
      }),
    );
  const current = (tx: Query, input: InteractiveInput, claimed: InteractiveClaim) =>
    Effect.gen(function* () {
      const row = yield* requireOpen(input, yield* lockConnection(tx, input, crypto));
      if (pendingInteractive(row)?.running !== claimed.token) return yield* failure();
      yield* requireTargetProvider(tx, row);
      return row;
    });
  const settled = (session: InteractiveSession): InteractiveSession => {
    const { running: _running, leaseExpiresAt: _lease, ...rest } = session;
    return rest;
  };
  const recordFailure = (input: InteractiveInput, claimed: InteractiveClaim) =>
    transaction(db, (tx) =>
      Effect.gen(function* () {
        const row = yield* lockConnection(tx, input, crypto);
        if (row.state.status !== "pending" || pendingInteractive(row)?.running !== claimed.token)
          return;
        yield* writeInteractive(tx, row, {
          ...settled(claimed.session),
          failed: "The app could not finish this sign-in step. Cancel and start again.",
        });
      }),
    ).pipe(
      Effect.catch(() => Effect.logWarning("Interactive sign-in failure could not be recorded")),
    );
  return { claim, current, recordFailure, settled };
};
