import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ApiKeyService } from "../auth/api-keys";
import { UserStoreService } from "../auth/context";
import { WorkOSAuth, type WorkOSAuthService } from "../auth/workos";
import { resolveProtectedIdentity } from "./protected";

const createdAt = new Date("2026-01-01T00:00:00.000Z");

const stubApiKeys = Layer.succeed(ApiKeyService)({
  validate: (value: string) =>
    Effect.succeed(
      value === "valid_user_key"
        ? {
            accountId: "user_123",
            organizationId: "org_123",
            keyId: "api_key_123",
          }
        : null,
    ),
  listUserKeys: () => Effect.succeed([]),
  createUserKey: () => Effect.die("protected API auth test does not create API keys"),
  revokeUserKey: () => Effect.void,
});

const stubWorkOS = Layer.succeed(
  WorkOSAuth,
  new Proxy({} as WorkOSAuthService, {
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
      return () => Effect.die(`unexpected WorkOSAuth.${String(prop)} call`);
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
          createdAt,
        }),
        getOrganization: async (id: string) => ({ id, name: `Org ${id}`, createdAt }),
      }),
    ),
});

const run = (request: Request) =>
  resolveProtectedIdentity(request).pipe(
    Effect.provide(Layer.mergeAll(stubApiKeys, stubWorkOS, stubUsers)),
  );

describe("protected API key auth", () => {
  it.effect("resolves a valid bearer API key into protected identity", () =>
    Effect.gen(function* () {
      const identity = yield* run(
        new Request("https://executor.test/api/tools", {
          headers: { authorization: "Bearer valid_user_key" },
        }),
      );

      expect(identity).toEqual({
        accountId: "user_123",
        organizationId: "org_123",
        organizationName: "Org org_123",
        email: "",
        name: null,
        avatarUrl: null,
      });
    }),
  );

  it.effect("rejects invalid bearer API keys", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        run(
          new Request("https://executor.test/api/tools", {
            headers: { authorization: "Bearer invalid_user_key" },
          }),
        ),
      );

      expect(error).toMatchObject({
        status: 401,
        code: "invalid_api_key",
      });
    }),
  );
});
