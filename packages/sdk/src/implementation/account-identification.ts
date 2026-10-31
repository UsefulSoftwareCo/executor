/** Verify retained accounts without changing their IDs, selections, clients, or working credentials. */
import { Clock, type Crypto, Effect, Redacted, Schema } from "effect";
import type { Executor, ResourceLifecycle } from "../contracts/executor.ts";
import { Account } from "../contracts/account.ts";
import { Provider } from "../contracts/provider.ts";
import {
  OAuthGrant,
  OAuthServer,
  isFirstPartyGrant,
  type OAuthOptions,
} from "../contracts/oauth.ts";
import { JsonObject, StorageError } from "../contracts/shared.ts";
import type { Credentials } from "../contracts/storage.ts";
import { accountGrantId, accountIdentity, recordAccountIdentity } from "./account-identities.ts";
import { ownedAccount } from "./accounts.ts";
import { query, transaction, type Query } from "./database.ts";
import { makeOAuthProtocol } from "./oauth-protocol.ts";

export const makeAccountIdentification =
  (
    db: Query,
    credentials: Credentials,
    crypto: Crypto.Crypto,
    options: OAuthOptions | undefined,
    lifecycle: ResourceLifecycle | undefined,
  ) =>
  (input: Parameters<Executor["accounts"]["get"]>[0]) =>
    Effect.gen(function* () {
      const account = yield* ownedAccount(db, input);
      const shown = (identity?: Account["identity"]) =>
        Schema.decodeUnknownEffect(Account)({
          ...account,
          ...(identity === undefined ? {} : { identity }),
        }).pipe(Effect.mapError(() => new StorageError()));
      if (
        lifecycle !== undefined &&
        !(yield* lifecycle.accountsResolving([account])).has(account.id)
      )
        return yield* new StorageError();
      const identity = yield* accountIdentity(db, account, lifecycle);
      if (identity !== undefined || options === undefined) return yield* shown(identity);
      const row = yield* query(() =>
        db.findFirst("providers", { where: (b) => b("id", "=", account.provider) }),
      );
      if (row === null) return yield* shown();
      const provider = yield* Schema.decodeUnknownEffect(Provider)(row).pipe(
        Effect.mapError(() => new StorageError()),
      );
      const method = provider.definition.auth[account.method];
      if (
        method?.type !== "oauth2" ||
        method.grant === "client_credentials" ||
        method.identity === undefined
      )
        return yield* shown();
      const grantId = accountGrantId(account);
      const stored = yield* query(() =>
        db.findFirst("oauthGrants", { where: (b) => b("id", "=", grantId) }),
      );
      if (stored === null || !stored.status.startsWith("ready_")) return yield* shown();
      const grant = yield* credentials.decrypt(grantId, Redacted.make(stored.encrypted)).pipe(
        Effect.flatMap((value) => Schema.decodeUnknownEffect(OAuthGrant)(Redacted.value(value))),
        Effect.mapError(() => new StorageError()),
      );
      if (grant.grant === "client_credentials") return yield* shown();
      const token = grant.fields.access_token;
      if (typeof token !== "string" || token === "") return yield* shown();
      const operator = isFirstPartyGrant(grant)
        ? options.firstPartyClients?.find((client) => client.id === grant.firstParty)
        : undefined;
      if (isFirstPartyGrant(grant) && operator === undefined) return yield* shown();
      const server = yield* Schema.decodeUnknownEffect(OAuthServer)(
        isFirstPartyGrant(grant)
          ? {
              issuer: operator?.server.issuer ?? method.identity.issuer,
              authorization_endpoint: operator?.server.authorizationUrl,
              token_endpoint: operator?.server.tokenUrl,
            }
          : grant.server,
      ).pipe(Effect.mapError(() => new StorageError()));
      const verified = yield* makeOAuthProtocol(options)
        .identify(method.identity, server, token)
        .pipe(Effect.option);
      if (verified._tag === "None") return yield* shown();
      const proof = verified.value;
      const json = yield* Schema.decodeUnknownEffect(JsonObject)({
        ...grant,
        identity: { issuer: proof.issuer, subject: proof.subject },
      }).pipe(Effect.mapError(() => new StorageError()));
      const encrypted = yield* credentials.encrypt(grantId, Redacted.make(json));
      const ready = `ready_${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()))}`;
      const now = new Date(yield* Clock.currentTimeMillis);
      yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          if (
            lifecycle !== undefined &&
            !(yield* lifecycle.accountsResolving([account])).has(account.id)
          )
            return;
          const current = yield* ownedAccount(tx, input);
          if (
            current.credentialGeneration !== account.credentialGeneration ||
            accountGrantId(current) !== grantId
          )
            return;
          yield* query(() =>
            tx.updateMany("oauthGrants", {
              where: (b) =>
                b.and(
                  b("id", "=", grantId),
                  b("status", "=", stored.status),
                  b("encrypted", "=", stored.encrypted),
                ),
              set: { status: ready, encrypted },
            }),
          );
          const committed = yield* query(() =>
            tx.findFirst("oauthGrants", { where: (b) => b("id", "=", grantId) }),
          );
          if (committed?.status !== ready) return;
          yield* recordAccountIdentity(tx, crypto, lifecycle, current, proof, now);
        }),
      );
      const current = yield* ownedAccount(db, input);
      return yield* shown(yield* accountIdentity(db, current, lifecycle));
    }).pipe(Effect.withSpan("sdk.accounts.identify"));
