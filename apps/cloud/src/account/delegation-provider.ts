import { env } from "cloudflare:workers";
import { Effect, Layer, Predicate } from "effect";

import {
  AccountError,
  AccountForbidden,
  AccountUnauthorized,
  type DelegationTarget,
} from "@executor-js/api";
import {
  DbProvider,
  makeDelegationProvider,
  makeScopedExecutor,
  type DelegationAccountHost,
  type DelegationHuman,
  type DelegationRequestContext,
} from "@executor-js/api/server";
import type { MemberDirectoryShape } from "@executor-js/api/server";
import {
  collectTables,
  ConnectionAddress,
  MAX_DELEGATION_TTL_MS,
  StorageError,
  type DelegationService,
  type DelegationScope,
  type VerifiedDelegatedCredential,
} from "@executor-js/sdk";

import { ApiKeyService } from "../auth/api-keys";
import { makeCloudDelegationService, workosDelegatedCredential } from "../auth/delegation";
import { ADMIN_MFA_COOKIE, readRecentAdminMfaProof } from "../auth/admin-mfa-proof";
import { sessionFromSealed, type Session } from "../auth/middleware";
import type { SealedSessionResult } from "../auth/middleware";
import { WorkOSClient, type WorkOSClientService } from "../auth/workos";
import { CloudHostConfig, CloudPluginsProvider } from "../engine/execution-stack";
import type { CloudPlugins } from "../plugins";
import { createDrizzleFumaDb, CLOUD_NAMESPACE } from "../db/fuma";
import { DbService } from "../db/db";

const issuer = (): string => env.WORKOS_API_URL ?? "https://api.workos.com";
const publicOrigin = (): string => env.VITE_PUBLIC_SITE_URL ?? "https://executor.sh";

const boundedMaxTtlMs = (): number => {
  const configured = Number(env.DELEGATED_MAX_TTL_MS ?? "");
  if (!Number.isFinite(configured) || configured <= 0) return MAX_DELEGATION_TTL_MS;
  return Math.min(Math.floor(configured), MAX_DELEGATION_TTL_MS);
};

const issuanceEnabled = (): boolean => env.DELEGATED_ISSUANCE_ENABLED === "true";

const recentAuthMaxAgeMs = (): number | null => {
  const configured = Number(env.DELEGATED_RECENT_AUTH_MAX_AGE_MS ?? "300000");
  return Number.isSafeInteger(configured) && configured > 0 ? configured : null;
};

const bearerValue = (request: DelegationRequestContext): string | null => {
  const value = request.headers.authorization;
  if (!value || !value.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token.length === 0 ? null : token;
};

const storage = (operation: string, cause: unknown): StorageError =>
  new StorageError({ message: `Cloud delegation ${operation} failed.`, operation, cause });

// WorkOSClient's generated service currently leaves the environment channel of
// this worker-only method open. Normalize it once at the host boundary after
// converting failed cookie verification into an absent session.
const authenticateSealedSession = (
  workos: WorkOSClientService,
  cookie: string,
): Effect.Effect<(SealedSessionResult & { readonly sessionId: string }) | null, unknown, never> =>
  workos.authenticateSealedSession(cookie) as Effect.Effect<
    (SealedSessionResult & { readonly sessionId: string }) | null,
    unknown,
    never
  >;

const targetFor = (
  directory: MemberDirectoryShape,
  organizationId: string,
  subject: string,
  currentSubject: string,
) =>
  directory.membership(subject, organizationId, ["active"]).pipe(
    Effect.map((member): typeof DelegationTarget.Type | null =>
      member === null
        ? null
        : {
            id: member.accountId,
            email: member.email ?? "",
            name: member.name,
            isCurrentUser: member.accountId === currentSubject,
            status: "verified",
          },
    ),
    Effect.mapError(() => new AccountError({ message: "Failed to read the member directory." })),
  );

const targetsFor = (
  directory: MemberDirectoryShape,
  organizationId: string,
  currentSubject: string,
) =>
  directory.members(organizationId, { statuses: ["active"] }).pipe(
    Effect.map((members) =>
      members.map((member): typeof DelegationTarget.Type => ({
        id: member.accountId,
        email: member.email ?? "",
        name: member.name,
        isCurrentUser: member.accountId === currentSubject,
        status: "verified",
      })),
    ),
    Effect.mapError(() => new AccountError({ message: "Failed to read the member directory." })),
  );

const serviceFor = (
  db: DbService["Service"],
  directory: MemberDirectoryShape,
  apiKeys: ApiKeyService["Service"],
  organizationId: string,
  verifyProof?: (input: {
    readonly challengeId: string;
    readonly credential: VerifiedDelegatedCredential;
    readonly machineActor: string;
    readonly nonce: string;
  }) => Effect.Effect<boolean, StorageError>,
): DelegationService => {
  const fuma = createDrizzleFumaDb({
    db: db.db,
    tables: collectTables(),
    namespace: CLOUD_NAMESPACE,
    provider: "postgresql",
  });
  return makeCloudDelegationService({
    db: fuma.db,
    directory,
    apiKeys,
    tenant: organizationId,
    issuanceEnabled: issuanceEnabled(),
    maxTtlMs: boundedMaxTtlMs(),
    verifyProof,
  });
};

const humanFor = (
  request: DelegationRequestContext,
  workos: WorkOSClientService,
  directory: MemberDirectoryShape,
): Effect.Effect<
  DelegationHuman & { readonly session: Session },
  AccountError | AccountUnauthorized | AccountForbidden
> => {
  const originlessRead =
    request.browserOrigin === null && (request.method === "GET" || request.method === "HEAD");
  if (
    (!originlessRead && request.browserOrigin === null) ||
    (request.browserOrigin !== null &&
      (request.browserOrigin !== request.requestOrigin || request.browserOrigin !== publicOrigin()))
  )
    return Effect.fail(
      new AccountForbidden({
        message: "Delegation management requires a same-origin browser request.",
      }),
    );
  if (!request.headers.cookie || bearerValue(request) !== null) {
    return Effect.fail(new AccountUnauthorized());
  }
  const cookieValue = request.headers.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("wos-session="))
    ?.slice("wos-session=".length);
  if (!cookieValue) return Effect.fail(new AccountUnauthorized());
  return Effect.gen(function* () {
    const resolved = yield* authenticateSealedSession(workos, cookieValue).pipe(
      Effect.mapError(() => new AccountUnauthorized()),
      Effect.orElseSucceed(() => null),
    );
    const organizationId = resolved?.organizationId;
    if (resolved === null || !organizationId) return yield* new AccountUnauthorized();
    const maxAgeMs = recentAuthMaxAgeMs();
    if (maxAgeMs === null)
      return yield* new AccountForbidden({ message: "Delegation authentication is unavailable." });
    const proof = yield* readRecentAdminMfaProof(
      env.WORKOS_COOKIE_PASSWORD,
      { userId: resolved.userId, sessionId: resolved.sessionId },
      request.headers.cookie
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${ADMIN_MFA_COOKIE}=`))
        ?.slice(`${ADMIN_MFA_COOKIE}=`.length),
      Date.now(),
      maxAgeMs,
    );
    const member = yield* directory
      .membership(resolved.userId, organizationId, ["active"])
      .pipe(Effect.mapError(() => new AccountError({ message: "Failed to read membership." })));
    if (member === null)
      return yield* new AccountForbidden({ message: "The current user is no longer a member." });
    return {
      subject: resolved.userId,
      organizationId,
      recent: proof !== null,
      canFilterTargets: member.role === "admin",
      session: sessionFromSealed(resolved, ""),
    };
  });
};

const organizationForRequest = (
  request: DelegationRequestContext,
  apiKeys: ApiKeyService["Service"],
  workos: WorkOSClientService,
  directory: MemberDirectoryShape,
  human?: DelegationHuman,
) => {
  if (human) return Effect.succeed(human.organizationId);
  const token = bearerValue(request);
  if (token === null)
    return humanFor(request, workos, directory).pipe(Effect.map((value) => value.organizationId));
  return apiKeys.validate(token).pipe(
    Effect.mapError(() => new AccountUnauthorized()),
    Effect.flatMap((owner) =>
      owner === null || owner.scope !== "user" || owner.organizationId.length === 0
        ? Effect.fail(new AccountUnauthorized())
        : Effect.succeed(owner.organizationId),
    ),
  );
};

const scopeSnapshot = (
  db: DbService["Service"],
  targetSubject: string,
  organizationId: string,
  organizationName: string,
  scope: typeof import("@executor-js/api").DelegationScope.Type,
) => {
  const fuma = createDrizzleFumaDb({
    db: db.db,
    tables: collectTables(),
    namespace: CLOUD_NAMESPACE,
    provider: "postgresql",
  });
  const executorEffect = makeScopedExecutor<CloudPlugins>(
    targetSubject,
    organizationId,
    organizationName,
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(DbProvider)({ db: fuma.db, fuma: fuma.fuma, close: async () => {} }),
        CloudPluginsProvider,
        CloudHostConfig,
      ),
    ),
  );
  return Effect.gen(function* () {
    const executor = yield* executorEffect;
    const toolkits = yield* executor.toolkits.list();
    const snapshots = yield* Effect.forEach(scope.toolkitIds, (toolkitId) => {
      const toolkit = toolkits.find((item) => item.id === toolkitId);
      if (!toolkit)
        return Effect.fail(new AccountError({ message: "Delegation toolkit is unavailable." }));
      return executor.toolkits
        .snapshotForSlug(toolkit.slug)
        .pipe(
          Effect.flatMap((snapshot) =>
            snapshot === null
              ? Effect.fail(new AccountError({ message: "Delegation toolkit is unavailable." }))
              : Effect.succeed(snapshot),
          ),
        );
    });
    const connections =
      scope.connectionIds ??
      snapshots.flatMap((snapshot) => snapshot.connectionAddresses.map(String));
    return {
      actions: scope.scopes,
      toolkitMembership: snapshots,
      toolAddresses: snapshots.flatMap((snapshot) => snapshot.toolAddresses),
      ...(scope.connectionIds === undefined
        ? {}
        : { connectionAddresses: connections.map((value) => ConnectionAddress.make(value)) }),
    } satisfies DelegationScope;
  }).pipe(
    Effect.mapError((cause) =>
      Predicate.isTagged(cause, "AccountError")
        ? cause
        : new AccountError({ message: "Failed to build the delegated scope snapshot." }),
    ),
  );
};

/** Build the same target-scoped catalog used to freeze a grant, but project
 * only stable IDs and display metadata for the human consent form. */
const scopeOptions = (
  db: DbService["Service"],
  targetSubject: string,
  organizationId: string,
  organizationName: string,
) => {
  const fuma = createDrizzleFumaDb({
    db: db.db,
    tables: collectTables(),
    namespace: CLOUD_NAMESPACE,
    provider: "postgresql",
  });
  const executorEffect = makeScopedExecutor<CloudPlugins>(
    targetSubject,
    organizationId,
    organizationName,
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(DbProvider)({ db: fuma.db, fuma: fuma.fuma, close: async () => {} }),
        CloudPluginsProvider,
        CloudHostConfig,
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
    const activeSnapshots = snapshots.filter(
      (entry): entry is typeof entry & { readonly snapshot: NonNullable<typeof entry.snapshot> } =>
        entry.snapshot !== null,
    );
    const allConnections = yield* executor.connections.list();
    const addressToToolkits = new Map<string, string[]>();
    for (const { toolkit, snapshot } of activeSnapshots) {
      for (const address of snapshot.connectionAddresses) {
        const id = String(address);
        const toolkitIds = addressToToolkits.get(id) ?? [];
        toolkitIds.push(String(toolkit.id));
        addressToToolkits.set(id, toolkitIds);
      }
    }
    const connections = allConnections
      .filter((connection) => addressToToolkits.has(String(connection.address)))
      .map((connection) => ({
        id: String(connection.address),
        label:
          connection.identityLabel ??
          `${String(connection.integration)} · ${String(connection.name)}`,
        description: connection.description ?? null,
        toolkitIds: addressToToolkits.get(String(connection.address)) ?? [],
      }));
    return {
      actions: ["discover", "invoke"] as const,
      toolkits: activeSnapshots.map(({ toolkit }) => ({
        id: String(toolkit.id),
        slug: String(toolkit.slug),
        name: String(toolkit.name),
      })),
      connections,
      maxExpiresAt: new Date(Date.now() + boundedMaxTtlMs()).toISOString(),
    };
  }).pipe(
    Effect.mapError(
      () => new AccountError({ message: "Failed to read delegation scope choices." }),
    ),
  );
};

export interface CloudDelegationHostDependencies {
  readonly db: DbService["Service"];
  readonly directory: MemberDirectoryShape;
  readonly apiKeys: ApiKeyService["Service"];
  readonly workos: WorkOSClient["Service"];
}

export const cloudDelegationProvider = (deps: CloudDelegationHostDependencies) => {
  const host: DelegationAccountHost = {
    human: (request) => humanFor(request, deps.workos, deps.directory),
    service: (request, human) =>
      organizationForRequest(request, deps.apiKeys, deps.workos, deps.directory, human).pipe(
        Effect.map((organizationId) =>
          serviceFor(
            deps.db,
            deps.directory,
            deps.apiKeys,
            organizationId,
            ({ credential, machineActor }) => {
              const token = bearerValue(request);
              if (token === null) return Effect.succeed(false);
              return deps.apiKeys.validate(token).pipe(
                Effect.map((owner) => {
                  const expected = owner ? workosDelegatedCredential(owner, issuer()) : null;
                  return (
                    owner?.scope === "user" &&
                    expected?.credentialRef === credential.credentialRef &&
                    expected.subject === credential.subject &&
                    `machine:${owner.keyId}` === machineActor
                  );
                }),
                Effect.mapError((cause) => storage("delegation.proof", cause)),
              );
            },
          ),
        ),
      ),
    targets: (request) =>
      humanFor(request, deps.workos, deps.directory).pipe(
        Effect.flatMap((human) => targetsFor(deps.directory, human.organizationId, human.subject)),
      ),
    target: (request, subject) =>
      organizationForRequest(request, deps.apiKeys, deps.workos, deps.directory).pipe(
        Effect.flatMap((organizationId) =>
          targetFor(deps.directory, organizationId, subject, subject),
        ),
      ),
    scope: (request, targetSubject, scope) =>
      humanFor(request, deps.workos, deps.directory).pipe(
        Effect.flatMap((human) =>
          scopeSnapshot(deps.db, targetSubject, human.organizationId, "", scope),
        ),
      ),
    scopeOptions: (request, targetSubject) =>
      humanFor(request, deps.workos, deps.directory).pipe(
        Effect.flatMap((human) => scopeOptions(deps.db, targetSubject, human.organizationId, "")),
      ),
    proof: (request, adapter) => {
      const token = bearerValue(request);
      if (token === null) return Effect.fail(new AccountUnauthorized());
      return deps.apiKeys.validate(token).pipe(
        Effect.mapError(() => new AccountUnauthorized()),
        Effect.flatMap((owner) => {
          const credential = owner ? workosDelegatedCredential(owner, issuer()) : null;
          return credential === null || owner === null
            ? Effect.fail(new AccountUnauthorized())
            : Effect.succeed({
                credential: { ...credential, adapter },
                machineActor: `machine:${owner.keyId}`,
              });
        }),
      );
    },
    providerKeys: {
      issue: (request, input) =>
        Effect.gen(function* () {
          const organizationId = yield* organizationForRequest(
            request,
            deps.apiKeys,
            deps.workos,
            deps.directory,
          );
          const created = yield* deps.apiKeys
            .createUserKey({ accountId: input.targetSubject, organizationId, name: input.label })
            .pipe(
              Effect.mapError(
                () => new AccountError({ message: "Failed to issue delegated key." }),
              ),
            );
          return {
            credential: {
              kind: "issued-key" as const,
              adapter: "workos-api-key",
              issuer: issuer(),
              audience: organizationId,
              subject: input.targetSubject,
              credentialRef: created.id,
            },
            actorSubject: `machine:${created.id}`,
            secret: created.value,
          };
        }),
      bind: () => Effect.void,
      rotate: (request, input) =>
        Effect.gen(function* () {
          const organizationId = yield* organizationForRequest(
            request,
            deps.apiKeys,
            deps.workos,
            deps.directory,
          );
          const created = yield* deps.apiKeys
            .createUserKey({ accountId: input.targetSubject, organizationId, name: input.label })
            .pipe(
              Effect.mapError(
                () => new AccountError({ message: "Failed to rotate delegated key." }),
              ),
            );
          return {
            credential: {
              kind: "issued-key" as const,
              adapter: "workos-api-key",
              issuer: issuer(),
              audience: organizationId,
              subject: input.targetSubject,
              credentialRef: created.id,
            },
            actorSubject: `machine:${created.id}`,
            secret: created.value,
          };
        }),
      revokeBound: (request, input) =>
        Effect.gen(function* () {
          yield* organizationForRequest(request, deps.apiKeys, deps.workos, deps.directory);
          if (!input.credentialRef) return;
          yield* deps.apiKeys
            .revokeUserKey({ keyId: input.credentialRef })
            .pipe(
              Effect.mapError(
                () => new AccountError({ message: "Failed to revoke delegated key." }),
              ),
            );
        }),
      revoke: (_request, input) =>
        deps.apiKeys
          .revokeUserKey({ keyId: input.credential.credentialRef })
          .pipe(
            Effect.mapError(() => new AccountError({ message: "Failed to revoke delegated key." })),
          ),
    },
    externalAdapters: ["workos-api-key"],
    localKeysEnabled: issuanceEnabled(),
    issuanceEnabled: issuanceEnabled(),
  };
  return makeDelegationProvider(host);
};
