import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ApiKeyService } from "./api-keys";
import { UserStoreService } from "./context";
import { resolveSessionPrincipal } from "./workos-auth-provider";
import { WorkOSClient, type WorkOSClientService } from "./workos";

// The org a console request resolves to is the URL's org (sent in the
// `x-executor-organization` selector header), not the session's stored org —
// with the session org as the fallback for non-console callers, and live
// membership re-checked either way. This is what makes two browser tabs on
// different orgs independent.

const createdAt = new Date("2026-01-01T00:00:00.000Z");

// user_session belongs to BOTH orgs; the URL selects which one a request hits.
const MEMBER = "user_session";
const SESSION_ORG = "org_session";
const URL_ORG = "org_url";
const URL_SLUG = "acme";

const stubApiKeys = Layer.succeed(ApiKeyService)({
  // No Authorization header in these tests → the api-key path returns null and
  // resolution falls through to the session path.
  validate: () => Effect.succeed(null),
  listUserKeys: () => Effect.succeed([]),
  createUserKey: () => Effect.die("not used"),
  revokeUserKey: () => Effect.void,
});

const stubWorkOS = Layer.succeed(
  WorkOSClient,
  new Proxy({} as WorkOSClientService, {
    get: (_t, prop) => {
      if (prop === "authenticateRequest") {
        return () =>
          Effect.succeed({ userId: MEMBER, email: "u@e2e.test", organizationId: SESSION_ORG });
      }
      if (prop === "listUserMemberships") {
        return (userId: string) =>
          Effect.succeed({
            data:
              userId === MEMBER
                ? [
                    { userId, organizationId: SESSION_ORG, status: "active" },
                    { userId, organizationId: URL_ORG, status: "active" },
                  ]
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
        // Slug is minted at insert now — the stub returns a slugged row.
        upsertOrganization: async (org: { id: string; name: string }) => ({
          ...org,
          slug: org.id,
          createdAt,
        }),
        getOrganization: async (id: string) => ({ id, name: `Org ${id}`, slug: id, createdAt }),
        // The URL slug maps to URL_ORG (the member's other org); any other slug
        // maps to an org the caller is NOT a member of, so membership rejects it.
        getOrganizationBySlug: async (slug: string) => ({
          id: slug === URL_SLUG ? URL_ORG : "org_outsider",
          name: `Org ${slug}`,
          slug,
          createdAt,
        }),
      }),
    ),
});

const run = (headers: Record<string, string>) =>
  resolveSessionPrincipal(new Request("https://executor.test/api/tools", { headers })).pipe(
    Effect.provide(Layer.mergeAll(stubApiKeys, stubWorkOS, stubUsers)),
  );

describe("resolveSessionPrincipal · URL org selector", () => {
  it.effect("falls back to the session org when no selector header is sent", () =>
    Effect.gen(function* () {
      const principal = yield* run({ cookie: "wos-session=x" });
      expect(principal.organizationId, "scopes to the session org").toBe(SESSION_ORG);
    }),
  );

  it.effect("scopes to the URL org (by slug) over the session org", () =>
    Effect.gen(function* () {
      const principal = yield* run({
        cookie: "wos-session=x",
        "x-executor-organization": URL_SLUG,
      });
      expect(principal.organizationId, "the slug header wins over the session org").toBe(URL_ORG);
    }),
  );

  it.effect("accepts a WorkOS org id as the selector too", () =>
    Effect.gen(function* () {
      const principal = yield* run({
        cookie: "wos-session=x",
        "x-executor-organization": URL_ORG,
      });
      expect(principal.organizationId).toBe(URL_ORG);
    }),
  );

  it.effect("rejects a selector for an org the caller is not a member of", () =>
    Effect.gen(function* () {
      // The slug resolves to a real org id, but membership is re-checked — a
      // slug is a selector, not a trust boundary, so a non-member is rejected.
      const error = yield* Effect.flip(
        run({ cookie: "wos-session=x", "x-executor-organization": "outsider-slug" }),
      );
      expect(error).toMatchObject({ _tag: "NoOrganization" });
    }),
  );
});
