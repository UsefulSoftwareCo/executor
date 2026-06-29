import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { UserStoreService } from "../../auth/context";
import { WorkOSClient, type WorkOSClientService } from "../../auth/workos";
import { resolveBillingOrganization } from "./route";

const createdAt = new Date("2026-01-01T00:00:00.000Z");

const MEMBER = "user_session";
const SESSION_ORG = "org_session";
const URL_ORG = "org_url";
const URL_SLUG = "acme";

const stubWorkOS = Layer.succeed(
  WorkOSClient,
  new Proxy({} as WorkOSClientService, {
    get: (_target, prop) => {
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
        upsertOrganization: async (org: { id: string; name: string }) => ({
          ...org,
          slug: org.id,
          createdAt,
        }),
        getOrganization: async (id: string) => ({ id, name: `Org ${id}`, slug: id, createdAt }),
        getOrganizationBySlug: async (slug: string) => ({
          id: slug === URL_SLUG ? URL_ORG : "org_outsider",
          name: `Org ${slug}`,
          slug,
          createdAt,
        }),
      }),
    ),
});

const run = (headers: Record<string, string>, organizationId: string | null = SESSION_ORG) =>
  resolveBillingOrganization(
    new Request("https://executor.test/api/billing/customer", { headers }),
    { userId: MEMBER, organizationId },
  ).pipe(Effect.provide(Layer.mergeAll(stubWorkOS, stubUsers)));

describe("billing route org selector", () => {
  it.effect("falls back to the session org when no selector header is sent", () =>
    Effect.gen(function* () {
      const org = yield* run({});
      expect(org.id).toBe(SESSION_ORG);
    }),
  );

  it.effect("scopes billing to the URL org selector over the session org", () =>
    Effect.gen(function* () {
      const org = yield* run({ "x-executor-organization": URL_SLUG });
      expect(org.id).toBe(URL_ORG);
    }),
  );

  it.effect("rejects a selector for an org the caller is not a member of", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(run({ "x-executor-organization": "outsider-slug" }));
      expect(error).toMatchObject({ _tag: "HttpResponseError", status: 403 });
    }),
  );

  it.effect("requires either a selector header or a session org", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(run({}, null));
      expect(error).toMatchObject({ _tag: "HttpResponseError", status: 401 });
    }),
  );
});
