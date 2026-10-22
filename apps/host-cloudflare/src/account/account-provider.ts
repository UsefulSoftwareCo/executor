import { Effect, Layer } from "effect";

import {
  AccountProvider,
  accountProviderMiddlewareLayer,
  DbProvider,
  makeDelegationProvider,
  makeScopedExecutor,
  type AccountHeaders,
  type DelegationAccountHost,
  type DelegationHuman,
  type DelegationRequestContext,
} from "@executor-js/api/server";
import {
  AccountError,
  AccountForbidden,
  AccountUnauthorized,
  DelegationScopeOptionsResponse,
} from "@executor-js/api";
import { ConnectionAddress, type VerifiedHumanSubjectRegistry } from "@executor-js/sdk";

import {
  classifyAccessClaims,
  delegatedCredentialFromAccessClaims,
  hasRecentAccessAuthentication,
  makeAccessVerifier,
  type AccessVerifierOptions,
} from "../auth/cloudflare-access";
import {
  makeCloudflareDelegationAuthority,
  makeCloudflareDelegationService,
} from "../auth/delegation";
import type { CloudflareConfig } from "../config";
import type { ExecutorDbHandle } from "@executor-js/api/server";
import { makeCloudflareHostConfig, makeCloudflarePluginsProvider } from "../execution";
import type { CloudflarePlugins } from "../plugins";

const delegationFailure = (message: string): AccountError => new AccountError({ message });

const requestFor = (request: DelegationRequestContext): Request =>
  new Request(`${request.requestOrigin}/api/account`, {
    headers: new Headers(request.headers),
  });

const sameOrigin = (request: DelegationRequestContext): boolean =>
  (request.browserOrigin === null && (request.method === "GET" || request.method === "HEAD")) ||
  (request.browserOrigin !== null && request.browserOrigin === request.requestOrigin);

const cloudflareTarget = (
  subject: string,
  human: DelegationHuman,
  email: string,
  name: string | null,
  status: "verified" | "removed" = "verified",
) => ({
  id: subject,
  email,
  name,
  isCurrentUser: subject === human.subject,
  status,
});

const scopeSnapshot = (
  dbHandle: ExecutorDbHandle,
  config: CloudflareConfig,
  targetSubject: string,
  scope: typeof import("@executor-js/api").DelegationScope.Type,
) => {
  const executorEffect = makeScopedExecutor<CloudflarePlugins>(
    targetSubject,
    config.organizationId,
    config.organizationName,
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(DbProvider)({ db: dbHandle.db, fuma: dbHandle.fuma, close: dbHandle.close }),
        makeCloudflarePluginsProvider(config),
        makeCloudflareHostConfig(config),
      ),
    ),
  );
  return Effect.gen(function* () {
    const executor = yield* executorEffect;
    const toolkits = yield* executor.toolkits.list();
    const snapshots = yield* Effect.forEach(scope.toolkitIds, (toolkitId) => {
      const toolkit = toolkits.find((item) => item.id === toolkitId);
      if (!toolkit) return Effect.fail(delegationFailure("Delegation toolkit is unavailable."));
      return executor.toolkits
        .snapshotForSlug(toolkit.slug)
        .pipe(
          Effect.flatMap((snapshot) =>
            snapshot
              ? Effect.succeed(snapshot)
              : Effect.fail(delegationFailure("Delegation toolkit is unavailable.")),
          ),
        );
    });
    return {
      actions: scope.scopes,
      toolkitMembership: snapshots,
      toolAddresses: snapshots.flatMap((snapshot) => snapshot.toolAddresses),
      ...(scope.connectionIds === undefined
        ? {}
        : {
            connectionAddresses: scope.connectionIds.map((value) => ConnectionAddress.make(value)),
          }),
    } satisfies import("@executor-js/sdk").DelegationScope;
  }).pipe(
    Effect.mapError(() => delegationFailure("Failed to build the delegated scope snapshot.")),
  );
};

/** Build display-only scope choices from the target's live executor. The
 * returned ids are the same stable ids/addresses consumed by `scope`; labels
 * never participate in authorization. */
const scopeOptions = (
  dbHandle: ExecutorDbHandle,
  config: CloudflareConfig,
  targetSubject: string,
) => {
  const executorEffect = makeScopedExecutor<CloudflarePlugins>(
    targetSubject,
    config.organizationId,
    config.organizationName,
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(DbProvider)({ db: dbHandle.db, fuma: dbHandle.fuma, close: dbHandle.close }),
        makeCloudflarePluginsProvider(config),
        makeCloudflareHostConfig(config),
      ),
    ),
  );
  return Effect.gen(function* () {
    const executor = yield* executorEffect;
    const toolkits = yield* executor.toolkits.list();
    const snapshots = yield* Effect.forEach(toolkits, (toolkit) =>
      executor.toolkits
        .snapshotForSlug(toolkit.slug)
        .pipe(Effect.map((snapshot) => ({ toolkit, snapshot }))),
    );
    const toolkitIdsByConnection = new Map<string, string[]>();
    for (const { toolkit, snapshot } of snapshots) {
      if (!snapshot) continue;
      for (const address of snapshot.connectionAddresses) {
        const key = String(address);
        const ids = toolkitIdsByConnection.get(key) ?? [];
        ids.push(String(toolkit.id));
        toolkitIdsByConnection.set(key, ids);
      }
    }
    const connections = yield* executor.connections.list();
    return {
      actions: ["discover", "invoke"],
      toolkits: toolkits.map((toolkit) => ({
        id: String(toolkit.id),
        slug: String(toolkit.slug),
        name: toolkit.name,
      })),
      connections: connections.map((connection) => ({
        id: String(connection.address),
        label: connection.identityLabel ?? String(connection.name),
        description: connection.description ?? null,
        toolkitIds: [...(toolkitIdsByConnection.get(String(connection.address)) ?? [])].sort(),
      })),
      maxExpiresAt: new Date(Date.now() + config.delegatedMaxTtlMs).toISOString(),
    } satisfies typeof DelegationScopeOptionsResponse.Type;
  }).pipe(Effect.mapError(() => delegationFailure("Failed to read the delegated scope options.")));
};

// ---------------------------------------------------------------------------
// Cloudflare AccountProvider — backs the shared `/account/*` surface the
// multiplayer shell reads. Cloudflare Access is the identity, so `me` just
// reflects the Access principal (the same `makeAccessVerifier` the API gate
// uses), reading the `Cf-Access-Jwt-Assertion` header off the request.
//
// Single-tenant + Access-managed: members, roles, and API keys live in
// Cloudflare Access, NOT in the app. The shell hides the API-keys footer and
// shows no members page, so those methods are never reached from the UI; they
// return empty (reads) or a clear "managed by Cloudflare Access" error (writes)
// to satisfy the provider shape.
// ---------------------------------------------------------------------------

const NOT_IN_APP = "Managed by Cloudflare Access, not in the app.";

export const cloudflareAccountProvider = (
  config: CloudflareConfig,
): Layer.Layer<AccountProvider> => {
  const { verify } = makeAccessVerifier(config);

  // The provider gets raw headers; rebuild a minimal Request so `verify` can
  // read the Access assertion header (and honor the dev-auth bypass).
  const principalFrom = (headers: AccountHeaders) =>
    verify(new Request("https://internal.local/", { headers: new Headers(headers) }));

  const forbiddenWrite = Effect.fail(new AccountError({ message: NOT_IN_APP }));

  return Layer.succeed(AccountProvider)({
    me: (headers) =>
      principalFrom(headers).pipe(
        Effect.flatMap((principal) =>
          principal
            ? Effect.succeed({
                user: {
                  id: principal.accountId,
                  email: principal.email,
                  name: principal.name,
                  avatarUrl: principal.avatarUrl,
                },
                organization: {
                  id: principal.organizationId,
                  name: principal.organizationName,
                  slug: config.organizationSlug,
                },
              })
            : Effect.fail(new AccountUnauthorized()),
        ),
      ),
    listApiKeys: () => Effect.succeed({ apiKeys: [] }),
    createApiKey: () => forbiddenWrite,
    revokeApiKey: () => forbiddenWrite,
    // Org-owned keys are a WorkOS concept; Access-managed instances have no
    // credential store of their own to mint one from.
    listOrgApiKeys: () => Effect.succeed({ apiKeys: [] }),
    createOrgApiKey: () => forbiddenWrite,
    revokeOrgApiKey: () => forbiddenWrite,
    listMembers: () => Effect.succeed({ members: [] }),
    listRoles: () => Effect.succeed({ roles: [] }),
    inviteMember: () => forbiddenWrite,
    removeMember: () => forbiddenWrite,
    updateMemberRole: () => forbiddenWrite,
    updateOrgName: () => forbiddenWrite,
  });
};

/** The per-request `AccountProvider` middleware (mounted under `/api`). */
export const cloudflareAccountMiddleware = (config: CloudflareConfig) =>
  accountProviderMiddlewareLayer(cloudflareAccountProvider(config));

/** Cloudflare Access implementation of the provider-neutral delegation API.
 * Access has no user-directory write surface, so target display is limited to
 * the current verified subject (or a generic verified historical subject). */
export const cloudflareDelegationProvider = (
  dbHandle: ExecutorDbHandle,
  config: CloudflareConfig,
  registry: VerifiedHumanSubjectRegistry,
  verifierOptions: AccessVerifierOptions = {},
) => {
  const verifier = makeAccessVerifier(config, verifierOptions);

  const human = (
    request: DelegationRequestContext,
  ): Effect.Effect<DelegationHuman, AccountError | AccountForbidden | AccountUnauthorized> =>
    Effect.gen(function* () {
      if (!config.enableDevAuth && !sameOrigin(request)) {
        return yield* new AccountForbidden({
          message: "Delegation management requires a same-origin browser request.",
        });
      }
      const verified = yield* verifier.verifyWithClaims(requestFor(request));
      if (
        !verified ||
        (!config.enableDevAuth && classifyAccessClaims(verified.claims) !== "human")
      ) {
        return yield* new AccountUnauthorized();
      }
      const subject = verified.principal.accountId;
      const recent =
        config.enableDevAuth ||
        hasRecentAccessAuthentication(
          verified.claims,
          config.delegatedRecentAuthMaxAgeMs,
          Date.now(),
          config.delegatedRecentAuthClaim,
        );
      if (recent && sameOrigin(request)) {
        yield* registry
          .markVerifiedHuman({ tenant: config.organizationId, subject })
          .pipe(Effect.mapError(() => delegationFailure("Failed to record Access human.")));
      }
      return {
        subject,
        organizationId: config.organizationId,
        recent,
        canFilterTargets: verified.principal.orgRole === "admin",
      } satisfies DelegationHuman;
    });

  const target = (request: DelegationRequestContext, subject: string) =>
    Effect.gen(function* () {
      const current = yield* human(request);
      if (subject === current.subject) {
        const verified = yield* verifier.verifyWithClaims(requestFor(request));
        return verified
          ? cloudflareTarget(subject, current, verified.principal.email, verified.principal.name)
          : null;
      }
      const isVerified = yield* registry.isVerifiedHuman({
        tenant: config.organizationId,
        subject,
      });
      return isVerified ? cloudflareTarget(subject, current, "", null) : null;
    }).pipe(Effect.mapError(() => delegationFailure("Failed to read the Access directory.")));

  const host: DelegationAccountHost = {
    human,
    service: (request) =>
      Effect.succeed(
        makeCloudflareDelegationService(
          dbHandle,
          config,
          makeCloudflareDelegationAuthority(config, registry, requestFor(request)),
        ),
      ),
    targets: (request) =>
      human(request).pipe(
        Effect.map((current) => {
          const verified = cloudflareTarget(current.subject, current, "", null);
          return [verified];
        }),
      ),
    scopeOptions: (_request, targetSubject) => scopeOptions(dbHandle, config, targetSubject),
    target,
    scope: (_request, targetSubject, scope) =>
      scopeSnapshot(dbHandle, config, targetSubject, scope),
    onRevokeAll: (_request, targetSubject, _disableTarget) =>
      registry
        .revokeVerifiedHuman({ tenant: config.organizationId, subject: targetSubject })
        .pipe(Effect.mapError(() => delegationFailure("Failed to disable the Access human."))),
    proof: (request, adapter) =>
      Effect.gen(function* () {
        const verified = yield* verifier.verifyWithClaims(requestFor(request));
        if (!verified || classifyAccessClaims(verified.claims) !== "service-token") {
          return yield* new AccountUnauthorized();
        }
        const credential = delegatedCredentialFromAccessClaims(verified.claims, config);
        if (!credential || credential.adapter !== adapter) return yield* new AccountUnauthorized();
        return {
          credential,
          machineActor: `access:${credential.credentialRef}`,
        };
      }),
    externalAdapters: ["cloudflare-access"],
    localKeysEnabled: false,
    issuanceEnabled: config.delegatedIssuanceEnabled,
  };
  return makeDelegationProvider(host);
};
