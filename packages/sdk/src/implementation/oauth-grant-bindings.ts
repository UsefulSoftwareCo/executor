/** Shared grants keep their encryption identity and renewal lock after individual bindings disappear. */
import { Clock, type Crypto, Effect, Redacted, Schema } from "effect";
import type { Credentials, StoredAccount } from "../contracts/storage.ts";
import { AccountId, JsonObject, StorageError, type ProviderId } from "../contracts/shared.ts";
import type { AccountIdentity } from "../contracts/account-identity.ts";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import type { OAuthGrant } from "../contracts/oauth.ts";
import { accountGrantId, identityPlacement } from "./account-identities.ts";
import { query, type Query } from "./database.ts";

/** Promotion leaves the account ID free for a later independent reconnect. Call under the grant's row lock. */
export const shareOAuthGrant = (
  db: Query,
  credentials: Credentials,
  crypto: Crypto.Crypto,
  source: StoredAccount,
  record: { readonly status: string; readonly updatedAt: Date },
  grant: OAuthGrant,
) =>
  Effect.gen(function* () {
    if (source.oauthGrantId !== null) return source.oauthGrantId;
    if (source.identityId === null) return yield* new StorageError();
    const id = AccountId.make(
      `acc_grant_${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()))}`,
    );
    const json = yield* Schema.decodeUnknownEffect(JsonObject)({
      ...grant,
      identityId: source.identityId,
    }).pipe(Effect.mapError(() => new StorageError()));
    const encrypted = yield* credentials.encrypt(id, Redacted.make(json));
    yield* query(() =>
      db.create("oauthGrants", {
        id,
        owner: source.owner,
        encrypted,
        status: record.status,
        updatedAt: record.updatedAt,
      }),
    );
    yield* query(() =>
      db.updateMany("accounts", {
        where: (b) => b("id", "=", source.id),
        set: { oauthGrantId: id },
      }),
    );
    yield* query(() => db.deleteMany("oauthGrants", { where: (b) => b("id", "=", source.id) }));
    return id;
  });

/** A binding stores its own policy and no copied token. Hosts resolve its destination after insertion. */
export const createSharedOAuthBinding = (
  db: Query,
  credentials: Credentials,
  crypto: Crypto.Crypto,
  lifecycle: ResourceLifecycle | undefined,
  source: Pick<StoredAccount, "owner" | "identityId">,
  identity: AccountIdentity,
  placement: string,
  input: {
    readonly provider: ProviderId;
    readonly method: string;
    readonly label: string;
    readonly grant: AccountId;
  },
) =>
  Effect.gen(function* () {
    if (source.identityId === null) return yield* new StorageError();
    const id = AccountId.make(
      `acc_${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()))}`,
    );
    const account = {
      id,
      owner: source.owner,
      provider: input.provider,
      method: input.method,
      label: input.label,
      description: null,
      createdAt: new Date(yield* Clock.currentTimeMillis),
      identity,
    };
    const encryptedCredentials = yield* credentials.encrypt(id, Redacted.make({}));
    yield* query(() =>
      db.create("accounts", {
        ...account,
        encryptedCredentials,
        identityId: source.identityId,
        oauthGrantId: input.grant,
      }),
    );
    if (lifecycle !== undefined) yield* lifecycle.accountCreated(account);
    if ((yield* identityPlacement(account, lifecycle)) !== placement) return undefined;
    return account;
  });

export const grantBindings = (db: Query, grant: AccountId) =>
  query(() =>
    db.findMany("accounts", {
      where: (b) =>
        b.or(
          b("oauthGrantId", "=", grant),
          b.and(b("id", "=", grant), b("oauthGrantId", "is", null)),
        ),
    }),
  );

/** Call after the binding was deleted or detached, inside the same transaction. */
export const releaseAccountGrant = (
  db: Query,
  account: Pick<StoredAccount, "id" | "oauthGrantId" | "provider">,
) =>
  Effect.gen(function* () {
    const id = accountGrantId(account);
    // Serializing shared releases makes the last concurrent removal responsible for cleanup.
    if (account.oauthGrantId !== null) {
      const saved = yield* query(() =>
        db.findFirst("oauthGrants", { where: (b) => b("id", "=", id) }),
      );
      if (saved === null) return undefined;
      yield* query(() =>
        db.updateMany("oauthGrants", {
          where: (b) => b("id", "=", id),
          set: { owner: saved.owner },
        }),
      );
    }
    const held = yield* grantBindings(db, id);
    if (held.length !== 0) return undefined;
    const grant = yield* query(() =>
      db.findFirst("oauthGrants", { where: (b) => b("id", "=", id) }),
    );
    yield* query(() => db.deleteMany("oauthGrants", { where: (b) => b("id", "=", id) }));
    return grant === null
      ? undefined
      : { account: id, provider: account.provider, encrypted: grant.encrypted };
  });
