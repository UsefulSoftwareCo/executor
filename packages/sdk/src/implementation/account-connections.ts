/** Reusable setup lifecycle. Hosts own access checks and browser links; each target selects the saved account. */
import { Clock, type Crypto, Effect, Schema } from "effect";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import {
  type CreateAccountConnection,
  type GetAccountConnection,
  type SubmitAccountConnection,
} from "../contracts/account-connection.ts";
import { Account, AccountNotFound } from "../contracts/account.ts";
import { AuthMethodInvalid, Provider, ProviderNotFound } from "../contracts/provider.ts";
import { StorageError, AccountConnectionId } from "../contracts/shared.ts";
import { StoredConnectionTarget, type Credentials } from "../contracts/storage.ts";
import { makeAccounts, ownedAccount } from "./accounts.ts";
import {
  type ConnectionRow,
  readConnection,
  requireOpen,
  finishConnection,
  lockConnection,
} from "./connection-state.ts";
import {
  captureConnectionTarget,
  requireTargetProvider,
  targetProvider,
} from "./connection-target.ts";
import { query, transaction, type Query } from "./database.ts";
import { storedProfile } from "./profiles.ts";

/** Requests survive host restarts. Pending requests expire after thirty minutes. */
export const makeAccountConnections = (
  db: Query,
  credentials: Credentials,
  crypto: Crypto.Crypto,
  lifecycle?: ResourceLifecycle,
) => {
  const provider = (id: typeof Provider.Type.id) =>
    Effect.gen(function* () {
      const row = yield* query(() => db.findFirst("providers", { where: (b) => b("id", "=", id) }));
      if (row === null) return yield* new ProviderNotFound({ provider: id });
      return yield* Schema.decodeUnknownEffect(Provider)(row).pipe(
        Effect.mapError(() => new StorageError()),
      );
    });
  const describe = (
    row: Pick<ConnectionRow, "id" | "owner" | "target" | "createdAt" | "expiresAt" | "state">,
    provider: Provider,
    reconnectAccount: Account | null,
  ) => ({
    id: row.id,
    owner: row.owner,
    provider,
    reconnectAccount,
    target:
      row.target === null
        ? null
        : {
            app: row.target.app,
            requirement: row.target.requirement,
            name: row.target.name,
            profile: row.target.profile,
          },
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    state: row.state,
  });
  /** A connection for an app shows that app's declaration, whose hosts it will grant. */
  const show = (row: ConnectionRow, shown: Provider | undefined) =>
    Effect.gen(function* () {
      return describe(
        row,
        shown ?? (yield* provider(row.provider)),
        row.reconnectAccount === null
          ? null
          : yield* makeAccounts(db, credentials, crypto, lifecycle).get({
              account: row.reconnectAccount,
              owner: row.owner,
            }),
      );
    });
  /** Ended requests keep showing the provider they used, even after their app changed. */
  const endedProvider = (row: ConnectionRow) =>
    row.target === null ? Effect.succeed(undefined) : targetProvider(db, row.target, row.provider);
  const get = (input: typeof GetAccountConnection.Type) =>
    Effect.gen(function* () {
      const row = yield* readConnection(db, input);
      // A pending request offers only a sign-in its app still accepts.
      return yield* show(
        row,
        row.state.status === "pending"
          ? yield* requireTargetProvider(db, row)
          : yield* endedProvider(row),
      );
    });
  return {
    get,
    create: (input: typeof CreateAccountConnection.Type) =>
      Effect.gen(function* () {
        const destination = yield* captureConnectionTarget(db, input.target);
        const resolved = yield* provider(destination.provider);
        let reconnectAccount: Account | null = null;
        if (input.account !== undefined) {
          const account = yield* ownedAccount(db, { account: input.account, owner: input.owner });
          if (account.provider !== resolved.id)
            return yield* new AccountNotFound({ account: input.account });
          reconnectAccount = yield* Schema.decodeUnknownEffect(Account)(account).pipe(
            Effect.mapError(() => new StorageError()),
          );
        }
        const id = AccountConnectionId.make(
          `con_${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()))}`,
        );
        const now = yield* Clock.currentTimeMillis;
        const target = yield* Schema.encodeEffect(StoredConnectionTarget)(
          destination.snapshot,
        ).pipe(Effect.mapError(() => new StorageError()));
        const created = {
          id,
          owner: input.owner,
          target: destination.snapshot,
          createdAt: new Date(now),
          expiresAt: new Date(now + 30 * 60_000),
          state: { status: "pending" as const },
        };
        yield* query(() =>
          db.create("accountConnections", {
            ...created,
            provider: resolved.id,
            target,
            reconnectAccount: input.account ?? null,
            oauthAttempt: null,
            revision: id,
          }),
        );
        const shown = yield* targetProvider(db, destination.snapshot, resolved.id);
        return describe(created, shown ?? resolved, reconnectAccount);
      }).pipe(Effect.withSpan("sdk.connections.create")),
    cancel: (input: typeof GetAccountConnection.Type) =>
      transaction(db, (tx) =>
        Effect.gen(function* () {
          const row = yield* lockConnection(tx, input, crypto);
          if (row.state.status === "pending")
            yield* query(() =>
              tx.updateMany("accountConnections", {
                where: (b) => b("id", "=", row.id),
                set: { state: { status: "cancelled" }, oauthAttempt: null },
              }),
            );
          // A request whose app has changed can still be cancelled.
          const cancelled = yield* readConnection(db, input);
          return yield* show(cancelled, yield* endedProvider(cancelled));
        }),
      ).pipe(Effect.withSpan("sdk.connections.cancel")),
    submit: (input: typeof SubmitAccountConnection.Type) =>
      transaction(db, (tx) =>
        Effect.gen(function* () {
          const saved = yield* lockConnection(tx, input, crypto);
          if (saved.state.status === "completed") return saved.state.account;
          const row = yield* requireOpen(input, saved);
          yield* requireTargetProvider(tx, row);
          const accounts = makeAccounts(tx, credentials, crypto, lifecycle);
          let account;
          if (row.reconnectAccount !== null) {
            const existing = yield* accounts.get({
              account: row.reconnectAccount,
              owner: row.owner,
            });
            if (existing.method !== input.method)
              return yield* new AuthMethodInvalid({ provider: row.provider, method: input.method });
            account = yield* accounts.replaceCredentials({
              account: existing.id,
              owner: row.owner,
              fields: input.fields,
            });
          } else
            account = yield* accounts.add({
              owner: row.owner,
              provider: row.provider,
              method: input.method,
              ...(input.label === undefined ? {} : { label: input.label }),
              fields: input.fields,
            });
          if (lifecycle)
            yield* lifecycle.connectionCompleting({
              id: row.id,
              owner: row.owner,
              reconnectAccount: row.reconnectAccount,
              target:
                row.target === null
                  ? null
                  : {
                      app: row.target.app,
                      profile: yield* storedProfile(tx, {
                        app: row.target.app,
                        profile: row.target.profile,
                      }),
                    },
            });
          yield* finishConnection(tx, row, account);
          return account;
        }),
      ).pipe(Effect.withSpan("sdk.connections.submit")),
  };
};
