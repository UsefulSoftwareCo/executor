import { AccountWorkflowsActive } from "../contracts/account.ts";
import { AccountWebhooksActive } from "../contracts/account.ts";
/** Reusable account operations. Owners remain lookup predicates, not authorization. */
import { Clock, type Crypto, Effect, Redacted, Schema } from "effect";
import {
  Account,
  AccountNotFound,
  type AccountSignIn,
  type ManagedAccountInputs,
} from "../contracts/account.ts";
import { OAuthGrant } from "../contracts/oauth.ts";
import type { Executor, ResourceLifecycle } from "../contracts/executor.ts";
import { Provider, ProviderNotFound } from "../contracts/provider.ts";
import { AccountId, StorageError, type OwnerId, type ProviderId } from "../contracts/shared.ts";
import { StoredAccount, type Credentials } from "../contracts/storage.ts";
import { query, transaction, type Query } from "./database.ts";
import { validateFields } from "./provider.ts";

/** A stable digest of stored ciphertext; any credential write changes it. */
const fingerprint = (bytes: Uint8Array) =>
  Effect.promise(async () =>
    Array.from(
      new Uint8Array(
        await globalThis.crypto.subtle.digest(
          "SHA-256",
          new Uint8Array(bytes) as Uint8Array<ArrayBuffer>,
        ),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join(""),
  );

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

/**
 * An account created without a name starts with the owner's first free "Default" label for its
 * provider, so it can be named once its identity is known. Read inside the creating transaction.
 */
export const defaultLabel = (tx: Query, owner: OwnerId, provider: ProviderId) =>
  Effect.gen(function* () {
    const rows = yield* query(() =>
      tx.findMany("accounts", {
        select: ["label"],
        where: (b) => b.and(b("owner", "=", owner), b("provider", "=", provider)),
      }),
    );
    const labels = new Set(rows.map((row) => row.label));
    let label = "Default";
    for (let number = 2; labels.has(label); number++) label = `Default ${number}`;
    return label;
  });

/** Apply the caller's owner filter before reading or mutating a saved account. */
export const ownedAccount = (db: Query, input: Parameters<Executor["accounts"]["get"]>[0]) =>
  storedAccount(db, input.account, input.owner);

/** An encrypted OAuth grant whose account deletion has committed. */
export interface RemovedGrant {
  readonly account: AccountId;
  readonly provider: string;
  readonly encrypted: Uint8Array;
}

/** Bind account operations to caller-owned storage and credentials. */
export const makeAccounts = (
  db: Query,
  credentials: Credentials,
  crypto: Crypto.Crypto,
  lifecycle?: ResourceLifecycle,
  /** Best-effort provider-side revocation; it never fails and runs only after the delete commits. */
  revokeRemoved?: (removed: RemovedGrant) => Effect.Effect<void>,
) => ({
  add: (input: typeof ManagedAccountInputs.add.Type) =>
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
      const identity = {
        id: AccountId.make(
          `acc_${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()))}`,
        ),
        owner: input.owner,
        provider: provider.id,
        method: input.method,
        createdAt: new Date(yield* Clock.currentTimeMillis),
      };
      const encryptedCredentials = yield* credentials.encrypt(identity.id, fields);
      return yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          const account = {
            ...identity,
            label: input.label ?? (yield* defaultLabel(tx, input.owner, provider.id)),
            description: input.description ?? null,
          };
          yield* query(() => tx.create("accounts", { ...account, encryptedCredentials }));
          if (lifecycle) yield* lifecycle.accountCreated(account);
          return account;
        }),
      );
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
        const set = {
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.description === undefined ? {} : { description: input.description }),
        };
        yield* query(() =>
          tx.updateMany("accounts", { where: (b) => b("id", "=", account.id), set }),
        );
        return yield* Schema.decodeUnknownEffect(Account)({ ...account, ...set }).pipe(
          Effect.mapError(() => new StorageError()),
        );
      }),
    ).pipe(Effect.withSpan("sdk.accounts.update")),
  replaceCredentials: (input: typeof ManagedAccountInputs.replaceCredentials.Type) =>
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
            set: { encryptedCredentials, credentialGeneration: account.credentialGeneration + 1 },
          }),
        );
        return yield* Schema.decodeUnknownEffect(Account)(account).pipe(
          Effect.mapError(() => new StorageError()),
        );
      }),
    ).pipe(Effect.withSpan("sdk.accounts.replaceCredentials")),
  remove: (input: Parameters<Executor["accounts"]["remove"]>[0]) =>
    Effect.gen(function* () {
      const removed = yield* transaction(db, (tx) =>
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
            // A source whose subscriptions have all stopped goes with its account.
            yield* query(() =>
              tx.deleteMany("webhookSources", { where: (b) => b("account", "=", input.account) }),
            );
            const grant = yield* query(() =>
              tx.findFirst("oauthGrants", { where: (b) => b("id", "=", input.account) }),
            );
            yield* query(() =>
              tx.deleteMany("oauthGrants", { where: (b) => b("id", "=", input.account) }),
            );
            yield* query(() =>
              tx.deleteMany("accountChecks", { where: (b) => b("account", "=", input.account) }),
            );
            yield* query(() =>
              tx.deleteMany("accounts", { where: (b) => b("id", "=", input.account) }),
            );
            return grant === null
              ? undefined
              : { account: row.id, provider: row.provider, encrypted: grant.encrypted };
          }
          return undefined;
        }),
      );
      // Revoke only after the deletion is durable; the outcome cannot change the result.
      if (removed !== undefined && revokeRemoved !== undefined) yield* revokeRemoved(removed);
      // Saved choices keep the ID as an unresolved reference. An app must never silently switch accounts or run a partial collection.
      return { account: input.account };
    }).pipe(Effect.withSpan("sdk.accounts.remove")),
  list: (input: Parameters<Executor["accounts"]["list"]>[0]) =>
    Effect.gen(function* () {
      const rows = yield* query(() =>
        db.findMany("accounts", {
          select: ["id", "provider", "method", "label", "description", "owner", "createdAt"],
          where: (b) =>
            b.and(
              b("owner", "=", input.owner),
              input.provider === undefined ? true : b("provider", "=", input.provider),
            ),
          orderBy: ["id", "asc"],
        }),
      );
      return yield* Schema.decodeUnknownEffect(Schema.Array(Account))(rows).pipe(
        Effect.mapError(() => new StorageError()),
      );
    }).pipe(Effect.withSpan("sdk.accounts.list")),
  providers: (input: Parameters<Executor["accounts"]["providers"]>[0]) =>
    Effect.gen(function* () {
      const used = new Set(
        (yield* query(() =>
          db.findMany("accounts", {
            select: ["provider"],
            where: (b) => b("owner", "=", input.owner),
          }),
        )).map((row) => row.provider),
      );
      if (used.size === 0) return [];
      const rows = yield* query(() =>
        db.findMany("providers", {
          where: (b) => b("id", "in", [...used]),
          orderBy: ["id", "asc"],
        }),
      );
      return yield* Schema.decodeUnknownEffect(Schema.Array(Provider))(rows).pipe(
        Effect.mapError(() => new StorageError()),
      );
    }).pipe(Effect.withSpan("sdk.accounts.providers")),
  signIn: (input: Parameters<Executor["accounts"]["signIn"]>[0]) =>
    Effect.gen(function* () {
      const account = yield* ownedAccount(db, input);
      const credentialsFingerprint = yield* fingerprint(
        Redacted.value(account.encryptedCredentials),
      );
      const unavailable: AccountSignIn = { state: "unavailable", credentialsFingerprint };
      const row = yield* query(() =>
        db.findFirst("providers", { where: (b) => b("id", "=", account.provider) }),
      );
      if (row === null) return unavailable;
      const provider = yield* Schema.decodeUnknownEffect(Provider)(row).pipe(
        Effect.mapError(() => new StorageError()),
      );
      const method = provider.definition.auth[account.method];
      if (method === undefined) return unavailable;
      if (method.type === "secrets")
        return {
          state: "saved",
          reconnectAt: null,
          credentialsFingerprint,
        } satisfies AccountSignIn;
      const grant = yield* query(() =>
        db.findFirst("oauthGrants", { where: (b) => b("id", "=", account.id) }),
      );
      if (grant === null || grant.status === "reconnect")
        return { state: "reconnect", credentialsFingerprint } satisfies AccountSignIn;
      // A grant claimed by a renewal, including one a stopped process abandoned, still carries
      // the grant it started from; the next live resolve settles it.
      const decoded = yield* credentials.decrypt(account.id, Redacted.make(grant.encrypted)).pipe(
        Effect.flatMap((value) => Schema.decodeUnknownEffect(OAuthGrant)(Redacted.value(value))),
        Effect.option,
      );
      if (decoded._tag === "None") return unavailable;
      const saved = decoded.value;
      const reconnectAt =
        saved.grant !== "client_credentials" &&
        saved.refreshToken === undefined &&
        saved.expiresAt !== undefined
          ? new Date(saved.expiresAt)
          : null;
      const now = yield* Clock.currentTimeMillis;
      return reconnectAt !== null && reconnectAt.getTime() <= now
        ? ({ state: "reconnect", credentialsFingerprint } satisfies AccountSignIn)
        : ({ state: "saved", reconnectAt, credentialsFingerprint } satisfies AccountSignIn);
    }).pipe(Effect.withSpan("sdk.accounts.signIn")),
});
