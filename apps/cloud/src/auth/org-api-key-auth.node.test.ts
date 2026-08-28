import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ApiKeyService } from "./api-keys";
import { UserStoreService } from "./context";
import { WorkOSClient, type WorkOSClientService } from "./workos";
import { isPlatformAuth, resolveApiKeyPrincipal, resolveBearerAuth } from "./workos-auth-provider";

// Groundwork for the PRIVILEGED, org-level API key: it resolves to the platform
// view (tenant-wide, read-only, NO acting member) rather than to a member
// `Principal`. The product surfaces must reject it outright rather than
// inventing a subject for it — that is the property these tests pin.

const createdAt = new Date("2026-01-01T00:00:00.000Z");

const stubApiKeys = Layer.succeed(ApiKeyService)({
  validate: (value: string) => {
    if (value === "valid_org_key") {
      return Effect.succeed({
        scope: "org" as const,
        accountId: null,
        organizationId: "org_123",
        keyId: "api_key_org",
      });
    }
    if (value === "valid_user_key") {
      return Effect.succeed({
        scope: "user" as const,
        accountId: "user_123",
        organizationId: "org_123",
        keyId: "api_key_123",
      });
    }
    return Effect.succeed(null);
  },
  listUserKeys: () => Effect.succeed([]),
  createUserKey: () => Effect.die("org api key test does not create API keys"),
  revokeUserKey: () => Effect.void,
  listOrgKeys: () => Effect.die("auth resolution test does not list org API keys"),
  createOrgKey: () => Effect.die("auth resolution test does not create org API keys"),
  revokeOrgKey: () => Effect.die("auth resolution test does not revoke org API keys"),
});

const stubWorkOS = Layer.succeed(
  WorkOSClient,
  new Proxy({} as WorkOSClientService, {
    get: (_target, prop) => {
      if (prop === "listUserMemberships") {
        return (userId: string) =>
          Effect.succeed({
            data:
              userId === "user_123"
                ? [{ userId, organizationId: "org_123", status: "active" }]
                : [],
          });
      }
      // An org key must NOT trigger a membership check — there is no user to
      // check. Any such call dies here, which is the assertion.
      return () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`);
    },
  }),
);

const stubUsers = Layer.succeed(UserStoreService)({
  use: (_op, fn) =>
    Effect.promise(() =>
      fn({
        ensureAccount: async (id: string) => ({ id, createdAt }),
        getAccount: async (id: string) => ({ id, createdAt }),
        upsertOrganization: async (org: { id: string; name: string }) => ({
          ...org,
          slug: `org-slug-${org.id}`,
          createdAt,
        }),
        getOrganization: async (id: string) => ({
          id,
          name: `Org ${id}`,
          slug: `org-slug-${id}`,
          createdAt,
        }),
        getOrganizationBySlug: async (slug: string) => ({
          id: "org_by_slug",
          name: `Org ${slug}`,
          slug,
          createdAt,
        }),
        deleteOrganizationCascade: async () => {},
      }),
    ),
});

const layers = Layer.mergeAll(stubApiKeys, stubWorkOS, stubUsers);

const bearer = (token: string) =>
  new Request("https://executor.test/api/tools", {
    headers: { authorization: `Bearer ${token}` },
  });

describe("org-level API keys", () => {
  it.effect("resolve to the platform view with no acting member", () =>
    Effect.gen(function* () {
      const auth = yield* resolveBearerAuth(bearer("valid_org_key")).pipe(Effect.provide(layers));

      expect(isPlatformAuth(auth)).toBe(true);
      expect(auth).toEqual({
        kind: "platform",
        organizationId: "org_123",
        organizationName: "Org org_123",
        organizationSlug: "org-slug-org_123",
        keyId: "api_key_org",
      });
      // No `accountId` anywhere in the shape: nothing downstream can bind a
      // subject from it by accident.
      expect(auth).not.toHaveProperty("accountId");
    }),
  );

  it.effect("user keys still resolve to a bound member principal", () =>
    Effect.gen(function* () {
      const auth = yield* resolveBearerAuth(bearer("valid_user_key")).pipe(Effect.provide(layers));

      expect(isPlatformAuth(auth)).toBe(false);
      expect(auth).toMatchObject({ accountId: "user_123", organizationId: "org_123" });
    }),
  );

  it.effect("resolve on the product surface as a platform principal, never a subject", () =>
    Effect.gen(function* () {
      // THE security property of the api-key half, updated for platform reads:
      // a product request carrying an org key resolves to the NEUTRAL platform
      // shape — which the shared middleware routes to the subject-less,
      // GET-only platform executor — and must never carry an accountId a
      // handler could bind as an acting member.
      const principal = yield* resolveApiKeyPrincipal(bearer("valid_org_key")).pipe(
        Effect.provide(layers),
      );

      expect(principal).toEqual({
        kind: "platform",
        organizationId: "org_123",
        organizationName: "Org org_123",
        organizationSlug: "org-slug-org_123",
        keyId: "api_key_org",
      });
      expect(principal).not.toHaveProperty("accountId");
    }),
  );

  it.effect("do not trigger a user membership check", () =>
    Effect.gen(function* () {
      // `authorizeOrganization` checks a USER's live membership; there is no
      // user here. The WorkOS stub dies on any call other than the user path,
      // so a clean resolution proves the org branch never took it.
      const auth = yield* resolveBearerAuth(bearer("valid_org_key")).pipe(Effect.provide(layers));

      expect(isPlatformAuth(auth)).toBe(true);
    }),
  );
});
