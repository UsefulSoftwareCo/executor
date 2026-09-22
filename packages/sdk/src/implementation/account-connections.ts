/** Reusable setup lifecycle. Hosts own access checks and browser links; optional targets select the saved account. */
import { Clock, type Crypto, Effect, Schema } from "effect";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import {
  type CreateAccountConnection,
  type GetAccountConnection,
  type SubmitAccountConnection,
} from "../contracts/account-connection.ts";
import { AccountNotFound } from "../contracts/account.ts";
import { AuthMethodInvalid, Provider, ProviderNotFound } from "../contracts/provider.ts";
import { StorageError, AccountConnectionId } from "../contracts/shared.ts";
import { StoredConnectionTarget, type Credentials } from "../contracts/storage.ts";
import { makeAccounts, ownedAccount } from "./accounts.ts";
import {
  openConnection,
  readConnection,
  finishConnection,
  lockConnection,
} from "./connection-state.ts";
import { captureConnectionTarget } from "./connection-target.ts";
import { query, transaction, type Query } from "./database.ts";

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
  const get = (input: typeof GetAccountConnection.Type) =>
    Effect.gen(function* () {
      const row = yield* readConnection(db, input);
      return {
        id: row.id,
        owner: row.owner,
        provider: yield* provider(row.provider),
        reconnectAccount:
          row.reconnectAccount === null
            ? null
            : yield* makeAccounts(db, credentials, crypto, lifecycle).get({
                account: row.reconnectAccount,
                owner: row.owner,
              }),
        target:
          row.target === null
            ? null
            : {
                app: row.target.app,
                requirement: row.target.requirement,
                name: row.target.name,
                ...(row.target.profile === undefined ? {} : { profile: row.target.profile }),
              },
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        state: row.state,
      };
    });
  return {
    get,
    create: (input: typeof CreateAccountConnection.Type) =>
      Effect.gen(function* () {
        const destination =
          input.target === undefined
            ? { provider: input.provider, snapshot: null }
            : yield* captureConnectionTarget(db, input.target);
        const resolved = destination.provider;
        yield* provider(resolved);
        if (input.account !== undefined) {
          const account = yield* ownedAccount(db, { account: input.account, owner: input.owner });
          if (account.provider !== resolved)
            return yield* new AccountNotFound({ account: input.account });
        }
        const id = AccountConnectionId.make(
          `con_${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()))}`,
        );
        const now = yield* Clock.currentTimeMillis;
        const target = yield* Schema.encodeEffect(Schema.NullOr(StoredConnectionTarget))(
          destination.snapshot,
        ).pipe(Effect.mapError(() => new StorageError()));
        yield* query(() =>
          db.create("accountConnections", {
            id,
            owner: input.owner,
            provider: resolved,
            target,
            reconnectAccount: input.account ?? null,
            state: { status: "pending" },
            oauthAttempt: null,
            revision: id,
            createdAt: new Date(now),
            expiresAt: new Date(now + 30 * 60_000),
          }),
        );
        return yield* get({ connection: id });
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
          return yield* get(input);
        }),
      ).pipe(Effect.withSpan("sdk.connections.cancel")),
    submit: (input: typeof SubmitAccountConnection.Type) =>
      transaction(db, (tx) =>
        Effect.gen(function* () {
          const saved = yield* lockConnection(tx, input, crypto);
          if (saved.state.status === "completed") return saved.state.account;
          const row = yield* openConnection(tx, input);
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
              label: input.label,
              fields: input.fields,
            });
          if (lifecycle) yield* lifecycle.connectionCompleting(input.connection);
          yield* finishConnection(tx, input, account);
          return account;
        }),
      ).pipe(Effect.withSpan("sdk.connections.submit")),
  };
};
