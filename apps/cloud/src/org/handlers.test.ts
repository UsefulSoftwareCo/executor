import { describe, it, expect } from "@effect/vitest";
import { Data, Effect, Layer } from "effect";

import { AuthContext } from "@executor-js/api/server";
import { WorkOSClient, type WorkOSClientService } from "../auth/workos";
import { Forbidden } from "./api";

// ---------------------------------------------------------------------------
// Domain-handler guards. The member / role / invite / org-name endpoints moved
// to the shared WorkOS `AccountProvider` (covered by
// `workos-account-service.test.ts`); this group now serves only the WorkOS
// domain-verification endpoints. These tests pin the two guards those handlers
// share — `requireAdmin` and `assertDomainInSessionOrg` — which mirror
// `org/handlers.ts`.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub needs wide function types
type StubFn = (...args: never[]) => Effect.Effect<any, any>;

type StubOverrides = {
  getUserOrgMembership?: StubFn;
  getOrganizationDomain?: StubFn;
  getOrganization?: StubFn;
  deleteOrganizationDomain?: StubFn;
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

const memberAuth = {
  accountId: "user_member",
  organizationId: "org_1",
  email: "member@test.com",
  name: "Member",
  avatarUrl: null,
  roles: [],
};

const provide = (auth: typeof adminAuth, workosOverrides: StubOverrides = {}) =>
  Layer.mergeAll(Layer.succeed(AuthContext)(auth), stubWorkOS(workosOverrides));

// Mirrors `org/handlers.ts` `requireAdmin`.
const requireAdmin = Effect.gen(function* () {
  const auth = yield* AuthContext;
  const workos = yield* WorkOSClient;
  const current = yield* workos.getUserOrgMembership(auth.organizationId, auth.accountId);
  if (!current || current.role?.slug !== "admin") {
    return yield* new Forbidden();
  }
});

const withCurrentMembership: StubOverrides = {
  getUserOrgMembership: (_organizationId: string, userId: string) =>
    Effect.succeed(
      userId === "user_admin"
        ? { id: "mem_admin", userId, status: "active", role: { slug: "admin" } }
        : { id: "mem_member", userId, status: "active", role: { slug: "member" } },
    ),
};

// Mirrors `org/handlers.ts` `assertDomainInSessionOrg`.
const assertDomainInSessionOrg = (domainId: string) =>
  Effect.gen(function* () {
    const auth = yield* AuthContext;
    const workos = yield* WorkOSClient;
    const domain = yield* workos
      .getOrganizationDomain(domainId)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (!domain || domain.organizationId !== auth.organizationId) {
      return yield* new Forbidden();
    }
  });

describe("Org domain handlers", () => {
  describe("requireAdmin", () => {
    it.effect("passes for an admin caller", () =>
      requireAdmin.pipe(Effect.provide(provide(adminAuth, withCurrentMembership))),
    );

    it.effect("rejects a non-admin caller with Forbidden", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(requireAdmin);
        expect(error).toBeInstanceOf(Forbidden);
      }).pipe(Effect.provide(provide(memberAuth, withCurrentMembership))),
    );
  });

  describe("assertDomainInSessionOrg", () => {
    it.effect("passes when the domain belongs to the session org", () =>
      assertDomainInSessionOrg("dom_1").pipe(
        Effect.provide(
          provide(adminAuth, {
            getOrganizationDomain: () =>
              Effect.succeed({ id: "dom_1", organizationId: "org_1", domain: "acme.test" }),
          }),
        ),
      ),
    );

    it.effect("rejects a domain owned by a different org with Forbidden", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(assertDomainInSessionOrg("dom_other"));
        expect(error).toBeInstanceOf(Forbidden);
      }).pipe(
        Effect.provide(
          provide(adminAuth, {
            getOrganizationDomain: () =>
              Effect.succeed({ id: "dom_other", organizationId: "org_2", domain: "evil.test" }),
          }),
        ),
      ),
    );

    it.effect("rejects (Forbidden) when the domain lookup fails — never leaks existence", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(assertDomainInSessionOrg("dom_missing"));
        expect(error).toBeInstanceOf(Forbidden);
      }).pipe(
        Effect.provide(
          provide(adminAuth, {
            getOrganizationDomain: () => Effect.fail(new UnstubbedWorkOSMethod({ method: "boom" })),
          }),
        ),
      ),
    );
  });
});
