import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { MemberDirectory, type DirectoryMember } from "@executor-js/api/server";

import { ApiKeyService } from "./api-keys";
import { UserStoreService } from "./context";
import { MirrorReadiness, MirrorReadinessState } from "./mirror-readiness";
import { resolveSessionPrincipal } from "./workos-auth-provider";
import { WorkOSClient, type WorkOSClientService } from "./workos";
import { WorkOsMirror, type WorkOsMirrorShape } from "./workos-mirror";

// The org a console request resolves to is the URL's org (sent in the
// `x-executor-organization` selector header) — NEVER the session's stored org.
// The sealed cookie's org is a browser-global pinned to whichever org WorkOS
// last touched, so a fallback to it silently scopes a multi-org user's request
// to the wrong org; a header-less request fails closed instead. Membership is
// re-checked against the local mirror either way. This is what makes two
// browser tabs on different orgs independent.

const createdAt = new Date("2026-01-01T00:00:00.000Z");

// The mirror's account row as `ensureAccount` mints it: id only, profile
// columns unfilled until a WorkOS user payload arrives.
const bareAccount = (id: string) => ({
  id,
  email: null,
  firstName: null,
  lastName: null,
  avatarUrl: null,
  workosUpdatedAt: null,
  lastSignInAt: null,
  createdAt,
});

// user_session belongs to BOTH orgs; the URL selects which one a request hits.
// Their membership in PENDING_ORG is only pending — an invite, not access.
const MEMBER = "user_session";
const SESSION_ORG = "org_session";
const URL_ORG = "org_url";
const PENDING_ORG = "org_pending";
const URL_SLUG = "acme";
const PENDING_SLUG = "pending-acme";

const mirrored = (
  organizationId: string,
  overrides: Partial<DirectoryMember> = {},
): DirectoryMember => ({
  accountId: MEMBER,
  membershipId: `om_${MEMBER}_${organizationId}`,
  organizationId,
  email: null,
  name: null,
  avatarUrl: null,
  role: "member",
  status: "active",
  lastActiveAt: null,
  ...overrides,
});

// The mirror as the directory reads it: MEMBER is active in both real orgs,
// an admin of URL_ORG, and merely invited to PENDING_ORG.
const memberships = new Map<string, DirectoryMember>([
  [SESSION_ORG, mirrored(SESSION_ORG)],
  [URL_ORG, mirrored(URL_ORG, { role: "admin" })],
  [PENDING_ORG, mirrored(PENDING_ORG, { status: "pending" })],
]);

// The mirror is READY in these tests (backfill complete, reconciler caught
// up), so membership is read from the stubbed directory, never from WorkOS.
const stubReadiness = Layer.succeed(MirrorReadiness)({
  state: () => Effect.succeed(MirrorReadinessState.Ready()),
});

const stubDirectory = Layer.succeed(MemberDirectory)({
  membership: (accountId, organizationId) =>
    Effect.succeed(accountId === MEMBER ? (memberships.get(organizationId) ?? null) : null),
  membershipById: () => Effect.die("session resolution does not look up by membership id"),
  membershipsOf: () => Effect.die("session resolution reads one membership, not the list"),
  members: () => Effect.die("session resolution does not list members"),
  membersById: () => Effect.die("session resolution does not batch members"),
  findByEmail: () => Effect.die("session resolution does not resolve emails"),
});

const stubApiKeys = Layer.succeed(ApiKeyService)({
  // No Authorization header in these tests → the api-key path returns null and
  // resolution falls through to the session path.
  validate: () => Effect.succeed(null),
  listUserKeys: () => Effect.succeed([]),
  createUserKey: () => Effect.die("not used"),
  revokeUserKey: () => Effect.void,
  listOrgKeys: () => Effect.die("auth resolution test does not list org API keys"),
  createOrgKey: () => Effect.die("auth resolution test does not create org API keys"),
  revokeOrgKey: () => Effect.die("auth resolution test does not revoke org API keys"),
});

const stubWorkOS = Layer.succeed(
  WorkOSClient,
  new Proxy({} as WorkOSClientService, {
    get: (_t, prop) => {
      if (prop === "authenticateRequest") {
        return () =>
          Effect.succeed({
            userId: MEMBER,
            email: "u@e2e.test",
            organizationId: SESSION_ORG,
          });
      }
      // Membership is read from the mirror, never from WorkOS: any WorkOS
      // call past session authentication fails the test.
      return () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`);
    },
  }),
);

const stubUsers = Layer.succeed(UserStoreService)({
  use: (_op, fn) =>
    Effect.promise(() =>
      fn({
        ensureAccount: async (id: string) => bareAccount(id),
        getAccount: async (id: string) => bareAccount(id),
        // Slug is minted at insert now — the stub returns a slugged row.
        upsertOrganization: async (org: { id: string; name: string }) => ({
          ...org,
          slug: org.id,
          backfilledAt: createdAt,
          deletedAt: null,
          workosUpdatedAt: null,
          createdAt,
        }),
        getOrganization: async (id: string) => ({
          id,
          name: `Org ${id}`,
          slug: id,
          backfilledAt: createdAt,
          deletedAt: null,
          workosUpdatedAt: null,
          createdAt,
        }),
        // The URL slug maps to URL_ORG (the member's other org), the pending
        // slug to the org they are only invited to; any other slug maps to an
        // org the caller is NOT a member of, so membership rejects it.
        getOrganizationBySlug: async (slug: string) => ({
          id: slug === URL_SLUG ? URL_ORG : slug === PENDING_SLUG ? PENDING_ORG : "org_outsider",
          name: `Org ${slug}`,
          slug,
          backfilledAt: createdAt,
          deletedAt: null,
          workosUpdatedAt: null,
          createdAt,
        }),
        markOrganizationDeleted: async () => null,
        deleteOrganizationCascade: async () => {},
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

const run = (
  headers: Record<string, string>,
  readiness: Layer.Layer<MirrorReadiness> = stubReadiness,
) =>
  resolveSessionPrincipal(new Request("https://executor.test/api/tools", { headers })).pipe(
    Effect.provide(
      Layer.mergeAll(stubApiKeys, stubWorkOS, stubUsers, stubDirectory, stubMirror, readiness),
    ),
  );

// The mirror before the cutover has landed: the backfill has not covered
// every organization, or the reconciler has not drained recently.
const unreadyMirror = (state: MirrorReadinessState) =>
  Layer.succeed(MirrorReadiness)({ state: () => Effect.succeed(state) });

/**
 * A WorkOS that answers the pre-cutover membership list for MEMBER — active
 * in SESSION_ORG only, as a member — and records the calls, so the fallback
 * is assertable: with the mirror unready the list is read from WorkOS and
 * the directory (which says MEMBER is active in URL_ORG too) is never asked.
 */
const workosMemberships = (calls: string[]) =>
  Layer.succeed(
    WorkOSClient,
    new Proxy({} as WorkOSClientService, {
      get: (_t, prop) => {
        if (prop === "authenticateRequest") {
          return () =>
            Effect.succeed({
              userId: MEMBER,
              email: "u@e2e.test",
              organizationId: SESSION_ORG,
            });
        }
        if (prop === "listUserMemberships") {
          return (userId: string) =>
            Effect.sync(() => {
              calls.push(`listUserMemberships:${userId}`);
              return {
                object: "list" as const,
                data: [
                  {
                    id: `om_${MEMBER}_${SESSION_ORG}`,
                    userId: MEMBER,
                    organizationId: SESSION_ORG,
                    status: "active",
                    role: { slug: "member" },
                  },
                ] as never[],
                listMetadata: { before: null, after: null },
              };
            });
        }
        return () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`);
      },
    }),
  );

const unreadDirectory = Layer.succeed(MemberDirectory)({
  membership: () => Effect.die("an unready mirror must not be asked for membership"),
  membershipById: () => Effect.die("an unready mirror must not be asked for membership"),
  membershipsOf: () => Effect.die("an unready mirror must not be asked for membership"),
  members: () => Effect.die("an unready mirror must not be asked for membership"),
  membersById: () => Effect.die("an unready mirror must not be asked for membership"),
  findByEmail: () => Effect.die("an unready mirror must not be asked for membership"),
});

const runAgainstWorkOs = (headers: Record<string, string>, state: MirrorReadinessState) => {
  const calls: string[] = [];
  return resolveSessionPrincipal(new Request("https://executor.test/api/tools", { headers }))
    .pipe(
      Effect.provide(
        Layer.mergeAll(
          stubApiKeys,
          workosMemberships(calls),
          stubUsers,
          unreadDirectory,
          stubMirror,
          unreadyMirror(state),
        ),
      ),
    )
    .pipe(Effect.map((principal) => ({ principal, calls })));
};

describe("resolveSessionPrincipal · URL org selector", () => {
  it.effect("fails closed when no selector header is sent", () =>
    Effect.gen(function* () {
      // No fallback to the session org: the cookie's org is browser-global
      // and can name a different org than the tab's URL for a multi-org user.
      const error = yield* Effect.flip(run({ cookie: "wos-session=x" }));
      expect(error, "rejects instead of scoping to the session org").toMatchObject({
        _tag: "NoOrganization",
        code: "no_organization",
      });
    }),
  );

  it.effect("scopes to the URL org (by slug) over the session org", () =>
    Effect.gen(function* () {
      const principal = yield* run({
        cookie: "wos-session=x",
        "x-executor-organization": URL_SLUG,
      });
      expect(principal.organizationId, "the slug header wins over the session org").toBe(URL_ORG);
      expect(principal.orgRole, "the mirrored role binds the executor's write authority").toBe(
        "admin",
      );
    }),
  );

  it.effect("rejects a selector for an org where the membership is only pending", () =>
    Effect.gen(function* () {
      // An invite is mirrored as a pending membership; it grants no access
      // until accepted.
      const error = yield* Effect.flip(
        run({
          cookie: "wos-session=x",
          "x-executor-organization": PENDING_SLUG,
        }),
      );
      expect(error).toMatchObject({ _tag: "NoOrganization" });
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
        run({
          cookie: "wos-session=x",
          "x-executor-organization": "outsider-slug",
        }),
      );
      expect(error).toMatchObject({ _tag: "NoOrganization" });
    }),
  );
});

// The mirror authorizes only while it is READY (`mirror-readiness.ts`):
// the backfill has written every organization and the reconciler has drained
// the stream within its lag budget. Until then the membership check reads
// WorkOS, as it did before the cutover — so a member the backfill has not
// written yet is not locked out, and a stale mirror row cannot grant access
// WorkOS has revoked.
describe("resolveSessionPrincipal · mirror readiness", () => {
  const unready: readonly [string, MirrorReadinessState][] = [
    ["the backfill has not completed", MirrorReadinessState.BackfillPending()],
    ["the reconciler has never drained", MirrorReadinessState.ReconcilerStale({ drainedAt: null })],
    [
      "the reconciler's last drain is older than the budget",
      MirrorReadinessState.ReconcilerStale({ drainedAt: createdAt }),
    ],
  ];

  for (const [why, state] of unready) {
    it.effect(`reads membership from WorkOS, not the mirror, while ${why}`, () =>
      Effect.gen(function* () {
        // WorkOS says MEMBER is active in SESSION_ORG: authorized there...
        const granted = yield* runAgainstWorkOs(
          { cookie: "wos-session=x", "x-executor-organization": SESSION_ORG },
          state,
        );
        expect(granted.principal.organizationId).toBe(SESSION_ORG);
        expect(granted.principal.orgRole, "the role comes from WorkOS's list too").toBe("member");
        expect(granted.calls).toEqual([`listUserMemberships:${MEMBER}`]);

        // ...and NOT in URL_ORG, even though the (unready) mirror holds an
        // active admin membership there: the mirror's word is not taken.
        const refused = yield* Effect.flip(
          runAgainstWorkOs({ cookie: "wos-session=x", "x-executor-organization": URL_SLUG }, state),
        );
        expect(refused).toMatchObject({ _tag: "NoOrganization" });
      }),
    );
  }

  it.effect("reads the mirror once it is ready, without any WorkOS membership call", () =>
    Effect.gen(function* () {
      // `stubWorkOS` dies on any call past session authentication, so a
      // resolved principal here proves the list was never requested.
      const principal = yield* run(
        { cookie: "wos-session=x", "x-executor-organization": URL_SLUG },
        stubReadiness,
      );
      expect(principal.organizationId).toBe(URL_ORG);
      expect(principal.orgRole).toBe("admin");
    }),
  );
});
