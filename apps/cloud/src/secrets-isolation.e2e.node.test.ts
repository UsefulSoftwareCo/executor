// End-to-end coverage for secret isolation *through the real HTTP API*.
//
// Complements tenant-isolation.node.test.ts (which already covers plain
// cross-org isolation at the org scope) by exercising the two-scope stack
// the cloud app actually ships: `[userOrgScope, orgScope]`. The harness
// builds the same shape `apps/cloud/src/services/executor.ts#createScopedExecutor`
// builds in production, and every request goes through `HttpApiClient` →
// `fetch` → the real `ProtectedCloudApi` → the real Drizzle/FumaDB path.
//
// Invariants the product is staking on:
//
//   1. Users in different orgs can't see each other's secret metadata.
//   2. Users in the same org can't see each other's user-scoped secret
//      metadata (per-user OAuth tokens etc. don't leak to co-workers).
//   3. Org-scoped secret metadata IS visible to every user in that org
//      — an admin writing a shared API key serves the whole tenant.
//   4. The same user id in different orgs gets distinct per-user scopes —
//      the userOrgScope id bakes in the org id on purpose.
//   5. secrets.set rejects a scope id outside the caller's executor stack.
//
// NOTE: "per-user override shadows org default" cross-scope co-existence
// is NOT covered here. `executor.secrets.set` currently deletes secret
// metadata rows across the full scope stack before re-inserting at the
// target scope (see executor.ts `secretsSet`), so an overrider writing
// at their user-org scope wipes the org-level default rather than
// shadowing it. If the product wants both rows to coexist, that's an
// SDK-level change — coverage for it belongs after the fix.

import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { ScopeId, SecretId } from "@executor-js/sdk";

import { asUser, testUserOrgScopeId } from "./services/__test-harness__/api-harness";

const uniq = () => crypto.randomUUID().slice(0, 8);
const nextOrgId = () => `org_iso_${uniq()}`;
const nextUserId = () => `user_iso_${uniq()}`;

describe("cloud secret isolation (HTTP, user-org scope stack)", () => {
  it.effect("users in different orgs cannot read each other's org-scoped secrets", () =>
    Effect.gen(function* () {
      const orgA = nextOrgId();
      const orgB = nextOrgId();
      const alice = nextUserId();
      const charlie = nextUserId();
      const id = `sec_${uniq()}`;

      yield* asUser(alice, orgA, (client) =>
        client.secrets.set({
          params: { scopeId: ScopeId.make(orgA) },
          payload: {
            id: SecretId.make(id),
            name: "Shared",
            value: "alice-org-secret",
          },
        }),
      );

      const charlieStatus = yield* asUser(charlie, orgB, (client) =>
        client.secrets.status({
          params: { scopeId: ScopeId.make(orgB), secretId: SecretId.make(id) },
        }),
      );
      expect(charlieStatus.status).toBe("missing");

      const charlieList = yield* asUser(charlie, orgB, (client) =>
        client.secrets.list({ params: { scopeId: ScopeId.make(orgB) } }),
      );
      expect(charlieList.map((s) => s.id)).not.toContain(id);
    }),
  );

  it.effect("users in same org cannot read each other's user-scoped secrets", () =>
    Effect.gen(function* () {
      const organizationId = nextOrgId();
      const aliceId = nextUserId();
      const bobId = nextUserId();
      const id = `sec_${uniq()}`;

      // Alice writes at her per-user scope — where OAuth tokens land.
      yield* asUser(aliceId, organizationId, (client) =>
        client.secrets.set({
          params: { scopeId: ScopeId.make(testUserOrgScopeId(aliceId, organizationId)) },
          payload: {
            id: SecretId.make(id),
            name: "Alice's token",
            value: "alice-token-value",
          },
        }),
      );

      // Bob is in the same org — his user-org scope differs. He should
      // not see the token in a list.
      const bobList = yield* asUser(bobId, organizationId, (client) =>
        client.secrets.list({
          params: { scopeId: ScopeId.make(testUserOrgScopeId(bobId, organizationId)) },
        }),
      );
      expect(bobList.map((s) => s.id)).not.toContain(id);

      const bobStatus = yield* asUser(bobId, organizationId, (client) =>
        client.secrets.status({
          params: {
            scopeId: ScopeId.make(testUserOrgScopeId(bobId, organizationId)),
            secretId: SecretId.make(id),
          },
        }),
      );
      expect(bobStatus.status).toBe("missing");

      // And Alice still sees her own token metadata.
      const aliceStatus = yield* asUser(aliceId, organizationId, (client) =>
        client.secrets.status({
          params: {
            scopeId: ScopeId.make(testUserOrgScopeId(aliceId, organizationId)),
            secretId: SecretId.make(id),
          },
        }),
      );
      expect(aliceStatus.status).toBe("resolved");
    }),
  );

  it.effect("org-scoped secrets are visible to every user in that org", () =>
    Effect.gen(function* () {
      const organizationId = nextOrgId();
      const adminId = nextUserId();
      const memberId = nextUserId();
      const id = `sec_${uniq()}`;

      yield* asUser(adminId, organizationId, (client) =>
        client.secrets.set({
          params: { scopeId: ScopeId.make(organizationId) },
          payload: {
            id: SecretId.make(id),
            name: "Org API Key",
            value: "shared-org-key",
          },
        }),
      );

      const adminStatus = yield* asUser(adminId, organizationId, (client) =>
        client.secrets.status({
          params: { scopeId: ScopeId.make(organizationId), secretId: SecretId.make(id) },
        }),
      );
      const memberStatus = yield* asUser(memberId, organizationId, (client) =>
        client.secrets.status({
          params: { scopeId: ScopeId.make(organizationId), secretId: SecretId.make(id) },
        }),
      );
      expect(adminStatus.status).toBe("resolved");
      expect(memberStatus.status).toBe("resolved");
    }),
  );

  it.effect("same userId in different orgs gets distinct per-user scopes", () =>
    Effect.gen(function* () {
      const userId = nextUserId();
      const orgA = nextOrgId();
      const orgB = nextOrgId();
      const id = `sec_${uniq()}`;

      yield* asUser(userId, orgA, (client) =>
        client.secrets.set({
          params: { scopeId: ScopeId.make(testUserOrgScopeId(userId, orgA)) },
          payload: {
            id: SecretId.make(id),
            name: "A token",
            value: "value-in-a",
          },
        }),
      );

      // Same user id, different org → distinct user-org scope. The
      // secret written in org A must not be visible when the same user
      // logs into org B.
      const listInB = yield* asUser(userId, orgB, (client) =>
        client.secrets.list({
          params: { scopeId: ScopeId.make(testUserOrgScopeId(userId, orgB)) },
        }),
      );
      expect(listInB.map((s) => s.id)).not.toContain(id);

      const statusInB = yield* asUser(userId, orgB, (client) =>
        client.secrets.status({
          params: {
            scopeId: ScopeId.make(testUserOrgScopeId(userId, orgB)),
            secretId: SecretId.make(id),
          },
        }),
      );
      expect(statusInB.status).toBe("missing");

      // Sanity: the original write is still visible under the org-A
      // user-org scope.
      const statusInA = yield* asUser(userId, orgA, (client) =>
        client.secrets.status({
          params: {
            scopeId: ScopeId.make(testUserOrgScopeId(userId, orgA)),
            secretId: SecretId.make(id),
          },
        }),
      );
      expect(statusInA.status).toBe("resolved");
    }),
  );

  it.effect("secrets.set rejects a scope outside the executor's stack", () =>
    Effect.gen(function* () {
      const organizationId = nextOrgId();
      const userId = nextUserId();
      const foreignOrg = nextOrgId();

      const result = yield* asUser(userId, organizationId, (client) =>
        client.secrets
          .set({
            params: { scopeId: ScopeId.make(foreignOrg) },
            payload: {
              id: SecretId.make("wrong-scope"),
              name: "x",
              value: "should not land",
            },
          })
          .pipe(Effect.result),
      );
      expect(Result.isFailure(result)).toBe(true);

      // And nothing landed in the foreign org — a fresh session pointed
      // at that org must not see `wrong-scope`.
      const foreignUser = nextUserId();
      const leaked = yield* asUser(foreignUser, foreignOrg, (client) =>
        client.secrets.status({
          params: {
            scopeId: ScopeId.make(foreignOrg),
            secretId: SecretId.make("wrong-scope"),
          },
        }),
      );
      expect(leaked.status).toBe("missing");
    }),
  );
});
