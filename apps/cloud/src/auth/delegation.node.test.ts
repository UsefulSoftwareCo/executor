import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  collectTables,
  Subject,
  type DelegationService,
  type VerifiedDelegatedCredential,
} from "@executor-js/sdk";
import { createSqliteTestFumaDb, type SqliteTestFumaDb } from "@executor-js/sdk/testing";
import type { MemberDirectoryShape } from "@executor-js/api/server";

import { makeCloudDelegationService, workosDelegatedCredential } from "./delegation";

const TENANT = "cloud-delegation-test";
const HUMAN = "user-target";
const KEY_ID = "key_delegated";

const directory: MemberDirectoryShape = {
  membership: (accountId, organizationId, statuses) =>
    Effect.succeed(
      accountId === HUMAN &&
        organizationId === TENANT &&
        (statuses === undefined || statuses.includes("active"))
        ? {
            accountId,
            membershipId: "membership-target",
            organizationId,
            email: "target@example.test",
            name: "Target",
            avatarUrl: null,
            role: "member",
            status: "active" as const,
            lastActiveAt: null,
          }
        : null,
    ),
  membershipById: () => Effect.succeed(null),
  membershipsOf: () => Effect.succeed([]),
  members: () => Effect.succeed([]),
  membersById: () => Effect.succeed(new Map()),
  findByEmail: () => Effect.succeed(null),
};

const apiKeys = {
  listUserKeys: ({ accountId, organizationId }: { accountId: string; organizationId: string }) =>
    Effect.succeed(accountId === HUMAN && organizationId === TENANT ? [{ id: KEY_ID }] : []),
};

const credential: VerifiedDelegatedCredential = {
  kind: "issued-key",
  adapter: "workos-api-key",
  issuer: "https://api.workos.com",
  audience: TENANT,
  subject: HUMAN,
  credentialRef: KEY_ID,
};

const externalCredential: VerifiedDelegatedCredential = {
  ...credential,
  kind: "external",
};

const withDb = <A, E>(body: (db: SqliteTestFumaDb) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() })),
    body,
    (db) => Effect.promise(() => db.close()),
  );

const makeCloudService = (db: SqliteTestFumaDb): DelegationService =>
  makeCloudDelegationService({
    db: db.db,
    tenant: TENANT,
    directory,
    apiKeys,
    issuanceEnabled: true,
    verifyProviderCredential: ({ credential: candidate, effectiveSubject }) =>
      Effect.succeed(
        candidate.kind === credential.kind &&
          candidate.adapter === credential.adapter &&
          candidate.credentialRef === credential.credentialRef &&
          String(effectiveSubject) === HUMAN,
      ),
    verifyProof: ({ credential: candidate, machineActor }) =>
      Effect.succeed(
        candidate.credentialRef === KEY_ID && String(machineActor) === `machine:${KEY_ID}`,
      ),
  });

describe("cloud delegation authority", () => {
  it.effect("uses the exact issued-key tuple and blocks a revoked binding", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const service = makeCloudService(db);
        const registered = yield* service.registerProviderIssuedKey({
          createdBy: Subject.make(HUMAN),
          effectiveSubject: Subject.make(HUMAN),
          actorSubject: Subject.make(`machine:${KEY_ID}`),
          label: "Cloud machine",
          scope: {
            actions: ["discover", "invoke"],
            toolkitMembership: [],
            toolAddresses: [],
          },
          credential,
        });
        const resolved = yield* service.resolve(
          workosDelegatedCredential(
            { scope: "user", accountId: HUMAN, organizationId: TENANT, keyId: KEY_ID },
            credential.issuer,
          )!,
        );
        expect(resolved.grantId).toBe(registered.grantId);
        yield* service.revoke({
          grantId: registered.grantId,
          actorSubject: Subject.make(HUMAN),
        });
        const denied = yield* service.resolve(credential).pipe(Effect.flip);
        expect(denied).toMatchObject({ _tag: "DelegationDeniedError", reason: "revoked" });
      }),
    ),
  );

  it.effect("leaves ordinary WorkOS keys unmapped", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const service = makeCloudService(db);
        const denied = yield* service
          .resolve({ ...credential, credentialRef: "key_ordinary" })
          .pipe(Effect.flip);
        expect(denied).toMatchObject({ reason: "unmapped" });
      }),
    ),
  );

  it.effect("resolves a proof-bound ordinary WorkOS key and revokes it live", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const service = makeCloudService(db);
        const challenge = yield* service.issueProofChallenge({
          adapter: "workos-api-key",
          createdBy: Subject.make(HUMAN),
          effectiveSubject: Subject.make(HUMAN),
          label: "Existing WorkOS PAT",
          scope: {
            actions: ["discover", "invoke"],
            toolkitMembership: [],
            toolAddresses: [],
          },
        });
        const completed = yield* service.completeProofChallenge({
          challengeId: challenge.challengeId,
          credential: externalCredential,
          machineActor: Subject.make(`machine:${KEY_ID}`),
          nonce: challenge.nonce,
        });
        const grant = yield* service.create({
          proofChallengeId: completed.challengeId,
          consentedBy: Subject.make(HUMAN),
        });
        const resolved = yield* service.resolve(externalCredential);
        expect(resolved.grantId).toBe(grant.grantId);
        yield* service.revalidate(resolved, { operation: "invoke" });
        yield* service.revoke({
          grantId: grant.grantId,
          actorSubject: Subject.make(HUMAN),
        });
        const denied = yield* service.resolve(externalCredential).pipe(Effect.flip);
        expect(denied).toMatchObject({ _tag: "DelegationDeniedError", reason: "revoked" });
      }),
    ),
  );
});
