import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ApiKeyService, OrgApiKeyNotFound } from "./api-keys";
import { ApiKeyManagementError } from "./errors";
import { WorkOSClient, type WorkOSClientService } from "./workos";

// ---------------------------------------------------------------------------
// Minting, listing, and revoking ORGANIZATION-owned api keys — the privileged
// credential that resolves to the read-only platform view (`/admin/*`).
//
// The decode boundary is what these pin. WorkOS returns an org-owned key with
// the ORG in `owner.id` and no member at all, which is a different shape from
// the user-owned keys the console's personal-key CRUD handles. The workspace
// api key is also workspace-WIDE, so a response naming a different org than the
// one asked for must not be surfaced as that org's key.
//
// NOTE (emulator gap): the WorkOS emulator's `serializeApiKey` hardcodes
// `owner.type: "user"` and exposes no org-key mint route, so this path cannot
// be exercised over the wire in e2e today. These stubs encode the REAL WorkOS
// API shape (`organizations.createOrganizationApiKey` /
// `listOrganizationApiKeys`, per the installed SDK's types).
// ---------------------------------------------------------------------------

const ORG = "org_123";

const orgKeyResponse = (organizationId: string, id: string, name: string) => ({
  object: "api_key",
  id,
  owner: { type: "organization", id: organizationId },
  name,
  obfuscatedValue: "sk_org…a1b2",
  lastUsedAt: null,
  permissions: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const stubWorkOS = (overrides: Record<string, unknown> = {}) =>
  Layer.succeed(
    WorkOSClient,
    new Proxy({} as WorkOSClientService, {
      get: (_target, prop) => {
        const override = overrides[String(prop)];
        if (override) return override;
        return () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`);
      },
    }),
  );

const serviceWith = (overrides: Record<string, unknown>) =>
  ApiKeyService.asEffect().pipe(
    Effect.provide(ApiKeyService.WorkOS.pipe(Layer.provide(stubWorkOS(overrides)))),
  );

describe("organization API keys", () => {
  it.effect("mints an org-owned key and returns the one-time secret", () =>
    Effect.gen(function* () {
      const apiKeys = yield* serviceWith({
        createOrgApiKey: (params: { organizationId: string; name: string }) =>
          Effect.succeed({
            ...orgKeyResponse(params.organizationId, "key_org_1", params.name),
            value: "sk_org_plaintext",
          }),
      });

      const created = yield* apiKeys.createOrgKey({ organizationId: ORG, name: "acme-backend" });

      expect(created.id).toBe("key_org_1");
      expect(created.name).toBe("acme-backend");
      expect(created.value, "create returns the one-time plaintext secret").toBe(
        "sk_org_plaintext",
      );
      expect(created.obfuscatedValue, "the display value is masked, not the secret").not.toBe(
        created.value,
      );
    }),
  );

  it.effect("lists the organization's own keys, masked", () =>
    Effect.gen(function* () {
      const apiKeys = yield* serviceWith({
        listOrgApiKeys: (organizationId: string) =>
          Effect.succeed({
            object: "list",
            data: [
              orgKeyResponse(organizationId, "key_org_1", "acme-backend"),
              orgKeyResponse(organizationId, "key_org_2", "ci"),
            ],
            listMetadata: { before: null, after: null },
          }),
      });

      const keys = yield* apiKeys.listOrgKeys({ organizationId: ORG });

      expect(keys.map((key) => key.name)).toEqual(["acme-backend", "ci"]);
      expect(JSON.stringify(keys), "the list never carries a plaintext secret").not.toContain(
        "sk_org_plaintext",
      );
    }),
  );

  it.effect("drops a key owned by a DIFFERENT organization", () =>
    Effect.gen(function* () {
      // The WorkOS workspace api key is workspace-wide, so a response naming
      // another org must never be surfaced as this org's key.
      const apiKeys = yield* serviceWith({
        listOrgApiKeys: () =>
          Effect.succeed({
            object: "list",
            data: [
              orgKeyResponse(ORG, "key_mine", "mine"),
              orgKeyResponse("org_other", "key_theirs", "theirs"),
            ],
            listMetadata: { before: null, after: null },
          }),
      });

      const keys = yield* apiKeys.listOrgKeys({ organizationId: ORG });

      expect(
        keys.map((key) => key.id),
        "only this org's key survives",
      ).toEqual(["key_mine"]);
    }),
  );

  it.effect("refuses a create response that names another organization", () =>
    Effect.gen(function* () {
      const apiKeys = yield* serviceWith({
        createOrgApiKey: () =>
          Effect.succeed({
            ...orgKeyResponse("org_other", "key_theirs", "theirs"),
            value: "sk_org_plaintext",
          }),
      });

      const error = yield* Effect.flip(
        apiKeys.createOrgKey({ organizationId: ORG, name: "acme-backend" }),
      );

      expect(error).toBeInstanceOf(ApiKeyManagementError);
    }),
  );

  it.effect("ignores a user-owned key in an org-key listing", () =>
    Effect.gen(function* () {
      // The org and user shapes are decoded separately on purpose; a user key
      // appearing here would mean the caller could mistake a member's personal
      // credential for a workspace one.
      const apiKeys = yield* serviceWith({
        listOrgApiKeys: () =>
          Effect.succeed({
            object: "list",
            data: [
              orgKeyResponse(ORG, "key_mine", "mine"),
              {
                object: "api_key",
                id: "key_user",
                owner: { type: "user", id: "user_1", organization_id: ORG },
                name: "personal",
                obfuscatedValue: "sk_user…c3d4",
                lastUsedAt: null,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
            listMetadata: { before: null, after: null },
          }),
      });

      const keys = yield* apiKeys.listOrgKeys({ organizationId: ORG });

      expect(
        keys.map((key) => key.id),
        "a user-owned key is not an org key",
      ).toEqual(["key_mine"]);
    }),
  );
});

// ---------------------------------------------------------------------------
// Revoking an org key. The mint is only half a credential lifecycle: an org key
// reads every user and connection in the tenant, so it has to be destroyable.
//
// Revoke cannot go through `revokeUserKey`/`revokeApiKey` — that path resolves
// ownership against the CALLER's personal keys, so an org key id is never in
// its owned set. It also cannot just call `deleteApiKey` directly: that route is
// scope-blind and would happily destroy a member's personal key, or a key
// belonging to a sibling org in the same WorkOS workspace. So ownership is
// resolved against the ORG's decoded listing first, and that filter IS the
// authorization. These pin that filter.
// ---------------------------------------------------------------------------

describe("revoking an organization API key", () => {
  const listing = (...keys: ReadonlyArray<unknown>) => ({
    object: "list",
    data: keys,
    listMetadata: { before: null, after: null },
  });

  it.effect("revokes a key the organization owns", () =>
    Effect.gen(function* () {
      const deleted: string[] = [];
      const apiKeys = yield* serviceWith({
        listOrgApiKeys: (organizationId: string) =>
          Effect.succeed(listing(orgKeyResponse(organizationId, "key_org_1", "acme-backend"))),
        deleteApiKey: (id: string) =>
          Effect.sync(() => {
            deleted.push(id);
          }),
      });

      yield* apiKeys.revokeOrgKey({ organizationId: ORG, keyId: "key_org_1" });

      expect(deleted, "the delete reaches WorkOS exactly once, for that key").toEqual([
        "key_org_1",
      ]);
    }),
  );

  it.effect("refuses a USER-owned key id, without deleting anything", () =>
    Effect.gen(function* () {
      // The regression this guards: a member's personal credential must not be
      // destroyable through the org route just because an admin can call it.
      const deleted: string[] = [];
      const apiKeys = yield* serviceWith({
        listOrgApiKeys: () =>
          Effect.succeed(
            listing(orgKeyResponse(ORG, "key_org_1", "acme-backend"), {
              object: "api_key",
              id: "key_user",
              owner: { type: "user", id: "user_1", organization_id: ORG },
              name: "personal",
              obfuscatedValue: "sk_user…c3d4",
              lastUsedAt: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            }),
          ),
        deleteApiKey: (id: string) =>
          Effect.sync(() => {
            deleted.push(id);
          }),
      });

      const error = yield* Effect.flip(
        apiKeys.revokeOrgKey({ organizationId: ORG, keyId: "key_user" }),
      );

      expect(error).toBeInstanceOf(OrgApiKeyNotFound);
      expect(deleted, "no delete is issued for a key the org does not own").toEqual([]);
    }),
  );

  it.effect("refuses a key belonging to ANOTHER organization", () =>
    Effect.gen(function* () {
      // The WorkOS workspace key is workspace-wide, so an admin of one org must
      // not be able to revoke a sibling org's credential by id.
      const deleted: string[] = [];
      const apiKeys = yield* serviceWith({
        listOrgApiKeys: () =>
          Effect.succeed(
            listing(
              orgKeyResponse(ORG, "key_mine", "mine"),
              orgKeyResponse("org_other", "key_theirs", "theirs"),
            ),
          ),
        deleteApiKey: (id: string) =>
          Effect.sync(() => {
            deleted.push(id);
          }),
      });

      const error = yield* Effect.flip(
        apiKeys.revokeOrgKey({ organizationId: ORG, keyId: "key_theirs" }),
      );

      expect(error).toBeInstanceOf(OrgApiKeyNotFound);
      expect(deleted).toEqual([]);
    }),
  );

  it.effect("refuses an unknown key id", () =>
    Effect.gen(function* () {
      const apiKeys = yield* serviceWith({
        listOrgApiKeys: () => Effect.succeed(listing()),
        deleteApiKey: () => Effect.die("nothing should be deleted"),
      });

      const error = yield* Effect.flip(
        apiKeys.revokeOrgKey({ organizationId: ORG, keyId: "key_nope" }),
      );

      expect(error).toBeInstanceOf(OrgApiKeyNotFound);
    }),
  );

  it.effect("surfaces an upstream delete failure as a management error", () =>
    Effect.gen(function* () {
      // A failed delete must not read as a successful revoke — the console
      // would tell an admin a live credential is gone.
      const apiKeys = yield* serviceWith({
        listOrgApiKeys: (organizationId: string) =>
          Effect.succeed(listing(orgKeyResponse(organizationId, "key_org_1", "acme-backend"))),
        deleteApiKey: () => Effect.fail("workos_unavailable"),
      });

      const error = yield* Effect.flip(
        apiKeys.revokeOrgKey({ organizationId: ORG, keyId: "key_org_1" }),
      );

      expect(error).toBeInstanceOf(ApiKeyManagementError);
    }),
  );
});
