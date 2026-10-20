import { Effect, Layer, Predicate } from "effect";

import {
  DbProvider,
  makeExecutionStack,
  makeDelegationProvider,
  makeScopedExecutor,
  type DelegatedExecutionResumer as DelegatedExecutionResumerShape,
  type DelegationAccountHost,
  type DelegationAccountKeyStore,
  type DelegationHuman,
  type DelegationRequestContext,
} from "@executor-js/api/server";
import { AccountError, AccountForbidden, AccountUnauthorized } from "@executor-js/api";
import {
  StorageError,
  Subject,
  Tenant,
  DelegationId,
  CredentialId,
  DelegationScopeVersion,
  type DelegationScope,
  type DelegationService,
  type StorageFailure,
  type VerifiedDelegatedCredential,
} from "@executor-js/sdk";

import type { SelfHostConfig } from "../config";
import type { BetterAuthHandle } from "../auth/better-auth";
import { SELF_HOST_DELEGATED_KEY_PREFIX } from "../auth/delegated-key";
import { makeSelfHostDelegationService } from "../auth/delegation";
import {
  SelfHostExecutionStackLayer,
  SelfHostHostConfig,
  SelfHostPluginsProvider,
} from "../execution";
import type { SelfHostPlugins } from "../plugins";
import { SelfHostDb, type SelfHostDbHandle } from "../db/self-host-db";

type MemberRow = {
  readonly id: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly role: string;
};
type UserRow = {
  readonly id: string;
  readonly email: string;
  readonly name?: string | null;
  readonly image?: string | null;
};
type ApiKeyRow = {
  readonly id: string;
  readonly referenceId: string;
  readonly enabled?: boolean | null;
  readonly expiresAt?: Date | string | number | null;
  readonly metadata?: unknown;
};

const DELEGATION_KEY_METADATA = "executorDelegationCredentialId";

const metadataCredentialId = (metadata: unknown): string | null => {
  if (typeof metadata !== "object" || metadata === null) return null;
  const value = (metadata as Record<string, unknown>)[DELEGATION_KEY_METADATA];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const isCurrentApiKey = (key: ApiKeyRow | null): key is ApiKeyRow => {
  if (!key || key.enabled === false) return false;
  if (key.expiresAt === null || key.expiresAt === undefined) return true;
  const expiresAt =
    key.expiresAt instanceof Date ? key.expiresAt.getTime() : new Date(key.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
};

const failure = (message: string): AccountError => new AccountError({ message });
const storageFailure = (message: string): StorageError =>
  new StorageError({ message, operation: "delegation.authority", cause: undefined });
const headersOf = (request: DelegationRequestContext): Headers => new Headers(request.headers);

const authorityFailure = (message: string): StorageError => storageFailure(message);

const sameOrigin = (request: DelegationRequestContext, config: SelfHostConfig): boolean =>
  (request.browserOrigin === null && (request.method === "GET" || request.method === "HEAD")) ||
  (request.browserOrigin !== null &&
    request.browserOrigin === request.requestOrigin &&
    config.trustedOrigins.includes(request.requestOrigin));

const memberFor = (
  betterAuth: BetterAuthHandle,
  subject: string,
): Effect.Effect<{ readonly member: MemberRow; readonly user: UserRow } | null, AccountError> =>
  Effect.tryPromise({
    try: async () => {
      const context = await betterAuth.auth.$context;
      const member = await context.adapter.findOne<MemberRow>({
        model: "member",
        where: [
          { field: "userId", value: subject },
          { field: "organizationId", value: betterAuth.organizationId },
        ],
      });
      if (!member) return null;
      const user = await context.internalAdapter.findUserById(subject);
      if (!user) return null;
      return {
        member,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
        },
      };
    },
    catch: () => failure("Failed to read the Better Auth membership."),
  });

const memberForActor = (
  betterAuth: BetterAuthHandle,
  subject: string,
): Effect.Effect<{ readonly member: MemberRow; readonly user: UserRow } | null, AccountError> => {
  if (!subject.startsWith("machine:")) return memberFor(betterAuth, subject);
  const keyId = subject.slice("machine:".length);
  return Effect.tryPromise({
    try: async () => {
      const context = await betterAuth.auth.$context;
      const key = await context.adapter.findOne<ApiKeyRow>({
        model: "apikey",
        where: [{ field: "id", value: keyId }],
      });
      if (!isCurrentApiKey(key)) return null;
      return key.referenceId;
    },
    catch: () => failure("Failed to read the Better Auth API key."),
  }).pipe(Effect.flatMap((owner) => (owner ? memberFor(betterAuth, owner) : Effect.succeed(null))));
};

const targetFor = (betterAuth: BetterAuthHandle, subject: string, currentSubject: string) =>
  memberFor(betterAuth, subject).pipe(
    Effect.map((record) =>
      record
        ? {
            id: record.user.id,
            email: record.user.email,
            name: record.user.name ?? null,
            isCurrentUser: record.user.id === currentSubject,
            status: "verified" as const,
          }
        : null,
    ),
  );

const targetListFor = (
  betterAuth: BetterAuthHandle,
  currentSubject: string,
): Effect.Effect<
  readonly (typeof import("@executor-js/api").DelegationTarget.Type)[],
  AccountError
> =>
  Effect.tryPromise({
    try: async () => {
      const context = await betterAuth.auth.$context;
      const members = await context.adapter.findMany<MemberRow>({
        model: "member",
        where: [{ field: "organizationId", value: betterAuth.organizationId }],
      });
      const targets = await Promise.all(
        members.map(async (member) => {
          const user = await context.internalAdapter.findUserById(member.userId);
          if (!user) return null;
          return {
            id: user.id,
            email: user.email,
            name: user.name ?? null,
            isCurrentUser: user.id === currentSubject,
            status: "verified" as const,
          };
        }),
      );
      return targets.filter(Predicate.isNotNull);
    },
    catch: () => failure("Failed to read the Better Auth membership directory."),
  });

const isPrivilegedRole = (role: string): boolean => role === "owner" || role === "admin";

const providerKeyStore = (betterAuth: BetterAuthHandle): DelegationAccountKeyStore => {
  const withContext = <A>(
    operation: string,
    run: (context: Awaited<BetterAuthHandle["auth"]["$context"]>) => Promise<A>,
  ): Effect.Effect<A, AccountError> =>
    Effect.tryPromise({
      try: async () => run(await betterAuth.auth.$context),
      catch: () => failure(`Failed to ${operation}.`),
    });

  const deleteKey = (keyId: string) =>
    withContext("revoke the Better Auth API key", async (context) => {
      await context.adapter.delete({
        model: "apikey",
        where: [{ field: "id", value: keyId }],
      });
    });

  const keyMetadataFor = (credentialId: string) =>
    withContext("find the Better Auth delegation key", async (context) => {
      const rows = await context.adapter.findMany<ApiKeyRow>({ model: "apikey", where: [] });
      return rows.filter((row) => metadataCredentialId(row.metadata) === credentialId);
    });

  const issue = (
    _request: DelegationRequestContext,
    input: { readonly targetSubject: string; readonly label: string; readonly expiresAt: string },
  ) => {
    return Effect.tryPromise<
      Awaited<ReturnType<BetterAuthHandle["auth"]["api"]["createApiKey"]>>,
      AccountError
    >({
      try: () =>
        betterAuth.auth.api.createApiKey({
          body: {
            name: input.label.slice(0, 32),
            prefix: SELF_HOST_DELEGATED_KEY_PREFIX,
            metadata: { executorDelegationPending: true },
            // Better Auth's server-only userId field makes the provider
            // credential belong to the selected verified target, rather than
            // accidentally binding it to the human administrator's session.
            userId: input.targetSubject,
          },
        }),
      catch: () => failure("Failed to create the Better Auth delegation key."),
    }).pipe(
      Effect.map((key) => ({
        credential: {
          kind: "issued-key" as const,
          adapter: "better-auth-api-key",
          issuer: betterAuth.auth.options.baseURL,
          audience: betterAuth.organizationId,
          subject: key.referenceId,
          credentialRef: key.id,
        },
        actorSubject: `machine:${key.id}`,
        secret: key.key,
      })),
    );
  };

  return {
    issue: (request, input) => issue(request, input),
    bind: (_request, input) =>
      Effect.gen(function* () {
        const context = yield* Effect.tryPromise({
          try: () => betterAuth.auth.$context,
          catch: () => failure("Failed to bind the Better Auth delegation key."),
        });
        const current = yield* Effect.tryPromise({
          try: () =>
            context.adapter.findOne<ApiKeyRow>({
              model: "apikey",
              where: [{ field: "id", value: input.credential.credentialRef }],
            }),
          catch: () => failure("Failed to bind the Better Auth delegation key."),
        });
        if (!current) return yield* failure("The Better Auth delegation key disappeared.");
        yield* Effect.tryPromise({
          try: () =>
            context.adapter.update({
              model: "apikey",
              where: [{ field: "id", value: input.credential.credentialRef }],
              update: {
                metadata: {
                  executorDelegationCredentialId: input.credentialId,
                  executorDelegationTarget: input.targetSubject,
                },
              },
            }),
          catch: () => failure("Failed to bind the Better Auth delegation key."),
        });
      }),
    rotate: (request, input) =>
      Effect.gen(function* () {
        const previous = yield* keyMetadataFor(input.credentialId);
        yield* Effect.forEach(previous, (key) => deleteKey(key.id));
        return yield* issue(request, input);
      }),
    revokeBound: (_request, input) =>
      keyMetadataFor(input.credentialId).pipe(
        Effect.flatMap((keys) => Effect.forEach(keys, (key) => deleteKey(key.id))),
        Effect.asVoid,
      ),
    // A proof-bound existing Better Auth PAT remains an ordinary user PAT.
    // Revoking its delegation must leave the provider credential intact so
    // boundary lookups can observe the authoritative revoked grant and deny it
    // even when a browser cookie is also present. Provider-issued keys are
    // owned by this lifecycle and can be deleted on revoke.
    revoke: (_request, input) =>
      input.credential.kind === "issued-key"
        ? deleteKey(input.credential.credentialRef)
        : Effect.void,
  };
};

const makeSelfHostAuthority = (betterAuth: BetterAuthHandle, requestHeaders: Headers) => ({
  isVerifiedHuman: (subject: Subject) =>
    memberFor(betterAuth, String(subject)).pipe(
      Effect.map(Boolean),
      Effect.mapError(() => authorityFailure("Better Auth membership lookup failed.")),
    ),
  isCurrentlyAuthorized: (grant: {
    readonly actorSubject: Subject;
    readonly effectiveSubject: Subject;
  }) =>
    Effect.gen(function* () {
      const actor = yield* memberForActor(betterAuth, String(grant.actorSubject)).pipe(
        Effect.mapError(() => authorityFailure("Better Auth membership lookup failed.")),
      );
      const target = yield* memberFor(betterAuth, String(grant.effectiveSubject)).pipe(
        Effect.mapError(() => authorityFailure("Better Auth membership lookup failed.")),
      );
      if (!actor || !target) return false;
      if (actor.member.userId === target.member.userId) return true;
      return isPrivilegedRole(actor.member.role);
    }),
  isManagementAuthorized: (actorSubject: Subject, targetSubject?: Subject) =>
    Effect.gen(function* () {
      const actor = yield* memberFor(betterAuth, String(actorSubject)).pipe(
        Effect.mapError(() => authorityFailure("Better Auth membership lookup failed.")),
      );
      if (!actor) return false;
      return (
        String(actorSubject) === String(targetSubject ?? actorSubject) ||
        isPrivilegedRole(actor.member.role)
      );
    }),
  verifyProof: (input: {
    readonly credential: VerifiedDelegatedCredential;
    readonly machineActor: Subject;
  }) => {
    const raw = requestHeaders.get("authorization") ?? requestHeaders.get("x-api-key");
    const key = raw?.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : raw;
    if (!key) return Effect.succeed(false);
    return Effect.tryPromise<
      Awaited<ReturnType<BetterAuthHandle["auth"]["api"]["verifyApiKey"]>>,
      StorageError
    >({
      try: () =>
        betterAuth.auth.api.verifyApiKey({
          body: { key },
          headers: requestHeaders,
        }),
      catch: () => authorityFailure("Failed to verify the Better Auth API key."),
    }).pipe(
      Effect.map(
        (result) =>
          result.valid &&
          result.key !== null &&
          result.key.id === input.credential.credentialRef &&
          result.key.referenceId === input.credential.subject &&
          `machine:${result.key.id}` === String(input.machineActor),
      ),
    );
  },
  verifyProviderCredential: (input: {
    readonly credential: VerifiedDelegatedCredential;
    readonly actorSubject: Subject;
    readonly effectiveSubject: Subject;
  }) =>
    Effect.gen(function* () {
      if (
        input.credential.kind !== "issued-key" ||
        !String(input.actorSubject).startsWith("machine:")
      )
        return false;
      const keyId = String(input.actorSubject).slice("machine:".length);
      if (keyId !== input.credential.credentialRef) return false;
      const key = yield* Effect.tryPromise({
        try: async () => {
          const context = await betterAuth.auth.$context;
          return context.adapter.findOne<ApiKeyRow>({
            model: "apikey",
            where: [{ field: "id", value: keyId }],
          });
        },
        catch: () => authorityFailure("Failed to read the Better Auth API key."),
      });
      if (!isCurrentApiKey(key) || key.referenceId !== input.credential.subject) return false;
      const actor = yield* memberForActor(betterAuth, String(input.actorSubject)).pipe(
        Effect.mapError(() => authorityFailure("Better Auth membership lookup failed.")),
      );
      const target = yield* memberFor(betterAuth, String(input.effectiveSubject)).pipe(
        Effect.mapError(() => authorityFailure("Better Auth membership lookup failed.")),
      );
      if (!actor || !target) return false;
      return actor.member.userId === target.member.userId || isPrivilegedRole(actor.member.role);
    }),
});

/** Build the live self-host delegation service for a trusted HTTP request. */
export const makeSelfHostDelegationServiceForHeaders = (
  db: SelfHostDbHandle,
  betterAuth: BetterAuthHandle,
  config: SelfHostConfig,
  requestHeaders: Headers,
): DelegationService =>
  makeSelfHostDelegationService(
    db,
    betterAuth,
    config,
    makeSelfHostAuthority(betterAuth, requestHeaders),
  );

/**
 * Attribute a browser approval to the verified Better Auth human while keeping
 * the stored delegated grant as the execution identity. The binding is
 * resolved first, so a revoked/expired/scope-changed grant cannot receive a
 * successful approval audit or wake the paused execution.
 */
export const auditSelfHostBrowserApproval = (
  db: SelfHostDbHandle,
  betterAuth: BetterAuthHandle,
  config: SelfHostConfig,
  input: {
    readonly owner: Extract<
      import("@executor-js/host-mcp").Principal,
      { readonly kind: "delegated" }
    >;
    readonly approver: Extract<
      import("@executor-js/host-mcp").Principal,
      { readonly kind?: "member" }
    >;
    readonly executionId: string;
    readonly response: { readonly action: "accept" | "decline" | "cancel" };
  },
  requestHeaders: Headers,
): Effect.Effect<void, StorageFailure> => {
  const service = makeSelfHostDelegationServiceForHeaders(db, betterAuth, config, requestHeaders);
  return Effect.gen(function* () {
    const approver = yield* memberFor(betterAuth, input.approver.accountId).pipe(
      Effect.mapError(() => authorityFailure("Better Auth membership lookup failed.")),
    );
    if (
      !approver ||
      (approver.user.id !== input.owner.effectiveSubject && !isPrivilegedRole(approver.member.role))
    ) {
      return yield* authorityFailure("The browser approver is no longer authorized.");
    }
    const tenant = Tenant.make(input.owner.tenant);
    const grantId = DelegationId.make(input.owner.grantId);
    const credentialId = CredentialId.make(input.owner.credentialId);
    const effectiveSubject = Subject.make(input.owner.effectiveSubject);
    yield* service.resolveBinding({
      tenant,
      grantId,
      credentialId,
      credentialRef: input.owner.credentialRef,
      actorSubject: Subject.make(input.owner.actorSubject),
      effectiveSubject,
      scopeVersion: DelegationScopeVersion.make(input.owner.scopeVersion),
    });
    yield* service.audit({
      grantId,
      credentialId,
      actorSubject: Subject.make(input.approver.accountId),
      effectiveSubject,
      action: "approval",
      outcome: input.response.action === "accept" ? "allowed" : "denied",
      executionId: input.executionId,
    });
  });
};

/**
 * Rebuild the original grant-scoped execution stack when a human approves an
 * HTTP execution after the request that paused it has ended. The approver is
 * checked separately from the stored machine binding; the rebuilt executor
 * retains the original delegated grant and therefore cannot inherit the
 * approver's broader workspace access.
 */
export const makeSelfHostDelegatedExecutionResumer = (
  db: SelfHostDbHandle,
  betterAuth: BetterAuthHandle,
  config: SelfHostConfig,
): DelegatedExecutionResumerShape => {
  const serviceFor = () =>
    makeSelfHostDelegationServiceForHeaders(db, betterAuth, config, new Headers());

  return {
    authorize: (input) =>
      Effect.gen(function* () {
        if (input.approver.accountId === null) return false;
        const approver = yield* memberFor(betterAuth, input.approver.accountId).pipe(
          Effect.mapError(() => authorityFailure("Better Auth membership lookup failed.")),
        );
        if (!approver) return false;
        if (
          input.approver.accountId !== String(input.binding.effectiveSubject) &&
          !isPrivilegedRole(approver.member.role)
        )
          return false;
        yield* serviceFor().resolveBinding(input.binding);
        return true;
      }),
    resume: (input) =>
      Effect.gen(function* () {
        if (input.approver.accountId === null) return null;
        const service = serviceFor();
        const grant = yield* service.resolveBinding(input.binding);
        yield* service.audit({
          grantId: grant.grantId,
          credentialId: grant.credentialId,
          actorSubject: Subject.make(input.approver.accountId),
          effectiveSubject: grant.effectiveSubject,
          action: "approval",
          outcome: "allowed",
          executionId: input.executionId,
        });
        const stack = yield* makeExecutionStack<SelfHostPlugins>(
          String(grant.effectiveSubject),
          String(grant.tenant),
          betterAuth.organizationName,
          { delegation: grant },
        ).pipe(
          Effect.provide(
            SelfHostExecutionStackLayer.pipe(Layer.provide(Layer.succeed(SelfHostDb)(db))),
          ),
        );
        return yield* stack.engine
          .executeWithPause(input.code, { autoApprove: true })
          .pipe(Effect.ensuring(stack.engine.shutdown));
      }),
  };
};

const scopeSnapshot = (
  db: SelfHostDbHandle,
  betterAuth: BetterAuthHandle,
  targetSubject: string,
  scope: typeof import("@executor-js/api").DelegationScope.Type,
) => {
  const executorEffect = makeScopedExecutor<SelfHostPlugins>(
    targetSubject,
    betterAuth.organizationId,
    betterAuth.organizationName,
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(DbProvider)({ db: db.db, fuma: db.fuma, close: db.close }),
        SelfHostPluginsProvider,
        SelfHostHostConfig,
      ),
    ),
  );
  return Effect.gen(function* () {
    const executor = yield* executorEffect;
    const toolkits = yield* executor.toolkits.list();
    const snapshots = yield* Effect.forEach(scope.toolkitIds, (toolkitId) => {
      const toolkit = toolkits.find((item) => item.id === toolkitId);
      if (!toolkit) return Effect.fail(failure("Delegation toolkit is unavailable."));
      return executor.toolkits
        .snapshotForSlug(toolkit.slug)
        .pipe(
          Effect.flatMap((snapshot) =>
            snapshot
              ? Effect.succeed(snapshot)
              : Effect.fail(failure("Delegation toolkit is unavailable.")),
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
      connectionAddresses: connections,
    } satisfies DelegationScope;
  }).pipe(Effect.mapError(() => failure("Failed to build the delegated scope snapshot.")));
};

/** Build the same live target catalog used by scopeSnapshot, projecting only
 * stable ids and display metadata for the human consent form. Labels are
 * presentation data; only the returned ids are accepted by scope creation. */
const scopeOptions = (
  db: SelfHostDbHandle,
  betterAuth: BetterAuthHandle,
  targetSubject: string,
  config: Pick<SelfHostConfig, "delegatedMaxTtlMs">,
) => {
  const executorEffect = makeScopedExecutor<SelfHostPlugins>(
    targetSubject,
    betterAuth.organizationId,
    betterAuth.organizationName,
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(DbProvider)({ db: db.db, fuma: db.fuma, close: db.close }),
        SelfHostPluginsProvider,
        SelfHostHostConfig,
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
    const addressToToolkits = new Map<string, string[]>();
    for (const { toolkit, snapshot } of activeSnapshots) {
      for (const address of snapshot.connectionAddresses) {
        const id = String(address);
        const toolkitIds = addressToToolkits.get(id) ?? [];
        toolkitIds.push(String(toolkit.id));
        addressToToolkits.set(id, toolkitIds);
      }
    }
    const connections = (yield* executor.connections.list())
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
      maxExpiresAt: new Date(Date.now() + config.delegatedMaxTtlMs).toISOString(),
    };
  }).pipe(Effect.mapError(() => failure("Failed to read delegation scope choices.")));
};

const recentHuman = (
  betterAuth: BetterAuthHandle,
  request: DelegationRequestContext,
  config: SelfHostConfig,
): Effect.Effect<DelegationHuman, AccountError | AccountUnauthorized | AccountForbidden> => {
  if (!sameOrigin(request, config))
    return Effect.fail(
      new AccountForbidden({
        message: "Delegation management requires a same-origin browser request.",
      }),
    );
  if (!request.headers.cookie || request.headers.authorization || request.headers["x-api-key"]) {
    return Effect.fail(new AccountUnauthorized());
  }
  return Effect.promise(() => betterAuth.auth.api.getSession({ headers: headersOf(request) })).pipe(
    Effect.flatMap(
      (
        session,
      ): Effect.Effect<DelegationHuman, AccountError | AccountForbidden | AccountUnauthorized> => {
        if (!session) return Effect.fail(new AccountUnauthorized());
        const createdAt = new Date(session.session.createdAt).getTime();
        const recent =
          Number.isSafeInteger(createdAt) &&
          Date.now() >= createdAt &&
          Date.now() - createdAt <= config.delegatedRecentAuthMaxAgeMs;
        return memberFor(betterAuth, session.user.id).pipe(
          Effect.flatMap((record) =>
            record
              ? Effect.succeed({
                  subject: session.user.id,
                  organizationId: betterAuth.organizationId,
                  recent,
                  canFilterTargets: isPrivilegedRole(record.member.role),
                })
              : Effect.fail(
                  new AccountForbidden({ message: "The current user is no longer a member." }),
                ),
          ),
        );
      },
    ),
  );
};

export const selfHostDelegationProvider = (
  db: SelfHostDbHandle,
  betterAuth: BetterAuthHandle,
  config: SelfHostConfig,
) => {
  const host: DelegationAccountHost = {
    human: (request) => recentHuman(betterAuth, request, config),
    service: (request) =>
      Effect.succeed(
        makeSelfHostDelegationServiceForHeaders(db, betterAuth, config, headersOf(request)),
      ),
    targets: (request) =>
      recentHuman(betterAuth, request, config).pipe(
        Effect.flatMap((human) => targetListFor(betterAuth, human.subject)),
      ),
    // The shared provider calls this after a machine has completed possession
    // proof. Human-gated operations authorize the target before reaching this
    // lookup; completion must remain usable with the machine's API key and no
    // browser cookie.
    target: (_request, subject) => targetFor(betterAuth, subject, subject),
    scopeOptions: (_request, targetSubject) => scopeOptions(db, betterAuth, targetSubject, config),
    scope: (_request, targetSubject, scope) => scopeSnapshot(db, betterAuth, targetSubject, scope),
    proof: (request, adapter) => {
      const raw = request.headers.authorization ?? request.headers["x-api-key"];
      const key = raw?.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : raw;
      if (!key) return Effect.fail(new AccountUnauthorized());
      return Effect.tryPromise({
        try: () => betterAuth.auth.api.verifyApiKey({ body: { key }, headers: headersOf(request) }),
        catch: () => new AccountUnauthorized(),
      }).pipe(
        Effect.flatMap((result) => {
          if (!result.valid || !result.key) return Effect.fail(new AccountUnauthorized());
          const credential: VerifiedDelegatedCredential = {
            kind: "external",
            adapter,
            issuer: betterAuth.auth.options.baseURL,
            audience: betterAuth.organizationId,
            subject: result.key.referenceId,
            credentialRef: result.key.id,
          };
          return Effect.succeed({ credential, machineActor: `machine:${result.key.id}` });
        }),
      );
    },
    externalAdapters: ["better-auth-api-key"],
    providerKeys: providerKeyStore(betterAuth),
    localKeysEnabled: true,
    issuanceEnabled: config.delegatedIssuanceEnabled,
  };
  return makeDelegationProvider(host);
};
