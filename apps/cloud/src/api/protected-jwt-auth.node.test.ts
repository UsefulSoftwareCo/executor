import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";

import { ApiKeyService } from "../auth/api-keys";
import { UserStoreService } from "../auth/context";
import type { JwtBearerConfig } from "../auth/workos-auth-provider";
import { WorkOSClient, type WorkOSClientService } from "../auth/workos";
import { resolveProtectedPrincipal } from "./protected";

const createdAt = new Date("2026-01-01T00:00:00.000Z");
const issuer = "https://test-authkit.example.com";
const audience = "client_test_audience";

// A WorkOS access-token JWT verifier backed by a local RS256 key pair (no
// network), plus a signer that mints tokens for it. Mirrors
// `mcp/mcp-auth.node.test.ts`.
const makeJwt = async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key" }] });
  // Device-login tokens are verified by signature alone (client-scoped SSO
  // JWKS); issuer/audience are not pinned.
  const config: JwtBearerConfig = { jwks };
  const sign = (claims: Record<string, unknown>, expiration: string | number = "5m") =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("user_123")
      .setIssuedAt()
      .setExpirationTime(expiration)
      .sign(privateKey);
  return { config, sign };
};

// The api-key path must never run for a JWT bearer, die loudly if it does.
const stubApiKeys = Layer.succeed(ApiKeyService)({
  validate: () => Effect.die("JWT bearer must not hit ApiKeyService.validate"),
  listUserKeys: () => Effect.succeed([]),
  createUserKey: () => Effect.die("JWT auth test does not create API keys"),
  revokeUserKey: () => Effect.void,
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
      return () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`);
    },
  }),
);

const stubUsers = Layer.succeed(UserStoreService)({
  use: (fn) =>
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
      }),
    ),
});

const run = (request: Request, jwt: JwtBearerConfig) =>
  resolveProtectedPrincipal(request, jwt).pipe(
    Effect.provide(Layer.mergeAll(stubApiKeys, stubWorkOS, stubUsers)),
  );

const request = (token: string) =>
  new Request("https://executor.test/api/tools", {
    headers: { authorization: `Bearer ${token}` },
  });

describe("protected JWT (device-login) auth", () => {
  it.effect("resolves a valid WorkOS access token into protected identity", () =>
    Effect.gen(function* () {
      const { config, sign } = yield* Effect.promise(() => makeJwt());
      const token = yield* Effect.promise(() => sign({ org_id: "org_123" }));

      const identity = yield* run(request(token), config);

      expect(identity).toEqual({
        accountId: "user_123",
        organizationId: "org_123",
        organizationName: "Org org_123",
        organizationSlug: "org-slug-org_123",
        email: "",
        name: null,
        avatarUrl: null,
        roles: [],
      });
    }),
  );

  it.effect("rejects an expired access token as Unauthorized", () =>
    Effect.gen(function* () {
      const { config, sign } = yield* Effect.promise(() => makeJwt());
      // Expired one hour ago.
      const token = yield* Effect.promise(() =>
        sign({ org_id: "org_123" }, Math.floor(Date.now() / 1000) - 3600),
      );

      const error = yield* Effect.flip(run(request(token), config));

      expect(error).toMatchObject({
        _tag: "Unauthorized",
        code: "invalid_access_token",
      });
    }),
  );

  it.effect("rejects a token signed by a different key as Unauthorized", () =>
    Effect.gen(function* () {
      const { config } = yield* Effect.promise(() => makeJwt());
      const other = yield* Effect.promise(() => makeJwt());
      const token = yield* Effect.promise(() => other.sign({ org_id: "org_123" }));

      const error = yield* Effect.flip(run(request(token), config));

      expect(error).toMatchObject({ _tag: "Unauthorized", code: "invalid_access_token" });
    }),
  );

  it.effect("rejects a token with no org_id as NoOrganization", () =>
    Effect.gen(function* () {
      const { config, sign } = yield* Effect.promise(() => makeJwt());
      const token = yield* Effect.promise(() => sign({}));

      const error = yield* Effect.flip(run(request(token), config));

      expect(error).toMatchObject({ _tag: "NoOrganization", code: "no_organization" });
    }),
  );

  it.effect("rejects a valid token whose org membership is not active", () =>
    Effect.gen(function* () {
      const { config, sign } = yield* Effect.promise(() => makeJwt());
      // org_999 is not in the membership stub -> not authorized.
      const token = yield* Effect.promise(() => sign({ org_id: "org_999" }));

      const error = yield* Effect.flip(run(request(token), config));

      expect(error).toMatchObject({ _tag: "NoOrganization", code: "no_organization" });
    }),
  );
});
