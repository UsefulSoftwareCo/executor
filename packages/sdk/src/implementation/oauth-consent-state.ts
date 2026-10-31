/** Consent commits one verified grant and all its selected app bindings in the resource transaction. */
import { Clock, type Crypto, Effect, Redacted, Schema } from "effect";
import { Base64 } from "effect/encoding";
import { AccountConnectionRefused } from "../contracts/account-connection.ts";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import {
  OAuthCompletionFailed,
  OAuthGrant,
  isFirstPartyGrant,
  type OAuthAttemptRecord,
  type OAuthConsentSource,
  type OAuthAdditionalConnection,
} from "../contracts/oauth.ts";
import {
  JsonObject,
  StorageError,
  type AccountId,
  type AccountConnectionId,
  type OwnerId,
} from "../contracts/shared.ts";
import type { Credentials } from "../contracts/storage.ts";
import { accountGrantId, accountIdentity } from "./account-identities.ts";
import { defaultLabel, ownedAccount } from "./accounts.ts";
import {
  finishConnection,
  lockConnection,
  readConnection,
  requireOpen,
} from "./connection-state.ts";
import { requireTargetProvider } from "./connection-target.ts";
import { query, type Query } from "./database.ts";
import {
  createSharedOAuthBinding,
  shareOAuthGrant,
  grantBindings,
} from "./oauth-grant-bindings.ts";
import { canonical } from "./provider.ts";

/** All selected requests lock in the same order; each remains independently authorized and cancellable. */
export const lockOAuthConnections = (
  db: Query,
  crypto: Crypto.Crypto,
  input: {
    readonly connection: AccountConnectionId;
    readonly owner: OwnerId;
    readonly additionalConnections?: ReadonlyArray<OAuthAdditionalConnection> | undefined;
  },
  attempt?: string,
) =>
  Effect.gen(function* () {
    const ids = [
      input.connection,
      ...(input.additionalConnections ?? []).map((entry) => entry.connection),
    ];
    if (new Set(ids).size !== ids.length) return yield* new StorageError();
    for (const connection of [...ids].sort()) {
      const row = yield* requireOpen(
        { connection },
        yield* lockConnection(db, { connection, owner: input.owner }, crypto),
      );
      if (attempt !== undefined && row.oauthAttempt !== attempt)
        return yield* new OAuthCompletionFailed({ reason: "sign_in_replaced" });
      yield* requireTargetProvider(db, row);
    }
    return yield* readConnection(db, input);
  });

/** No refresh, reconnect, promotion, owner move, or identity change may replace the selected revision. */
export const lockOAuthConsentSource = (
  db: Query,
  credentials: Credentials,
  lifecycle: ResourceLifecycle | undefined,
  owner: OwnerId,
  selected: OAuthConsentSource,
) =>
  Effect.gen(function* () {
    const changed = () => new OAuthCompletionFailed({ reason: "grant_changed" });
    // Upgrades lock every affected binding in the same order before replacing their shared grant.
    for (const binding of (yield* grantBindings(db, selected.grant)).sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      yield* query(() =>
        db.updateMany("accounts", {
          where: (b) => b.and(b("id", "=", binding.id), b("owner", "=", owner)),
          set: { owner },
        }),
      );
    }
    const account = yield* ownedAccount(db, { account: selected.account, owner }).pipe(
      Effect.catchTag("AccountNotFound", () => Effect.fail(changed())),
    );
    if (
      account.credentialGeneration !== selected.generation ||
      accountGrantId(account) !== selected.grant ||
      account.identityId !== selected.identity
    )
      return yield* changed();
    if (lifecycle !== undefined && !(yield* lifecycle.accountsResolving([account])).has(account.id))
      return yield* changed();
    const identity = yield* accountIdentity(db, account, lifecycle);
    if (identity === undefined) return yield* changed();
    const read = yield* query(() =>
      db.findFirst("oauthGrants", { where: (b) => b("id", "=", selected.grant) }),
    );
    if (
      read === null ||
      !read.status.startsWith("ready_") ||
      Base64.encode(read.encrypted) !== selected.version
    )
      return yield* changed();
    yield* query(() =>
      db.updateMany("oauthGrants", {
        where: (b) =>
          b.and(
            b("id", "=", selected.grant),
            b("status", "=", read.status),
            b("encrypted", "=", read.encrypted),
          ),
        set: { status: read.status },
      }),
    );
    const record = yield* query(() =>
      db.findFirst("oauthGrants", { where: (b) => b("id", "=", selected.grant) }),
    );
    if (
      record === null ||
      record.status !== read.status ||
      Base64.encode(record.encrypted) !== selected.version
    )
      return yield* changed();
    const grant = yield* credentials.decrypt(selected.grant, Redacted.make(record.encrypted)).pipe(
      Effect.flatMap((value) => Schema.decodeUnknownEffect(OAuthGrant)(Redacted.value(value))),
      Effect.mapError(() => new StorageError()),
    );
    if (
      grant.grant === "client_credentials" ||
      grant.identity?.issuer !== selected.issuer ||
      grant.identity.subject !== selected.subject
    )
      return yield* changed();
    const proof = yield* query(() =>
      db.findFirst("accountIdentities", { where: (b) => b("id", "=", selected.identity) }),
    );
    if (proof === null) return yield* changed();
    return { account, identity, proof, grant, record };
  });

export const completeOAuthConsent = (
  db: Query,
  credentials: Credentials,
  crypto: Crypto.Crypto,
  lifecycle: ResourceLifecycle | undefined,
  input: {
    readonly attempt: typeof OAuthAttemptRecord.Type;
    readonly attemptId: string;
    readonly grant: OAuthGrant;
  },
) =>
  Effect.gen(function* () {
    const { attempt, grant } = input;
    if (attempt.consentSource === undefined && (attempt.additionalConnections?.length ?? 0) === 0)
      return;
    if (
      grant.grant === "client_credentials" ||
      grant.grantedScopes === undefined ||
      !(attempt.requestedScopes ?? []).every((scope) => grant.grantedScopes?.includes(scope))
    )
      return yield* new OAuthCompletionFailed({ reason: "scope_missing" });
    const primary = yield* ownedAccount(db, { account: attempt.account, owner: attempt.owner });
    const identity = yield* accountIdentity(db, primary, lifecycle);
    const proof =
      primary.identityId === null
        ? null
        : yield* query(() =>
            db.findFirst("accountIdentities", { where: (b) => b("id", "=", primary.identityId) }),
          );
    if (identity === undefined || proof === null)
      return yield* new OAuthCompletionFailed({ reason: "identity_mismatch" });
    const selected = attempt.consentSource;
    let root: AccountId;
    if (selected !== undefined) {
      if (
        grant.identity?.issuer !== selected.issuer ||
        grant.identity.subject !== selected.subject ||
        primary.identityId !== selected.identity
      )
        return yield* new OAuthCompletionFailed({ reason: "identity_mismatch" });
      const source = yield* lockOAuthConsentSource(
        db,
        credentials,
        lifecycle,
        attempt.owner,
        selected,
      );
      const oldClient = isFirstPartyGrant(source.grant)
        ? source.grant.authorizationClient
        : source.grant.client.client_id;
      if (
        isFirstPartyGrant(grant) !== isFirstPartyGrant(source.grant) ||
        grant.authorizationClient !== oldClient ||
        (isFirstPartyGrant(grant) &&
          isFirstPartyGrant(source.grant) &&
          grant.firstParty !== source.grant.firstParty)
      )
        return yield* new OAuthCompletionFailed({ reason: "client_unavailable" });
      root = yield* shareOAuthGrant(
        db,
        credentials,
        crypto,
        source.account,
        source.record,
        source.grant,
      );
      const json = yield* Schema.decodeUnknownEffect(JsonObject)({
        ...grant,
        identityId: selected.identity,
        ...(grant.refreshToken === undefined && source.grant.refreshToken !== undefined
          ? { refreshToken: source.grant.refreshToken }
          : {}),
      }).pipe(Effect.mapError(() => new StorageError()));
      const encrypted = yield* credentials.encrypt(root, Redacted.make(json));
      const status = `ready_${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()))}`;
      const updatedAt = new Date(yield* Clock.currentTimeMillis);
      yield* query(() =>
        db.updateMany("oauthGrants", {
          where: (b) => b("id", "=", root),
          set: { encrypted, status, updatedAt },
        }),
      );
      for (const binding of yield* grantBindings(db, root)) {
        yield* query(() =>
          db.updateMany("accounts", {
            where: (b) => b.and(b("id", "=", binding.id), b("oauthGrantId", "=", root)),
            set: { credentialGeneration: binding.credentialGeneration + 1 },
          }),
        );
      }
    } else {
      const record = yield* query(() =>
        db.findFirst("oauthGrants", { where: (b) => b("id", "=", primary.id) }),
      );
      if (record === null) return yield* new StorageError();
      root = yield* shareOAuthGrant(db, credentials, crypto, primary, record, grant);
    }
    const empty = yield* credentials.encrypt(primary.id, Redacted.make({}));
    yield* query(() =>
      db.updateMany("accounts", {
        where: (b) => b("id", "=", primary.id),
        set: { oauthGrantId: root, encryptedCredentials: empty },
      }),
    );
    yield* query(() => db.deleteMany("oauthGrants", { where: (b) => b("id", "=", primary.id) }));
    const selections = [
      { connection: attempt.connection, method: attempt.method },
      ...(attempt.additionalConnections ?? []),
    ];
    for (const selection of selections) {
      const row = yield* requireOpen(
        selection,
        yield* readConnection(db, { connection: selection.connection, owner: attempt.owner }),
      );
      if (row.oauthAttempt !== input.attemptId)
        return yield* new OAuthCompletionFailed({ reason: "sign_in_replaced" });
      const target = yield* requireTargetProvider(db, row);
      const method = target.definition.auth[selection.method];
      if (
        method?.type !== "oauth2" ||
        method.grant === "client_credentials" ||
        method.identity?.issuer !== proof.issuer ||
        canonical(method.response) !== canonical(grant.response)
      )
        return yield* new AccountConnectionRefused(row.target);
      const placement =
        lifecycle === undefined
          ? row.owner
          : yield* lifecycle.connectionIdentityPlacement?.(row) ?? Effect.succeed(null);
      if (placement !== proof.placement) return yield* new AccountConnectionRefused(row.target);
      if (selection.connection === attempt.connection) continue;
      const account = yield* createSharedOAuthBinding(
        db,
        credentials,
        crypto,
        lifecycle,
        primary,
        identity,
        proof.placement,
        {
          provider: row.provider,
          method: selection.method,
          grant: root,
          label: yield* defaultLabel(db, row.owner, row.provider),
        },
      );
      if (account === undefined) return yield* new AccountConnectionRefused(row.target);
      if (lifecycle !== undefined)
        yield* lifecycle.connectionCompleting({
          id: row.id,
          owner: row.owner,
          reconnectAccount: row.reconnectAccount,
          target: row.target,
        });
      yield* finishConnection(db, row, account, lifecycle);
    }
  });
