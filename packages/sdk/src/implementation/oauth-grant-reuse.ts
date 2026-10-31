/** A connection can borrow one covering grant; permission labels from separate grants never combine. */
import { Clock, type Crypto, Effect, Redacted, Schema } from "effect";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import { Account } from "../contracts/account.ts";
import {
  AccountConnectionRefused,
  type ReuseConnectionOAuth,
} from "../contracts/account-connection.ts";
import { AuthMethodInvalid } from "../contracts/provider.ts";
import { AccountId, JsonObject, StorageError } from "../contracts/shared.ts";
import {
  OAuthGrant,
  OAuthSetupFailed,
  isFirstPartyGrant,
  allowedScopes,
  type OAuthOptions,
} from "../contracts/oauth.ts";
import type { Credentials } from "../contracts/storage.ts";
import { accountGrantId, accountIdentity, identityPlacement } from "./account-identities.ts";
import { ownedAccount, defaultLabel } from "./accounts.ts";
import { lockApp } from "./apps.ts";
import {
  readConnection,
  lockConnection,
  requireOpen,
  finishConnection,
} from "./connection-state.ts";
import { requireTargetProvider } from "./connection-target.ts";
import { query, transaction, type Query } from "./database.ts";
import { makeOAuthProtocol } from "./oauth-protocol.ts";
import { canonical } from "./provider.ts";

export const makeOAuthGrantReuse =
  (
    db: Query,
    credentials: Credentials,
    crypto: Crypto.Crypto,
    options: OAuthOptions | undefined,
    lifecycle: ResourceLifecycle | undefined,
  ) =>
  (input: typeof ReuseConnectionOAuth.Type) =>
    Effect.gen(function* () {
      const request = yield* readConnection(db, input);
      if (request.state.status === "completed")
        return { status: "completed" as const, account: request.state.account };
      yield* requireOpen(input, request);
      const target = yield* requireTargetProvider(db, request);
      const method = target.definition.auth[input.method];
      if (method === undefined || method.type !== "oauth2" || method.grant === "client_credentials")
        return yield* new AuthMethodInvalid({ provider: target.id, method: input.method });
      const consent = (
        reason: "identity" | "placement" | "client" | "resource" | "scopes" | "busy",
      ) => ({ status: "consent-required" as const, reason });
      const declaration = method.identity;
      if (declaration === undefined) return consent("identity");
      if (options === undefined) return yield* new OAuthSetupFailed({ reason: "unsupported" });
      const discovered = yield* makeOAuthProtocol(options)
        .discover(method)
        .pipe(Effect.mapError(() => new OAuthSetupFailed({ reason: "discovery_invalid" })));
      return yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          const lockedConnection = yield* lockConnection(tx, input, crypto);
          if (lockedConnection.state.status === "completed")
            return { status: "completed" as const, account: lockedConnection.state.account };
          const current = yield* requireOpen(input, lockedConnection);
          yield* lockApp(tx, { app: current.target.app, owner: current.target.owner });
          const source = yield* ownedAccount(tx, { account: input.account, owner: current.owner });
          const refused = () =>
            new AccountConnectionRefused({
              app: current.target.app,
              requirement: current.target.requirement,
            });
          if (
            lifecycle !== undefined &&
            !(yield* lifecycle.accountsResolving([source])).has(source.id)
          )
            return yield* refused();
          // Reuse creates an exact provider binding. Reconnecting an existing one needs the consent path.
          if (current.reconnectAccount !== null) return consent("identity");
          yield* query(() =>
            tx.updateMany("accounts", {
              where: (b) => b("id", "=", source.id),
              set: { owner: source.owner },
            }),
          );
          const live = yield* ownedAccount(tx, { account: source.id, owner: current.owner });
          const identity = yield* accountIdentity(tx, live, lifecycle);
          if (identity === undefined || live.identityId === null) return consent("identity");
          const proof = yield* query(() =>
            tx.findFirst("accountIdentities", { where: (b) => b("id", "=", live.identityId) }),
          );
          if (proof === null || proof.issuer !== declaration.issuer) return consent("identity");
          const oldId = accountGrantId(live);
          const read = yield* query(() =>
            tx.findFirst("oauthGrants", { where: (b) => b("id", "=", oldId) }),
          );
          if (read === null || read.status === "reconnect") return consent("identity");
          if (!read.status.startsWith("ready_")) return consent("busy");
          // Lock the exact ready revision before promotion; an in-flight renewal keeps its own lock.
          yield* query(() =>
            tx.updateMany("oauthGrants", {
              where: (b) => b.and(b("id", "=", oldId), b("status", "=", read.status)),
              set: { status: read.status },
            }),
          );
          const locked = yield* query(() =>
            tx.findFirst("oauthGrants", { where: (b) => b("id", "=", oldId) }),
          );
          if (locked?.status !== read.status) return consent("busy");
          const grant = yield* credentials.decrypt(oldId, Redacted.make(locked.encrypted)).pipe(
            Effect.flatMap((value) =>
              Schema.decodeUnknownEffect(OAuthGrant)(Redacted.value(value)),
            ),
            Effect.mapError(() => new StorageError()),
          );
          if (
            grant.grant === "client_credentials" ||
            (live.oauthGrantId !== null && grant.identityId !== live.identityId) ||
            grant.identity?.issuer !== proof.issuer ||
            grant.identity.subject !== proof.subject
          )
            return consent("identity");
          if (canonical(grant.response) !== canonical(method.response)) return consent("client");
          const operator = isFirstPartyGrant(grant)
            ? options.firstPartyClients?.find((client) => client.id === grant.firstParty)
            : undefined;
          if (
            isFirstPartyGrant(grant) &&
            (operator === undefined || grant.authorizationClient !== operator.clientId)
          )
            return consent("client");
          const server = isFirstPartyGrant(grant) ? operator?.server : undefined;
          const authorization = isFirstPartyGrant(grant)
            ? server?.authorizationUrl
            : grant.server.authorization_endpoint;
          const token = isFirstPartyGrant(grant) ? server?.tokenUrl : grant.server.token_endpoint;
          if (
            authorization !== discovered.server.authorization_endpoint ||
            token !== discovered.server.token_endpoint
          )
            return consent("client");
          if (
            !isFirstPartyGrant(grant) &&
            method.tokenEndpointAuthMethod !== undefined &&
            method.tokenEndpointAuthMethod !== grant.client.token_endpoint_auth_method
          )
            return consent("client");
          const resource = isFirstPartyGrant(grant) ? server?.resource : grant.resource;
          if (resource !== discovered.resource) return consent("resource");
          // With inferred audiences (for example Microsoft), different API scopes can name different audiences.
          if (
            discovered.resourceSource === "inferred_scope_audience" &&
            canonical(grant.requestedScopes ?? []) !== canonical(discovered.scopes)
          )
            return consent("resource");
          const scopes =
            discovered.scopes.length === 0 && operator !== undefined
              ? operator.defaultScopes
              : discovered.scopes;
          if (
            operator !== undefined &&
            !scopes.every((scope) => allowedScopes(operator).includes(scope))
          )
            return consent("client");
          if (
            grant.grantedScopes === undefined ||
            !scopes.every((scope) => grant.grantedScopes?.includes(scope))
          )
            return consent("scopes");
          const id = AccountId.make(
            `acc_${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()))}`,
          );
          const account = {
            id,
            owner: current.owner,
            provider: current.provider,
            method: input.method,
            label: input.label ?? (yield* defaultLabel(tx, current.owner, current.provider)),
            description: null,
            createdAt: new Date(yield* Clock.currentTimeMillis),
            identity,
          };
          // OAuth reads its grant directly; the new binding stores no copied access or refresh token.
          const encryptedCredentials = yield* credentials.encrypt(id, Redacted.make({}));
          yield* query(() =>
            tx.create("accounts", {
              id: account.id,
              owner: account.owner,
              provider: account.provider,
              method: account.method,
              label: account.label,
              description: account.description,
              createdAt: account.createdAt,
              encryptedCredentials,
              identityId: live.identityId,
            }),
          );
          if (lifecycle !== undefined) yield* lifecycle.accountCreated(account);
          if ((yield* identityPlacement(account, lifecycle)) !== proof.placement)
            return yield* refused();
          const grantId =
            live.oauthGrantId ??
            AccountId.make(
              `acc_grant_${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()))}`,
            );
          if (live.oauthGrantId === null) {
            const encrypted = yield* credentials.encrypt(
              grantId,
              Redacted.make(
                yield* Schema.decodeUnknownEffect(JsonObject)({
                  ...grant,
                  identityId: live.identityId,
                }).pipe(Effect.mapError(() => new StorageError())),
              ),
            );
            yield* query(() =>
              tx.create("oauthGrants", {
                id: grantId,
                owner: live.owner,
                encrypted,
                status: locked.status,
                updatedAt: locked.updatedAt,
              }),
            );
            yield* query(() =>
              tx.updateMany("accounts", {
                where: (b) => b("id", "=", live.id),
                set: { oauthGrantId: grantId },
              }),
            );
            yield* query(() => tx.deleteMany("oauthGrants", { where: (b) => b("id", "=", oldId) }));
          }
          yield* query(() =>
            tx.updateMany("accounts", {
              where: (b) => b("id", "=", id),
              set: { oauthGrantId: grantId },
            }),
          );
          if (lifecycle !== undefined)
            yield* lifecycle.connectionCompleting({
              id: current.id,
              owner: current.owner,
              reconnectAccount: current.reconnectAccount,
              target: { app: current.target.app, requirement: current.target.requirement },
            });
          const saved = yield* Schema.decodeUnknownEffect(Account)(account).pipe(
            Effect.mapError(() => new StorageError()),
          );
          yield* finishConnection(tx, current, saved, lifecycle);
          return { status: "completed" as const, account: saved };
        }),
      );
    }).pipe(
      Effect.catchTag("AppNotFound", () => Effect.fail(new StorageError())),
      Effect.withSpan("sdk.connections.reuseOAuth"),
    );
