import { afterAll, describe, expect, it } from "@effect/vitest";
import { Data, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { AuthContext, MemberDirectory, type DirectoryMember } from "@executor-js/api/server";
import { UserStoreService } from "../auth/context";
import { MirrorReadiness, MirrorReadinessState } from "../auth/mirror-readiness";
import { ORG_SELECTOR_HEADER } from "../auth/organization";
import { WorkOSClient, type WorkOSClientService } from "../auth/workos";
import { WorkOsMirror, type WorkOsMirrorShape } from "../auth/workos-mirror";
import { DbService } from "../db/db";
import { AutumnService } from "../extensions/billing/service";
import { OrgHttpApi, Forbidden } from "./api";
import { OrgMemberRole, orgAuthMiddleware } from "./auth-middleware";
import { OrgHandlers, assertDomainInSessionOrg, requireAdmin } from "./handlers";

// ---------------------------------------------------------------------------
// Domain-handler guards. The member / role / invite / org-name endpoints moved
// to the shared WorkOS `AccountProvider` (covered by
// `workos-account-service.test.ts`); this group now serves only the WorkOS
// domain-verification endpoints. These tests pin the two guards those handlers
// share — the REAL `requireAdmin` and `assertDomainInSessionOrg` exported from
// `org/handlers.ts`, so a change to the gate cannot pass on a stale copy — and
// the admin gate's SOURCE: the role `orgAuthMiddleware` resolved for the
// request, so a stale mirror row cannot admit a demoted admin while the mirror
// is not trusted (the readiness rule in `auth/organization.ts`).
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub needs wide function types
type StubFn = (...args: never[]) => Effect.Effect<any, any>;

type StubOverrides = {
  authenticateSealedSession?: StubFn;
  listUserMemberships?: StubFn;
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

const provide = (
  memberRole: "admin" | "member",
  workosOverrides: StubOverrides = {},
): Layer.Layer<AuthContext | OrgMemberRole | WorkOSClient> =>
  Layer.mergeAll(
    Layer.succeed(AuthContext)(adminAuth),
    Layer.succeed(OrgMemberRole)({ memberRole }),
    stubWorkOS(workosOverrides),
  );

describe("Org domain handlers", () => {
  describe("requireAdmin", () => {
    it.effect("passes for an admin caller", () =>
      requireAdmin.pipe(Effect.provide(provide("admin"))),
    );

    it.effect("rejects a non-admin caller with Forbidden", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(requireAdmin);
        expect(error).toBeInstanceOf(Forbidden);
      }).pipe(Effect.provide(provide("member"))),
    );
  });

  describe("assertDomainInSessionOrg", () => {
    it.effect("passes when the domain belongs to the session org", () =>
      assertDomainInSessionOrg("dom_1").pipe(
        Effect.provide(
          provide("admin", {
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
          provide("admin", {
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
          provide("admin", {
            getOrganizationDomain: () => Effect.fail(new UnstubbedWorkOSMethod({ method: "boom" })),
          }),
        ),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// The admin gate over HTTP, through `orgAuthMiddleware`: the role the gate
// sees is the one the middleware resolved through `authorizeOrganizationSelector`
// — the mirror while it is ready, WorkOS otherwise. The mirror row below is
// STALE: it still says `admin` for a caller WorkOS has demoted to `member`.
// While the mirror is not trusted (the reconciler is behind), WorkOS's answer
// must decide, and the delete must be refused.
// ---------------------------------------------------------------------------

const ORG = "org_1";
const CALLER = "user_caller";
const DOMAIN = "dom_1";
const createdAt = new Date("2026-01-01T00:00:00.000Z");

// The mirror's row for the caller: an active admin — stale once WorkOS has
// demoted them and the reconciler has not landed the change yet.
const staleAdminRow: DirectoryMember = {
  accountId: CALLER,
  membershipId: `om_${CALLER}_${ORG}`,
  organizationId: ORG,
  email: null,
  name: null,
  avatarUrl: null,
  role: "admin",
  status: "active",
  lastActiveAt: null,
};

const unread = (why: string) => () => Effect.die(why);
const stubDirectory = Layer.succeed(MemberDirectory)({
  membership: (accountId, organizationId) =>
    Effect.succeed(accountId === CALLER && organizationId === ORG ? staleAdminRow : null),
  membershipById: unread("the org plane does not look up by membership id"),
  membershipsOf: unread("the org plane reads one membership, not the list"),
  members: unread("the org plane does not list members"),
  membersById: unread("the org plane does not batch members"),
  findByEmail: unread("the org plane does not resolve emails"),
});

const readiness = (state: MirrorReadinessState) =>
  Layer.succeed(MirrorReadiness)({ state: () => Effect.succeed(state) });

const organizationRow = (id: string) => ({
  id,
  name: `Org ${id}`,
  slug: id,
  backfilledAt: createdAt,
  deletedAt: null,
  workosUpdatedAt: null,
  createdAt,
});

// The store's operations are plain promises: an unexpected one defects
// through `Effect.promise`, the same way `unread` does for the services.
const unreadStore = (why: string) => () => Effect.runPromise(Effect.die(why));
const stubUsers = Layer.succeed(UserStoreService)({
  use: (_op, fn) =>
    Effect.promise(() =>
      fn({
        ensureAccount: unreadStore("the org plane does not mint accounts"),
        getAccount: unreadStore("the org plane does not read accounts"),
        upsertOrganization: unreadStore("the org plane does not mirror organizations"),
        getOrganization: async (id: string) => organizationRow(id),
        getOrganizationBySlug: unreadStore("the selector below is an org id, not a slug"),
        markOrganizationDeleted: unreadStore("the org plane does not delete organizations"),
        deleteOrganizationCascade: unreadStore("the org plane does not delete organizations"),
      }),
    ),
});

// Authorization scans an organization the backfill never covered before it
// reads the mirror (`auth/organization.ts`); every org row above is marked
// backfilled, so the scan is never reached and the mirror is never written.
const stubMirror = Layer.succeed(
  WorkOsMirror,
  new Proxy({} as WorkOsMirrorShape, {
    get: (_target, prop) => () => Effect.die(`unexpected WorkOsMirror.${String(prop)} call`),
  }),
);

// The handlers never reach the database here: the directory and the store are
// stubbed above, so the request-scoped `DbService` is a placeholder.
const stubDb = Layer.succeed(DbService)({ db: {} as never });

const stubAutumn = Layer.succeed(AutumnService)({
  use: unread("the delete does not consult billing"),
  ensureCustomer: unread("the delete does not provision billing"),
  checkExecutionBalance: unread("the delete does not check balances"),
  trackExecution: unread("the delete does not track usage"),
  setMemberSeats: unread("the delete does not count seats"),
});

// WorkOS as the org plane sees it: the caller's session, their CURRENT
// membership list (demoted to member), and the domain to delete.
const workosWithCallerAs = (role: "admin" | "member", deleted: string[]) =>
  stubWorkOS({
    authenticateSealedSession: () =>
      Effect.succeed({ userId: CALLER, email: "caller@placeholder.test", organizationId: ORG }),
    listUserMemberships: () =>
      Effect.succeed({
        data: [
          {
            id: staleAdminRow.membershipId,
            organizationId: ORG,
            status: "active",
            role: { slug: role },
          },
        ],
      }),
    getOrganizationDomain: () =>
      Effect.succeed({ id: DOMAIN, organizationId: ORG, domain: "acme.test" }),
    deleteOrganizationDomain: (domainId: string) =>
      Effect.sync(() => {
        deleted.push(domainId);
      }),
  });

const orgApp = (state: MirrorReadinessState, workos: Layer.Layer<WorkOSClient>) => {
  const rsLive = Layer.mergeAll(stubDb, stubUsers, stubDirectory, stubMirror, readiness(state));
  const App = HttpApiBuilder.layer(OrgHttpApi).pipe(
    Layer.provide(OrgHandlers),
    Layer.provide(orgAuthMiddleware(rsLive)),
    Layer.provide(workos),
    Layer.provide(stubAutumn),
    Layer.provide(HttpServer.layerServices),
  );
  return HttpRouter.toWebHandler(App, { disableLogger: true });
};

const apps: { dispose: () => Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(apps.map((app) => app.dispose()));
});

const deleteDomain = async (state: MirrorReadinessState, role: "admin" | "member") => {
  const deleted: string[] = [];
  const app = orgApp(state, workosWithCallerAs(role, deleted));
  apps.push(app);
  const response = await app.handler(
    new Request(`https://executor.test/org/domains/${DOMAIN}`, {
      method: "DELETE",
      headers: { cookie: "wos-session=sealed", [ORG_SELECTOR_HEADER]: ORG },
    }),
    // beta.59: the handler type expects a context argument; this layer stack
    // needs none at runtime — pass undefined like the api.request-scope tests.
    undefined as never,
  );
  return { status: response.status, deleted };
};

describe("Org domain handlers over HTTP: the admin gate is the authorized role", () => {
  it("lets a mirrored admin delete a domain while the mirror is ready", async () => {
    const { status, deleted } = await deleteDomain(MirrorReadinessState.Ready(), "member");
    // WorkOS is not consulted for membership while the mirror is ready: the
    // mirror row (admin) decides, and the demotion lands through the
    // reconciler within its lag budget.
    expect(status).toBe(200);
    expect(deleted).toEqual([DOMAIN]);
  });

  it("refuses a demoted admin while the mirror is not ready, however stale the mirror row is", async () => {
    const { status, deleted } = await deleteDomain(
      MirrorReadinessState.ReconcilerStale({ drainedAt: null }),
      "member",
    );
    expect(status, "WorkOS says member; the stale admin row does not grant the delete").toBe(403);
    expect(deleted).toEqual([]);
  });

  it("lets an admin WorkOS confirms delete a domain while the mirror is not ready", async () => {
    const { status, deleted } = await deleteDomain(
      MirrorReadinessState.ReconcilerStale({ drainedAt: null }),
      "admin",
    );
    expect(status).toBe(200);
    expect(deleted).toEqual([DOMAIN]);
  });
});
