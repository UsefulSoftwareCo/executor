import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type * as Tracer from "effect/Tracer";

import { MemberDirectory, type DirectoryMember } from "@executor-js/api/server";

import { ApiKeyService } from "./api-keys";
import { UserStoreService } from "./context";
import { AUTHORIZE_ORGANIZATION_SPAN } from "./organization";
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

const run = (headers: Record<string, string>) =>
  resolveSessionPrincipal(new Request("https://executor.test/api/tools", { headers })).pipe(
    Effect.provide(Layer.mergeAll(stubApiKeys, stubWorkOS, stubUsers, stubDirectory, stubMirror)),
  );

/**
 * A tracer that keeps every span's attributes, so the authorization span
 * itself — {@link AUTHORIZE_ORGANIZATION_SPAN} — is assertable.
 */
const makeRecordingTracer = () => {
  const spans: {
    readonly name: string;
    readonly attributes: Map<string, unknown>;
  }[] = [];
  const tracer: Tracer.Tracer = {
    span: (options) => {
      const attributes = new Map<string, unknown>();
      spans.push({ name: options.name, attributes });
      let status: Tracer.SpanStatus = {
        _tag: "Started",
        startTime: options.startTime,
      };
      return {
        _tag: "Span",
        name: options.name,
        spanId: `span-${spans.length}`,
        traceId: "trace-1",
        parent: options.parent,
        annotations: options.annotations,
        get status() {
          return status;
        },
        attributes,
        links: options.links,
        sampled: options.sampled,
        kind: options.kind,
        end: (endTime, exit) => {
          status = {
            _tag: "Ended",
            startTime: options.startTime,
            endTime,
            exit,
          };
        },
        attribute: (key, value) => {
          attributes.set(key, value);
        },
        event: () => undefined,
        addLinks: () => undefined,
      };
    },
  };
  const attributesOf = (name: string) => spans.find((span) => span.name === name)?.attributes;
  return { tracer, attributesOf };
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

// Membership is read from the local mirror unconditionally — there is no
// readiness gate and no per-request WorkOS fallback (`auth/organization.ts`).
// The span every authorization runs under is still pinned here; a stalled
// reconciler is now an operational alert (`workos-events-runner.ts`), not a
// request-path branch, so it has no span attribute left to assert on.
describe("resolveSessionPrincipal · authorization span", () => {
  it.effect("runs the authorization under its span", () =>
    Effect.gen(function* () {
      const recorder = makeRecordingTracer();
      const principal = yield* run({
        cookie: "wos-session=x",
        "x-executor-organization": URL_SLUG,
      }).pipe(Effect.withTracer(recorder.tracer));
      expect(principal.organizationId).toBe(URL_ORG);
      expect(recorder.attributesOf(AUTHORIZE_ORGANIZATION_SPAN)).toBeDefined();
    }),
  );
});
