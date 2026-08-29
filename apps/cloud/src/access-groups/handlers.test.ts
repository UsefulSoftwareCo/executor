import { describe, it, expect } from "@effect/vitest";
import { Data, Effect, Layer, Predicate } from "effect";

import { AuthContext } from "@executor-js/api/server";
import { AccessGroupsForbidden } from "@executor-js/api";
import { WorkOSClient, type WorkOSClientService } from "../auth/workos";

// ---------------------------------------------------------------------------
// Access-groups handler guard. Every endpoint in the group runs behind the
// same WorkOS admin-role gate as the org domains plane; these tests pin that
// guard (mirroring `access-groups/handlers.ts`, the same convention as
// `org/handlers.test.ts`): a plain member, a platform credential (null
// accountId), and a missing membership are all refused. The full HTTP-level
// gate is exercised end-to-end on the self-host plane
// (`apps/host-selfhost/src/admin/access-groups.node.test.ts`), which shares
// the engine; enforcement semantics live in the sdk's
// access-group-enforcement.test.ts.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub needs wide function types
type StubFn = (...args: never[]) => Effect.Effect<any, any>;

type StubOverrides = {
  getUserOrgMembership?: StubFn;
};

class UnstubbedWorkOSMethod extends Data.TaggedError("UnstubbedWorkOSMethod")<{
  method: string;
}> {}

const stubWorkOS = (overrides: StubOverrides = {}) =>
  Layer.succeed(
    WorkOSClient,
    new Proxy({} as WorkOSClientService, {
      get: (_target, prop) => {
        if (typeof prop === "string" && prop in overrides) {
          return overrides[prop as keyof StubOverrides];
        }
        return () =>
          Effect.fail(
            new UnstubbedWorkOSMethod({
              method: typeof prop === "string" ? prop : (prop.description ?? "symbol"),
            }),
          );
      },
    }),
  );

const adminAuth = {
  accountId: "user_admin",
  organizationId: "org_1",
  email: "admin@test.com",
  name: "Admin",
  avatarUrl: null,
  roles: [],
};

const memberAuth = { ...adminAuth, accountId: "user_member" };
const platformAuth = { ...adminAuth, accountId: null };

const provide = (auth: typeof adminAuth | typeof platformAuth, overrides: StubOverrides = {}) =>
  Layer.mergeAll(Layer.succeed(AuthContext)(auth), stubWorkOS(overrides));

// Mirrors `access-groups/handlers.ts` `requireAdmin`.
const requireAdmin = Effect.gen(function* () {
  const auth = yield* AuthContext;
  if (auth.accountId === null) return yield* new AccessGroupsForbidden();
  const workos = yield* WorkOSClient;
  const membership = yield* workos.getUserOrgMembership(auth.organizationId, auth.accountId);
  if (!membership || membership.role?.slug !== "admin") {
    return yield* new AccessGroupsForbidden();
  }
  return { accountId: auth.accountId, organizationId: auth.organizationId };
});

const withMemberships: StubOverrides = {
  getUserOrgMembership: (_organizationId: string, userId: string) =>
    Effect.succeed(
      userId === "user_admin"
        ? { id: "mem_admin", userId, status: "active", role: { slug: "admin" } }
        : { id: "mem_member", userId, status: "active", role: { slug: "member" } },
    ),
};

describe("access-groups requireAdmin", () => {
  it.effect("passes for an admin caller and returns the binding", () =>
    Effect.gen(function* () {
      const binding = yield* requireAdmin;
      expect(binding).toEqual({ accountId: "user_admin", organizationId: "org_1" });
    }).pipe(Effect.provide(provide(adminAuth, withMemberships))),
  );

  it.effect("rejects a plain member with Forbidden", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(requireAdmin);
      expect(Predicate.isTagged("AccessGroupsForbidden")(error)).toBe(true);
    }).pipe(Effect.provide(provide(memberAuth, withMemberships))),
  );

  it.effect("rejects the platform credential (no acting member) with Forbidden", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(requireAdmin);
      expect(Predicate.isTagged("AccessGroupsForbidden")(error)).toBe(true);
    }).pipe(Effect.provide(provide(platformAuth))),
  );

  it.effect("rejects a caller with no membership at all", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(requireAdmin);
      expect(Predicate.isTagged("AccessGroupsForbidden")(error)).toBe(true);
    }).pipe(
      Effect.provide(provide(memberAuth, { getUserOrgMembership: () => Effect.succeed(null) })),
    ),
  );
});
