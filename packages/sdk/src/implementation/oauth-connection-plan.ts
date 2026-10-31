/** A plan compares real grants and saved connection destinations without creating credentials or links. */
import { Effect, Redacted, Schema } from "effect";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import {
  AccountConnectionRefused,
  type OAuthConnectionPlan,
  type PlanConnectionOAuth,
} from "../contracts/account-connection.ts";
import { AuthMethodInvalid, Provider } from "../contracts/provider.ts";
import {
  OAuthGrant,
  OAuthSetupFailed,
  allowedScopes,
  isFirstPartyGrant,
  type OAuthOptions,
} from "../contracts/oauth.ts";
import { StorageError } from "../contracts/shared.ts";
import type { Credentials } from "../contracts/storage.ts";
import { accountGrantId, accountIdentity } from "./account-identities.ts";
import { ownedAccount } from "./accounts.ts";
import { readConnection, requireOpen, type ConnectionRow } from "./connection-state.ts";
import { requireTargetProvider } from "./connection-target.ts";
import { query, type Query } from "./database.ts";
import { makeOAuthProtocol } from "./oauth-protocol.ts";
import { canonical } from "./provider.ts";

const readSource = (
  db: Query,
  credentials: Credentials,
  lifecycle: ResourceLifecycle | undefined,
  account: Parameters<typeof ownedAccount>[1],
) =>
  Effect.gen(function* () {
    const source = yield* ownedAccount(db, account);
    const unavailable = (reason: "identity" | "busy") => ({
      status: "unavailable" as const,
      reason,
    });
    if (lifecycle !== undefined && !(yield* lifecycle.accountsResolving([source])).has(source.id))
      return unavailable("identity");
    const identity = yield* accountIdentity(db, source, lifecycle);
    if (identity === undefined || source.identityId === null) return unavailable("identity");
    const proof = yield* query(() =>
      db.findFirst("accountIdentities", { where: (b) => b("id", "=", source.identityId) }),
    );
    const grantId = accountGrantId(source);
    const record = yield* query(() =>
      db.findFirst("oauthGrants", { where: (b) => b("id", "=", grantId) }),
    );
    if (proof === null || record === null || record.status === "reconnect")
      return unavailable("identity");
    if (!record.status.startsWith("ready_")) return unavailable("busy");
    const grant = yield* credentials.decrypt(grantId, Redacted.make(record.encrypted)).pipe(
      Effect.flatMap((value) => Schema.decodeUnknownEffect(OAuthGrant)(Redacted.value(value))),
      Effect.mapError(() => new StorageError()),
    );
    if (
      grant.grant === "client_credentials" ||
      grant.identity?.issuer !== proof.issuer ||
      grant.identity.subject !== proof.subject ||
      (source.oauthGrantId !== null && grant.identityId !== source.identityId)
    )
      return unavailable("identity");
    const stored = yield* query(() =>
      db.findFirst("providers", { where: (b) => b("id", "=", source.provider) }),
    );
    if (stored === null) return unavailable("identity");
    const provider = yield* Schema.decodeUnknownEffect(Provider)(stored).pipe(
      Effect.mapError(() => new StorageError()),
    );
    const method = provider.definition.auth[source.method];
    if (method?.type !== "oauth2" || method.grant === "client_credentials")
      return unavailable("identity");
    return {
      status: "ready" as const,
      account: source,
      identity,
      proof,
      grant,
      grantId,
      record,
      scopes: method.scopes ?? [],
    };
  });

/** Hosts without policies use the owner's placement; policy hosts must resolve their reviewed intent. */
const connectionPlacement = (
  connection: Pick<ConnectionRow, "id" | "owner">,
  lifecycle: ResourceLifecycle | undefined,
) =>
  lifecycle === undefined
    ? Effect.succeed<string | null>(connection.owner)
    : (lifecycle.connectionIdentityPlacement?.(connection) ?? Effect.succeed<string | null>(null));

export const inspectOAuthConnection = (
  db: Query,
  credentials: Credentials,
  options: OAuthOptions | undefined,
  lifecycle: ResourceLifecycle | undefined,
  input: typeof PlanConnectionOAuth.Type,
) =>
  Effect.gen(function* () {
    if (options === undefined) return yield* new OAuthSetupFailed({ reason: "unsupported" });
    const protocol = makeOAuthProtocol(options);
    const selected = [
      { connection: input.connection, method: input.method },
      ...(input.additionalConnections ?? []),
    ];
    const seen = new Set<string>();
    const entries = yield* Effect.forEach(selected, (selection) =>
      Effect.gen(function* () {
        const row = yield* requireOpen(
          selection,
          yield* readConnection(db, {
            ...selection,
            ...(input.owner === undefined ? {} : { owner: input.owner }),
          }),
        );
        if (
          seen.has(row.id) ||
          row.reconnectAccount !== null ||
          (seen.size > 0 && row.owner !== input.owner && input.owner !== undefined)
        )
          return yield* new AccountConnectionRefused(row.target);
        seen.add(row.id);
        const provider = yield* requireTargetProvider(db, row);
        const method = provider.definition.auth[selection.method];
        if (method?.type !== "oauth2" || method.grant === "client_credentials")
          return yield* new AuthMethodInvalid({ provider: provider.id, method: selection.method });
        const discovered = yield* protocol
          .discover(method)
          .pipe(Effect.mapError(() => new OAuthSetupFailed({ reason: "discovery_invalid" })));
        if (discovered.grant !== "authorization_code")
          return yield* new AuthMethodInvalid({ provider: provider.id, method: selection.method });
        return {
          row,
          method,
          methodName: selection.method,
          provider,
          discovered,
          placement: yield* connectionPlacement(row, lifecycle),
        };
      }),
    );
    const primary = entries[0];
    if (primary === undefined) return yield* new StorageError();
    const scopes = [...new Set(entries.flatMap((entry) => entry.discovered.scopes))].sort();
    const source =
      input.sourceAccount == null
        ? undefined
        : yield* readSource(db, credentials, lifecycle, {
            account: input.sourceAccount,
            owner: primary.row.owner,
          });
    const base = {
      scopes,
      missingScopes: scopes,
      targets: entries.map(({ row }) => ({
        connection: row.id,
        app: row.target.app,
        requirement: row.target.requirement,
        name: row.target.name,
      })),
      ...(source?.status !== "ready"
        ? {}
        : { sourceAccount: source.account.id, identity: source.identity }),
    };
    const incompatible = (reason: NonNullable<OAuthConnectionPlan["reason"]>) => ({
      plan: { ...base, status: "incompatible" as const, reason },
      entries,
      source,
    });
    if (
      entries.some(
        (entry) =>
          entry.method.identity === undefined ||
          entry.method.identity.issuer !== primary.method.identity?.issuer,
      )
    )
      return incompatible("identity");
    if (
      entries.some(
        (entry) =>
          entry.row.owner !== primary.row.owner ||
          entry.placement === null ||
          entry.placement !== primary.placement,
      )
    )
      return incompatible("placement");
    if (
      entries.some(
        (entry) =>
          entry.discovered.server.authorization_endpoint !==
            primary.discovered.server.authorization_endpoint ||
          entry.discovered.server.token_endpoint !== primary.discovered.server.token_endpoint ||
          canonical(entry.method.response) !== canonical(primary.method.response) ||
          canonical(entry.discovered.tokenRequestFormat ?? "form") !==
            canonical(primary.discovered.tokenRequestFormat ?? "form") ||
          canonical(entry.discovered.tokenResponse ?? {}) !==
            canonical(primary.discovered.tokenResponse ?? {}),
      )
    )
      return incompatible("client");
    if (
      entries.some(
        (entry) =>
          entry.discovered.resource !== primary.discovered.resource ||
          ((entry.discovered.resourceSource === "inferred_scope_audience" ||
            primary.discovered.resourceSource === "inferred_scope_audience") &&
            canonical(entry.discovered.scopes) !== canonical(primary.discovered.scopes)),
      )
    )
      return incompatible("resource");
    if (source?.status === "unavailable") return incompatible(source.reason);
    if (source === undefined)
      return { plan: { ...base, status: "consent-required" as const }, entries, source };
    if (source.proof.issuer !== primary.method.identity?.issuer) return incompatible("identity");
    if (source.proof.placement !== primary.placement) return incompatible("placement");
    const grant = source.grant;
    const operator = isFirstPartyGrant(grant)
      ? options.firstPartyClients?.find((client) => client.id === grant.firstParty)
      : undefined;
    if (
      isFirstPartyGrant(grant) &&
      (operator === undefined || grant.authorizationClient !== operator.clientId)
    )
      return incompatible("client");
    const authorization = isFirstPartyGrant(grant)
      ? operator?.server.authorizationUrl
      : grant.server.authorization_endpoint;
    const token = isFirstPartyGrant(grant)
      ? operator?.server.tokenUrl
      : grant.server.token_endpoint;
    if (
      authorization !== primary.discovered.server.authorization_endpoint ||
      token !== primary.discovered.server.token_endpoint ||
      canonical(grant.response) !== canonical(primary.method.response) ||
      (!isFirstPartyGrant(grant) &&
        primary.method.tokenEndpointAuthMethod !== undefined &&
        primary.method.tokenEndpointAuthMethod !== grant.client.token_endpoint_auth_method)
    )
      return incompatible("client");
    const resource = isFirstPartyGrant(grant) ? operator?.server.resource : grant.resource;
    if (
      resource !== primary.discovered.resource ||
      (primary.discovered.resourceSource === "inferred_scope_audience" &&
        canonical(grant.requestedScopes ?? []) !== canonical(primary.discovered.scopes))
    )
      return incompatible("resource");
    const required = [
      ...new Set(
        entries.flatMap((entry) =>
          entry.discovered.scopes.length === 0 && operator !== undefined
            ? operator.defaultScopes
            : entry.discovered.scopes,
        ),
      ),
    ].sort();
    const union = [
      ...new Set([...required, ...(grant.grantedScopes ?? grant.requestedScopes ?? source.scopes)]),
    ].sort();
    if (operator !== undefined && !union.every((scope) => allowedScopes(operator).includes(scope)))
      return incompatible("client");
    const missing = required.filter((scope) => !grant.grantedScopes?.includes(scope));
    return {
      plan: {
        ...base,
        scopes: union,
        missingScopes: missing,
        status:
          grant.grantedScopes !== undefined && missing.length === 0
            ? ("reuse" as const)
            : ("consent-required" as const),
      },
      entries,
      source,
    };
  }).pipe(Effect.withSpan("sdk.connections.planOAuth"));
