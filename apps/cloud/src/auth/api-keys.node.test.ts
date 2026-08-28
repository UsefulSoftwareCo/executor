import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ApiKeyService } from "./api-keys";
import { WorkOSClient, type WorkOSClientService } from "./workos";

const stubWorkOS = (overrides: Partial<WorkOSClientService>) =>
  Layer.succeed(
    WorkOSClient,
    new Proxy({} as WorkOSClientService, {
      get: (_target, prop) => {
        if (prop in overrides) return overrides[prop as keyof WorkOSClientService];
        return () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`);
      },
    }),
  );

const validate = (response: unknown) =>
  Effect.gen(function* () {
    const apiKeys = yield* ApiKeyService;
    return yield* apiKeys.validate("test_key");
  }).pipe(
    Effect.provide(
      ApiKeyService.WorkOS.pipe(
        Layer.provide(stubWorkOS({ validateApiKey: () => Effect.succeed(response) })),
      ),
    ),
  );

describe("ApiKeyService.WorkOS", () => {
  it.effect("accepts user-owned keys with camel-case organization id", () =>
    Effect.gen(function* () {
      const principal = yield* validate({
        apiKey: {
          id: "api_key_123",
          owner: {
            type: "user",
            id: "user_123",
            organizationId: "org_123",
          },
        },
      });

      expect(principal).toEqual({
        scope: "user",
        accountId: "user_123",
        organizationId: "org_123",
        keyId: "api_key_123",
      });
    }),
  );

  it.effect("accepts user-owned keys with snake-case organization id", () =>
    Effect.gen(function* () {
      const principal = yield* validate({
        apiKey: {
          id: "api_key_456",
          owner: {
            type: "user",
            id: "user_456",
            organization_id: "org_456",
          },
        },
      });

      expect(principal?.organizationId).toBe("org_456");
    }),
  );

  it.effect("rejects missing and org-less keys", () =>
    Effect.gen(function* () {
      const missing = yield* validate({ apiKey: null });
      const orgLess = yield* validate({
        apiKey: {
          id: "api_key_no_org",
          owner: { type: "user", id: "user_123" },
        },
      });

      expect(missing).toBeNull();
      expect(orgLess).toBeNull();
    }),
  );

  it.effect("resolves organization-owned keys to the org scope with no account", () =>
    Effect.gen(function* () {
      // An org key USED to fail the decode and come back null — indistinguishable
      // from an invalid key. It now resolves explicitly: `owner.id` IS the
      // organization, and there is no member behind it.
      const principal = yield* validate({
        apiKey: {
          id: "api_key_org",
          owner: { type: "organization", id: "org_123" },
        },
      });

      expect(principal).toEqual({
        scope: "org",
        accountId: null,
        organizationId: "org_123",
        keyId: "api_key_org",
      });
    }),
  );

  it.effect("lists and creates user-owned keys", () =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const apiKeys = yield* ApiKeyService;
        const listed = yield* apiKeys.listUserKeys({
          accountId: "user_123",
          organizationId: "org_123",
        });
        const created = yield* apiKeys.createUserKey({
          accountId: "user_123",
          organizationId: "org_123",
          name: "Local CLI",
        });
        return { listed, created };
      }).pipe(
        Effect.provide(
          ApiKeyService.WorkOS.pipe(
            Layer.provide(
              stubWorkOS({
                listUserApiKeys: () =>
                  Effect.succeed({
                    object: "list" as const,
                    data: [
                      {
                        id: "api_key_listed",
                        name: "Listed",
                        obfuscated_value: "sk_...1234",
                        created_at: "2026-01-01T00:00:00.000Z",
                        updated_at: "2026-01-01T00:00:00.000Z",
                        last_used_at: null,
                        owner: {
                          type: "user",
                          id: "user_123",
                          organization_id: "org_123",
                        },
                      },
                    ],
                    listMetadata: {
                      before: null,
                      after: null,
                    },
                  }),
                createUserApiKey: () =>
                  Effect.succeed({
                    id: "api_key_created",
                    name: "Local CLI",
                    value: "sk_created",
                    obfuscated_value: "sk_...ated",
                    created_at: "2026-01-01T00:00:00.000Z",
                    updated_at: "2026-01-01T00:00:00.000Z",
                    last_used_at: null,
                    owner: {
                      type: "user",
                      id: "user_123",
                      organization_id: "org_123",
                    },
                  }),
              }),
            ),
          ),
        ),
      );

      const result = yield* program;
      expect(result.listed).toEqual([
        {
          id: "api_key_listed",
          name: "Listed",
          obfuscatedValue: "sk_...1234",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          lastUsedAt: null,
        },
      ]);
      expect(result.created.value).toBe("sk_created");
    }),
  );
});
