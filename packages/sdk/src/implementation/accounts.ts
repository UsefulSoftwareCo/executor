import { AccountWorkflowsActive } from "../contracts/account.ts";
import { AccountWebhooksActive } from "../contracts/account.ts";
/** Reusable account operations. Owners remain lookup predicates, not authorization. */
import { Clock, type Crypto, Effect, Schema } from "effect";
import { Account, AccountNotFound } from "../contracts/account.ts";
import type { Executor, ResourceLifecycle } from "../contracts/executor.ts";
import { Provider, ProviderNotFound } from "../contracts/provider.ts";
import { AccountId, StorageError, type OwnerId } from "../contracts/shared.ts";
import { StoredAccount, type Credentials } from "../contracts/storage.ts";
import { query, transaction, type Query } from "./database.ts";
import { validateFields } from "./provider.ts";

/** Load private account data without exposing it through public account responses. */
export const storedAccount = (db: Query, account: AccountId, owner?: OwnerId) =>
  Effect.gen(function* () {
    const row = yield* query(() =>
      db.findFirst("accounts", {
        where: (b) =>
          b.and(b("id", "=", account), owner === undefined ? true : b("owner", "=", owner)),
      }),
    );
    if (row === null) return yield* Effect.fail(new AccountNotFound({ account }));
    return yield* Schema.decodeUnknownEffect(StoredAccount)(row).pipe(
      Effect.mapError(() => new StorageError()),
    );
  });

/** Apply the caller's owner filter before reading or mutating a saved account. */
export const ownedAccount = (db: Query, input: Parameters<Executor["accounts"]["get"]>[0]) =>
  storedAccount(db, input.account, input.owner);

/** Bind account operations to caller-owned storage and credentials. */
export const makeAccounts = (
  db: Query,
  credentials: Credentials,
  crypto: Crypto.Crypto,
  lifecycle?: ResourceLifecycle,
) => ({
  add: (input: Parameters<Executor["accounts"]["add"]>[0]) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        db.findFirst("providers", { where: (b) => b("id", "=", input.provider) }),
      );
      if (row === null)
        return yield* Effect.fail(new ProviderNotFound({ provider: input.provider }));
      const provider = yield* Schema.decodeUnknownEffect(Provider)(row).pipe(
        Effect.mapError(() => new StorageError()),
      );
      const fields = yield* validateFields(
        provider.id,
        provider.definition,
        input.method,
        input.fields,
      );
      const account = {
        id: AccountId.make(
          `acc_${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()))}`,
        ),
        owner: input.owner,
        provider: provider.id,
        method: input.method,
        label: input.label,
        createdAt: new Date(yield* Clock.currentTimeMillis),
      };
      const encryptedCredentials = yield* credentials.encrypt(account.id, fields);
      yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          yield* query(() => tx.create("accounts", { ...account, encryptedCredentials }));
          if (lifecycle) yield* lifecycle.accountCreated(account);
        }),
      );
      return account;
    }).pipe(Effect.withSpan("sdk.accounts.add")),
  get: (input: Parameters<Executor["accounts"]["get"]>[0]) =>
    Effect.gen(function* () {
      const row = yield* ownedAccount(db, input);
      return yield* Schema.decodeUnknownEffect(Account)(row).pipe(
        Effect.mapError(() => new StorageError()),
      );
    }).pipe(Effect.withSpan("sdk.accounts.get")),
  provider: (input: Parameters<Executor["accounts"]["provider"]>[0]) =>
    Effect.gen(function* () {
      const account = yield* ownedAccount(db, input);
      const row = yield* query(() =>
        db.findFirst("providers", { where: (b) => b("id", "=", account.provider) }),
      );
      if (row === null) return yield* new ProviderNotFound({ provider: account.provider });
      return yield* Schema.decodeUnknownEffect(Provider)(row).pipe(
        Effect.mapError(() => new StorageError()),
      );
    }).pipe(Effect.withSpan("sdk.accounts.provider")),
  update: (input: Parameters<Executor["accounts"]["update"]>[0]) =>
    transaction(db, (tx) =>
      Effect.gen(function* () {
        const account = yield* ownedAccount(tx, input);
        yield* query(() =>
          tx.updateMany("accounts", {
            where: (b) => b("id", "=", account.id),
            set: { label: input.label },
          }),
        );
        return yield* Schema.decodeUnknownEffect(Account)({ ...account, label: input.label }).pipe(
          Effect.mapError(() => new StorageError()),
        );
      }),
    ).pipe(Effect.withSpan("sdk.accounts.update")),
  replaceCredentials: (input: Parameters<Executor["accounts"]["replaceCredentials"]>[0]) =>
    transaction(db, (tx) =>
      Effect.gen(function* () {
        const account = yield* ownedAccount(tx, input);
        const row = yield* query(() =>
          tx.findFirst("providers", { where: (b) => b("id", "=", account.provider) }),
        );
        if (row === null) return yield* new ProviderNotFound({ provider: account.provider });
        const provider = yield* Schema.decodeUnknownEffect(Provider)(row).pipe(
          Effect.mapError(() => new StorageError()),
        );
        const fields = yield* validateFields(
          account.provider,
          provider.definition,
          account.method,
          input.fields,
        );
        const encryptedCredentials = yield* credentials.encrypt(account.id, fields);
        yield* query(() =>
          tx.updateMany("accounts", {
            where: (b) => b("id", "=", account.id),
            set: { encryptedCredentials },
          }),
        );
        return yield* Schema.decodeUnknownEffect(Account)(account).pipe(
          Effect.mapError(() => new StorageError()),
        );
      }),
    ).pipe(Effect.withSpan("sdk.accounts.replaceCredentials")),
  remove: (input: Parameters<Executor["accounts"]["remove"]>[0]) =>
    transaction(db, (tx) =>
      Effect.gen(function* () {
        const row = yield* query(() =>
          tx.findFirst("accounts", {
            where: (b) =>
              b.and(
                b("id", "=", input.account),
                input.owner === undefined ? true : b("owner", "=", input.owner),
              ),
          }),
        );
        if (row !== null) {
          yield* query(() =>
            tx.updateMany("accounts", {
              where: (b) => b("id", "=", row.id),
              set: { createdAt: row.createdAt },
            }),
          );
          const linked = yield* query(() =>
            tx.findFirst("webhookAccounts", { where: (b) => b("account", "=", row.id) }),
          );
          if (linked !== null) return yield* new AccountWebhooksActive({ account: row.id });
          const workflow = yield* query(() =>
            tx.findFirst("workflowAccounts", { where: (b) => b("account", "=", row.id) }),
          );
          if (workflow !== null) return yield* new AccountWorkflowsActive({ account: row.id });
          if (lifecycle) {
            const account = yield* Schema.decodeUnknownEffect(Account)(row).pipe(
              Effect.mapError(() => new StorageError()),
            );
            yield* lifecycle.accountRemoving(account);
          }
          yield* query(() =>
            tx.deleteMany("oauthGrants", { where: (b) => b("id", "=", input.account) }),
          );
          yield* query(() =>
            tx.deleteMany("accounts", { where: (b) => b("id", "=", input.account) }),
          );
        }
        // Keep selected IDs as unresolved references. An app must never silently switch accounts or run a partial collection.
        return { account: input.account };
      }),
    ).pipe(Effect.withSpan("sdk.accounts.remove")),
  list: (input: NonNullable<Parameters<Executor["accounts"]["list"]>[0]> = {}) =>
    Effect.gen(function* () {
      const rows = yield* query(() =>
        db.findMany("accounts", {
          select: ["id", "provider", "method", "label", "owner", "createdAt"],
          where: (b) =>
            b.and(
              input.owner === undefined ? true : b("owner", "=", input.owner),
              input.provider === undefined ? true : b("provider", "=", input.provider),
            ),
          orderBy: ["id", "asc"],
        }),
      );
      return yield* Schema.decodeUnknownEffect(Schema.Array(Account))(rows).pipe(
        Effect.mapError(() => new StorageError()),
      );
    }).pipe(Effect.withSpan("sdk.accounts.list")),
});
