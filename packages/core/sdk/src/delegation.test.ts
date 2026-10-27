import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { collectTables } from "./executor";
import { makeDelegationService } from "./delegation";
import { DelegationDeniedError } from "./fuma-runtime";
import { Subject, Tenant, ToolAddress } from "./ids";
import { createSqliteTestFumaDb, type SqliteTestFumaDb } from "./sqlite-test-db";

const CREATED_BY = Subject.make("human_creator");
const TARGET = Subject.make("human_target");
const MACHINE = Subject.make("machine_actor");
const CREDENTIAL = {
  kind: "external" as const,
  adapter: "access",
  issuer: "issuer.example",
  audience: "executor",
  subject: "machine-public-subject",
  credentialRef: "service-token-id",
};
const PROVIDER_CREDENTIAL = {
  kind: "issued-key" as const,
  adapter: "better-auth-api-key",
  issuer: "https://auth.example",
  audience: "tenant-a",
  subject: "provider-key-subject",
  credentialRef: "provider-key-1",
};
const SCOPE = {
  actions: ["discover", "invoke"] as const,
  toolkitMembership: [
    {
      toolkitId: "toolkit-one",
      revision: "rev-1",
      toolAddresses: ["org.integration.connection.tool"],
      connectionAddresses: ["org.integration.connection"],
    },
  ],
  toolAddresses: ["org.integration.connection.tool"],
  connectionAddresses: ["org.integration.connection"],
};

const withDb = <A, E>(body: (db: SqliteTestFumaDb) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() })),
    body,
    (db) => Effect.promise(() => db.close()),
  );

const makeService = (db: SqliteTestFumaDb, tenant: string, now: () => number) =>
  makeDelegationService({
    db: db.db,
    tenant: Tenant.make(tenant),
    issuanceEnabled: true,
    now,
    isVerifiedHuman: () => Effect.succeed(true),
    isCurrentlyAuthorized: () => Effect.succeed(true),
    isManagementAuthorized: () => Effect.succeed(true),
    verifyProof: () => Effect.succeed(true),
  });

const makeProviderService = (db: SqliteTestFumaDb, now: () => number) =>
  makeDelegationService({
    db: db.db,
    tenant: Tenant.make("tenant-a"),
    issuanceEnabled: true,
    now,
    isVerifiedHuman: () => Effect.succeed(true),
    isCurrentlyAuthorized: () => Effect.succeed(true),
    isManagementAuthorized: () => Effect.succeed(true),
    verifyProof: () => Effect.succeed(true),
    verifyProviderCredential: () => Effect.succeed(true),
  });

const expectDenied = (
  effect: Effect.Effect<unknown, unknown>,
  reason: DelegationDeniedError["reason"],
) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(error).toBeInstanceOf(DelegationDeniedError);
      expect((error as DelegationDeniedError).reason).toBe(reason);
    }),
  );

describe("delegation service", () => {
  it.effect("projects private status and rotates issued keys as tombstones", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const now = () => 1_700_000_000_000;
        const service = makeService(db, "tenant-a", now);
        const issued = yield* service.createIssuedKey({
          createdBy: CREATED_BY,
          effectiveSubject: TARGET,
          label: "Local agent",
          scope: SCOPE,
        });
        expect(issued.secret).toMatch(/^key_[0-9a-f]{32}\.[0-9a-f]{64}$/);
        expect(issued.keyRef).toMatch(/^key_[0-9a-f]{32}$/);
        const localResolved = yield* service.resolveIssuedKey(issued.secret);
        expect(localResolved.grantId).toBe(issued.grant.grantId);
        yield* expectDenied(
          service.resolveIssuedKey(`${issued.keyRef}.${"0".repeat(64)}`),
          "invalid",
        );
        yield* expectDenied(
          service.resolveIssuedKey(`key_${"f".repeat(32)}.${"0".repeat(64)}`),
          "unmapped",
        );
        const view = yield* service.get(issued.grant.grantId);
        expect(view?.credentialRefMasked).not.toContain(issued.secret);
        expect(view?.effectiveSubject).toBe(TARGET);
        expect((yield* service.list()).length).toBe(1);
        const rebound = yield* service.resolveBinding({
          tenant: issued.grant.tenant,
          grantId: issued.grant.grantId,
          credentialId: issued.grant.credentialId,
          credentialRef: issued.grant.credentialRef,
          actorSubject: issued.grant.actorSubject,
          effectiveSubject: issued.grant.effectiveSubject,
          scopeVersion: issued.grant.scopeVersion,
        });
        expect(rebound.grantId).toBe(issued.grant.grantId);
        yield* expectDenied(
          service.resolveBinding({
            tenant: Tenant.make("tenant-b"),
            grantId: issued.grant.grantId,
            credentialId: issued.grant.credentialId,
            credentialRef: issued.grant.credentialRef,
            actorSubject: issued.grant.actorSubject,
            effectiveSubject: issued.grant.effectiveSubject,
            scopeVersion: issued.grant.scopeVersion,
          }),
          "invalid",
        );
        const expandedScope = {
          ...SCOPE,
          toolAddresses: [...SCOPE.toolAddresses, "org.integration.connection.second"],
          connectionAddresses: [...SCOPE.connectionAddresses, "org.integration.connection.second"],
          toolkitMembership: [
            {
              ...SCOPE.toolkitMembership[0]!,
              toolAddresses: [
                ...SCOPE.toolkitMembership[0]!.toolAddresses,
                "org.integration.connection.second",
              ],
              connectionAddresses: [
                ...SCOPE.toolkitMembership[0]!.connectionAddresses,
                "org.integration.connection.second",
              ],
            },
          ],
        };
        const expanded = yield* service.expand({
          credentialId: issued.grant.credentialId,
          consentedBy: CREATED_BY,
          scope: expandedScope,
          expiresAt: now() + 86_400_000,
          expectedScopeVersion: issued.grant.scopeVersion,
        });
        yield* expectDenied(
          service.resolveBinding({
            tenant: issued.grant.tenant,
            grantId: issued.grant.grantId,
            credentialId: issued.grant.credentialId,
            credentialRef: issued.grant.credentialRef,
            actorSubject: issued.grant.actorSubject,
            effectiveSubject: issued.grant.effectiveSubject,
            scopeVersion: issued.grant.scopeVersion,
          }),
          "scope",
        );
        expect(expanded.scopeVersion).not.toBe(issued.grant.scopeVersion);

        const challenge = yield* service.issueProofChallenge({
          adapter: "access",
          createdBy: CREATED_BY,
          effectiveSubject: TARGET,
          label: "External agent",
          scope: SCOPE,
        });
        const pending = yield* service.getChallenge(challenge.challengeId);
        expect(pending?.status).toBe("awaiting-proof");
        expect(pending?.proofConsumedAt).toBeNull();
        expect(pending?.provenCredentialRefMasked).toBeNull();
        yield* service.completeProofChallenge({
          challengeId: challenge.challengeId,
          credential: CREDENTIAL,
          machineActor: MACHINE,
          nonce: challenge.nonce,
        });
        const proven = yield* service.getChallenge(challenge.challengeId);
        expect(proven?.status).toBe("proof-complete");
        expect(proven?.provenCredentialRefMasked).not.toBe(CREDENTIAL.credentialRef);
        expect(proven?.provenActorSubject).toBe(MACHINE);
        yield* service.create({ proofChallengeId: challenge.challengeId, consentedBy: CREATED_BY });

        const rotated = yield* service.rotateIssuedKey({
          credentialId: issued.grant.credentialId,
          actorSubject: CREATED_BY,
        });
        yield* expectDenied(service.resolveIssuedKey(issued.secret), "revoked");
        const rotatedResolved = yield* service.resolveIssuedKey(rotated.secret);
        expect(rotatedResolved.grantId).toBe(rotated.grant.grantId);
        yield* expectDenied(
          service.resolve({
            kind: "issued-key",
            adapter: "executor",
            issuer: "executor",
            audience: "delegated",
            subject: issued.keyRef,
            credentialRef: issued.keyRef,
          }),
          "revoked",
        );
        const resolved = yield* service.resolve({
          kind: "issued-key",
          adapter: "executor",
          issuer: "executor",
          audience: "delegated",
          subject: rotated.keyRef,
          credentialRef: rotated.keyRef,
        });
        expect(resolved.grantId).toBe(rotated.grant.grantId);
        expect((yield* service.list({ includeRevoked: true })).length).toBe(3);
        expect((yield* service.listAudit({ limit: 100 })).length).toBeGreaterThanOrEqual(6);
      }),
    ),
  );

  it.effect("requires machine proof before human consent and consumes both phases once", () =>
    withDb((db) =>
      Effect.gen(function* () {
        let clock = 1_700_000_000_000;
        const service = makeService(db, "tenant-a", () => clock);
        const challenge = yield* service.issueProofChallenge({
          adapter: "access",
          createdBy: CREATED_BY,
          effectiveSubject: TARGET,
          label: "Build agent",
          scope: SCOPE,
        });

        yield* expectDenied(
          service.create({ proofChallengeId: challenge.challengeId, consentedBy: CREATED_BY }),
          "proof",
        );
        const completed = yield* service.completeProofChallenge({
          challengeId: challenge.challengeId,
          credential: CREDENTIAL,
          machineActor: MACHINE,
          nonce: challenge.nonce,
        });
        expect(completed.actorSubject).toBe(MACHINE);

        const grant = yield* service.create({
          proofChallengeId: challenge.challengeId,
          consentedBy: CREATED_BY,
        });
        expect(grant.effectiveSubject).toBe(TARGET);
        const resolved = yield* service.resolve(CREDENTIAL);
        expect(resolved.grantId).toBe(grant.grantId);

        yield* expectDenied(
          service.completeProofChallenge({
            challengeId: challenge.challengeId,
            credential: CREDENTIAL,
            machineActor: MACHINE,
            nonce: challenge.nonce,
          }),
          "proof",
        );
        yield* expectDenied(
          service.create({ proofChallengeId: challenge.challengeId, consentedBy: CREATED_BY }),
          "proof",
        );

        clock += 1;
        yield* service.revoke({ grantId: grant.grantId, actorSubject: CREATED_BY });
        const revokedView = yield* service.get(grant.grantId);
        expect(revokedView?.revokedAt).toBe(clock);
        yield* expectDenied(
          service.revoke({ grantId: grant.grantId, actorSubject: CREATED_BY }),
          "revoked",
        );
        expect((yield* service.get(grant.grantId))?.revokedAt).toBe(clock);
        yield* expectDenied(service.resolve(CREDENTIAL), "revoked");
      }),
    ),
  );

  it.effect("persists target-owned notifications across reconstruction and tenants", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const now = () => 1_700_000_000_000;
        const service = makeService(db, "tenant-a", now);
        const issued = yield* service.createIssuedKey({
          createdBy: CREATED_BY,
          effectiveSubject: TARGET,
          label: "Notified agent",
          scope: SCOPE,
        });
        const first = yield* service.listNotifications({ reader: TARGET });
        expect(first).toHaveLength(1);
        const notice = first[0];
        expect(notice).toBeDefined();
        if (notice === undefined) return;
        expect(notice.grantId).toBe(issued.grant.grantId);
        expect(notice.credentialId).toBe(issued.grant.credentialId);
        expect(notice.createdBy).toBe(CREATED_BY);
        expect(notice.targetSubject).toBe(TARGET);
        expect(notice.label).toBe("Notified agent");
        expect(notice.credentialKind).toBe("issued-key");
        expect(notice.readAt).toBeNull();

        expect(yield* service.listNotifications({ reader: CREATED_BY })).toHaveLength(0);
        expect(
          yield* makeService(db, "tenant-b", now).listNotifications({ reader: TARGET }),
        ).toHaveLength(0);
        const rebuilt = makeService(db, "tenant-a", now);
        expect(yield* rebuilt.listNotifications({ reader: TARGET })).toHaveLength(1);
        yield* expectDenied(
          rebuilt.markNotificationRead({ notificationId: notice.id, reader: CREATED_BY }),
          "unauthorized",
        );
        yield* rebuilt.markNotificationRead({ notificationId: notice.id, reader: TARGET });
        expect(yield* rebuilt.listNotifications({ reader: TARGET })).toHaveLength(0);
        const read = yield* rebuilt.listNotifications({ reader: TARGET, includeRead: true });
        expect(read[0]?.readAt).toBe(now());
        yield* rebuilt.markNotificationRead({ notificationId: notice.id, reader: TARGET });
      }),
    ),
  );

  it.effect("rolls back an admin grant when notification persistence fails", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const service = makeService(db, "tenant-a", () => 1_700_000_000_000);
        yield* Effect.promise(() => db.client.execute("DROP TABLE delegation_notification"));
        const result = yield* Effect.exit(
          service.createIssuedKey({
            createdBy: CREATED_BY,
            effectiveSubject: TARGET,
            label: "Missing notice table",
            scope: SCOPE,
          }),
        );
        expect(Exit.isFailure(result)).toBe(true);
        expect(yield* service.list({ includeRevoked: true })).toHaveLength(0);
      }),
    ),
  );

  it.effect("registers and rotates provider-managed keys without storing secrets", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const now = () => 1_700_000_000_000;
        const service = makeProviderService(db, now);
        const withoutVerifier = makeService(db, "tenant-a", now);
        yield* expectDenied(
          withoutVerifier.registerProviderIssuedKey({
            createdBy: CREATED_BY,
            effectiveSubject: TARGET,
            actorSubject: MACHINE,
            label: "Provider agent",
            scope: SCOPE,
            credential: PROVIDER_CREDENTIAL,
          }),
          "unauthorized",
        );
        const first = yield* service.registerProviderIssuedKey({
          createdBy: CREATED_BY,
          effectiveSubject: TARGET,
          actorSubject: MACHINE,
          label: "Provider agent",
          scope: SCOPE,
          credential: PROVIDER_CREDENTIAL,
        });
        expect(first.credentialRef).toBe(PROVIDER_CREDENTIAL.credentialRef);
        expect((yield* service.resolve(PROVIDER_CREDENTIAL)).grantId).toBe(first.grantId);
        const providerNotices = yield* service.listNotifications({ reader: TARGET });
        expect(providerNotices).toHaveLength(1);
        expect(providerNotices[0]?.credentialKind).toBe("issued-key");
        yield* expectDenied(
          service.resolveIssuedKey(`${PROVIDER_CREDENTIAL.credentialRef}.${"0".repeat(64)}`),
          "invalid",
        );
        yield* expectDenied(
          service.registerProviderIssuedKey({
            createdBy: CREATED_BY,
            effectiveSubject: TARGET,
            actorSubject: MACHINE,
            label: "Provider agent duplicate",
            scope: SCOPE,
            credential: PROVIDER_CREDENTIAL,
          }),
          "invalid",
        );
        yield* expectDenied(
          service.registerProviderIssuedKey({
            createdBy: CREATED_BY,
            effectiveSubject: TARGET,
            actorSubject: Subject.make("machine_actor_other"),
            label: "Provider ref collision",
            scope: SCOPE,
            credential: {
              ...PROVIDER_CREDENTIAL,
              subject: "different-provider-subject",
            },
          }),
          "invalid",
        );

        const replacement = {
          ...PROVIDER_CREDENTIAL,
          subject: "provider-key-subject-2",
          credentialRef: "provider-key-2",
        };
        const rotations = yield* Effect.all(
          [0, 1].map(() =>
            Effect.exit(
              service.rotateProviderIssuedKey({
                credentialId: first.credentialId,
                managedBy: CREATED_BY,
                actorSubject: Subject.make("machine_actor_2"),
                credential: replacement,
              }),
            ),
          ),
          { concurrency: "unbounded" },
        );
        expect(rotations.filter(Exit.isSuccess)).toHaveLength(1);
        const rotated = rotations.find(Exit.isSuccess)?.value;
        expect(rotated).toBeDefined();
        if (rotated === undefined) return;
        yield* expectDenied(service.resolve(PROVIDER_CREDENTIAL), "revoked");
        expect((yield* service.resolve(replacement)).grantId).toBe(rotated.grantId);
        expect((yield* service.list({ includeRevoked: true })).length).toBe(2);
      }),
    ),
  );

  it.effect("serializes concurrent proof and consent claims", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const service = makeService(db, "tenant-a", () => 1_700_000_000_000);
        const challenge = yield* service.issueProofChallenge({
          adapter: "access",
          createdBy: CREATED_BY,
          effectiveSubject: TARGET,
          label: "Concurrent agent",
          scope: SCOPE,
        });
        const proofAttempts = yield* Effect.all(
          [0, 1].map(() =>
            Effect.exit(
              service.completeProofChallenge({
                challengeId: challenge.challengeId,
                credential: CREDENTIAL,
                machineActor: MACHINE,
                nonce: challenge.nonce,
              }),
            ),
          ),
          { concurrency: "unbounded" },
        );
        expect(proofAttempts.filter(Exit.isSuccess)).toHaveLength(1);

        const consentAttempts = yield* Effect.all(
          [0, 1].map(() =>
            Effect.exit(
              service.create({
                proofChallengeId: challenge.challengeId,
                consentedBy: CREATED_BY,
              }),
            ),
          ),
          { concurrency: "unbounded" },
        );
        expect(consentAttempts.filter(Exit.isSuccess)).toHaveLength(1);
        expect((yield* service.getChallenge(challenge.challengeId))?.status).toBe("consented");
      }),
    ),
  );

  it.effect("keeps exact credential bindings tenant-local and rejects tuple mismatches", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const now = () => 1_700_000_000_000;
        const first = makeService(db, "tenant-a", now);
        const second = makeService(db, "tenant-b", now);
        const challenge = yield* first.issueProofChallenge({
          adapter: "access",
          createdBy: CREATED_BY,
          effectiveSubject: TARGET,
          label: "Agent",
          scope: SCOPE,
        });
        yield* first.completeProofChallenge({
          challengeId: challenge.challengeId,
          credential: CREDENTIAL,
          machineActor: MACHINE,
          nonce: challenge.nonce,
        });
        const firstGrant = yield* first.create({
          proofChallengeId: challenge.challengeId,
          consentedBy: CREATED_BY,
        });

        yield* expectDenied(second.resolve(CREDENTIAL), "unmapped");
        yield* expectDenied(
          first.resolve({ ...CREDENTIAL, audience: "other-audience" }),
          "invalid",
        );
        const tenantTampered = {
          ...firstGrant,
          tenant: Tenant.make("tenant-b"),
        };
        yield* expectDenied(
          first.revalidate(tenantTampered, {
            operation: "invoke",
            tool: ToolAddress.make(SCOPE.toolAddresses[0]),
          }),
          "unauthorized",
        );
      }),
    ),
  );

  it.effect("fails closed for disabled issuance, wildcard scopes, and expiry", () =>
    withDb((db) =>
      Effect.gen(function* () {
        let clock = 1_700_000_000_000;
        const service = makeDelegationService({
          db: db.db,
          tenant: Tenant.make("tenant-a"),
          issuanceEnabled: false,
          now: () => clock,
          isVerifiedHuman: () => Effect.succeed(true),
          isCurrentlyAuthorized: () => Effect.succeed(true),
          isManagementAuthorized: () => Effect.succeed(true),
          verifyProof: () => Effect.succeed(true),
        });
        yield* expectDenied(
          service.issueProofChallenge({
            adapter: "access",
            createdBy: CREATED_BY,
            effectiveSubject: TARGET,
            label: "Agent",
            scope: { ...SCOPE, toolAddresses: ["org.*"] },
          }),
          "management",
        );

        const enabled = makeService(db, "tenant-a", () => clock);
        yield* expectDenied(
          enabled.issueProofChallenge({
            adapter: "access",
            createdBy: CREATED_BY,
            effectiveSubject: TARGET,
            label: "Agent",
            scope: { ...SCOPE, toolAddresses: ["org.*"] },
          }),
          "invalid",
        );
        yield* expectDenied(
          enabled.issueProofChallenge({
            adapter: "access",
            createdBy: CREATED_BY,
            effectiveSubject: TARGET,
            label: "Agent",
            scope: { ...SCOPE, toolkitMembership: [null] } as never,
          }),
          "invalid",
        );
        yield* expectDenied(enabled.resolve(null as never), "invalid");
        const challenge = yield* enabled.issueProofChallenge({
          adapter: "access",
          createdBy: CREATED_BY,
          effectiveSubject: TARGET,
          label: "Agent",
          scope: SCOPE,
          grantExpiresAt: clock + 1,
        });
        yield* enabled.completeProofChallenge({
          challengeId: challenge.challengeId,
          credential: CREDENTIAL,
          machineActor: MACHINE,
          nonce: challenge.nonce,
        });
        clock += 2;
        yield* expectDenied(
          enabled.create({ proofChallengeId: challenge.challengeId, consentedBy: CREATED_BY }),
          "invalid",
        );
      }),
    ),
  );

  it.effect("bounds omitted expiry to a configured lower TTL", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const now = 1_700_000_000_000;
        const maxTtlMs = 24 * 60 * 60 * 1000;
        const service = makeDelegationService({
          db: db.db,
          tenant: Tenant.make("tenant-a"),
          issuanceEnabled: true,
          maxTtlMs,
          now: () => now,
          isVerifiedHuman: () => Effect.succeed(true),
          isCurrentlyAuthorized: () => Effect.succeed(true),
          isManagementAuthorized: () => Effect.succeed(true),
          verifyProof: () => Effect.succeed(true),
        });
        const issued = yield* service.createIssuedKey({
          createdBy: CREATED_BY,
          effectiveSubject: TARGET,
          label: "Short lived agent",
          scope: SCOPE,
        });
        expect(issued.grant.expiresAt).toBe(now + maxTtlMs);
      }),
    ),
  );
});
