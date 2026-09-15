// ---------------------------------------------------------------------------
// Focused tests — the WorkOS login callback's CSRF gate.
//
// Codes without state restart login without a WorkOS exchange; a replayed
// state still fails with 400; a fresh state matching the cookie issues a session.
//
// Test seams follow repo conventions: @effect/vitest, Layer.succeed stubs
// (see org-selector-auth.node.test.ts), and HttpRouter.toWebHandler for the
// HTTP surface (see api.request-scope.node.test.ts).
// ---------------------------------------------------------------------------

import { afterAll, describe, expect, it, vi } from "@effect/vitest";
import { waitUntil } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpApi } from "effect/unstable/httpapi";

import { MemberDirectory } from "@executor-js/api/server";

import { CloudAuthPublicHandlers } from "./handlers";
import { CloudAuthPublicApi } from "./api";
import { UserStoreService } from "./context";
import { WorkOSClient, type WorkOSClientService } from "./workos";
import { WorkOsMirror } from "./workos-mirror";
import { encodeLoginState } from "./login-state";
import { AutumnService } from "../extensions/billing/service";

// The route under test serves under the `/api` prefix in the composed app;
// toWebHandler mounts the raw group, so paths here are relative to the group.
const SESSION_COOKIE = "wos-session";
const STATE_COOKIE = "wos-login-state";

const STUB_USER_ID = "user_test";
const STUB_SESSION = "sealed-session-stub";
const STUB_ORG_ID = "org_test";

const stubWorkOS = Layer.succeed(
  WorkOSClient,
  new Proxy({} as WorkOSClientService, {
    get: (_t, prop) => {
      if (prop === "authenticateWithCode") {
        return (code: string) =>
          code === "unbound-code"
            ? Effect.die("An unbound authorization code must never be exchanged")
            : Effect.succeed({
                user: { id: STUB_USER_ID, email: "u@test" },
                organizationId: STUB_ORG_ID,
                sealedSession: STUB_SESSION,
              });
      }
      if (prop === "listUserMemberships") {
        return () => Effect.succeed({ data: [] });
      }
      return () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`);
    },
  }),
);

// A bare account row, as `ensureAccount` mints it before any WorkOS profile
// has been mirrored onto it.
const bareAccount = (id: string) => ({
  id,
  email: null,
  firstName: null,
  lastName: null,
  avatarUrl: null,
  workosUpdatedAt: null,
  lastSignInAt: null,
  createdAt: new Date(),
});

const stubUsers = Layer.succeed(UserStoreService)({
  use: (_op, fn) =>
    Effect.promise(() =>
      fn({
        ensureAccount: async (id: string) => bareAccount(id),
        getAccount: async (id: string) => bareAccount(id),
        upsertOrganization: async (org: { id: string; name: string }) => ({
          ...org,
          slug: org.id,
          backfilledAt: null,
          deletedAt: null,
          workosUpdatedAt: null,
          createdAt: new Date(),
        }),
        getOrganization: async (id: string) => ({
          id,
          name: "Org " + id,
          slug: id,
          backfilledAt: null,
          deletedAt: null,
          workosUpdatedAt: null,
          createdAt: new Date(),
        }),
        getOrganizationBySlug: async (slug: string) => ({
          id: slug,
          name: slug,
          slug,
          backfilledAt: null,
          deletedAt: null,
          workosUpdatedAt: null,
          createdAt: new Date(),
        }),
        deleteOrganizationCascade: async () => {},
      }),
    ),
});

// The callback records the sign-in (user + memberships) in the membership
// mirror, and its forked seat recount reads the backfill marker and the
// landed org's active members from it; every other operation is out of this
// route's reach.
const stubMirror = Layer.succeed(WorkOsMirror)({
  upsertUser: () => Effect.succeed(true),
  upsertMembership: () => Effect.succeed(true),
  deleteMembership: () => Effect.die("the callback does not delete memberships"),
  deleteUser: () => Effect.die("the callback does not delete users"),
  getCursor: () => Effect.die("the callback does not read the events cursor"),
  applyPage: () => Effect.die("the callback does not move the events cursor"),
  applyOrganizationScan: () => Effect.die("the callback does not run the backfill"),
  replayBoundary: () => Effect.die("the callback does not run the reconciler"),
  setReplayBoundary: () => Effect.die("the callback does not run the backfill"),
  backfillCompletedAt: () => Effect.die("the callback does not check mirror readiness"),
  markBackfillCompleted: () => Effect.die("the callback does not run the backfill"),
  drainedAt: () => Effect.die("the callback does not check mirror readiness"),
  markDrained: () => Effect.die("the callback does not run the reconciler"),
  organizationBackfilledAt: () => Effect.succeed(new Date()),
});

const stubDirectory = Layer.succeed(MemberDirectory)({
  membership: () => Effect.die("the callback does not look up one membership"),
  membersById: () => Effect.die("the callback does not batch members"),
  findByEmail: () => Effect.die("the callback does not resolve emails"),
  members: (organizationId) =>
    Effect.succeed([
      {
        accountId: STUB_USER_ID,
        membershipId: `om_${STUB_USER_ID}`,
        organizationId,
        email: null,
        name: null,
        avatarUrl: null,
        role: "member",
        status: "active" as const,
        lastActiveAt: null,
      },
    ]),
});

// Only the public group is under test; the session group (and its SessionAuth
// middleware, which needs a live DB) is out of scope — the callback route lives
// in CloudAuthPublicApi and requires no middleware.
const PublicApi = HttpApi.make("cloudWeb").add(CloudAuthPublicApi);

const App = HttpApiBuilder.layer(PublicApi).pipe(
  Layer.provide(CloudAuthPublicHandlers),
  Layer.provide(stubWorkOS),
  Layer.provide(stubUsers),
  Layer.provide(stubMirror),
  Layer.provide(stubDirectory),
  Layer.provide(AutumnService.Default),
  Layer.provide(HttpServer.layerServices),
);

const app = HttpRouter.toWebHandler(App, { disableLogger: true });
afterAll(async () => {
  await Promise.all(vi.mocked(waitUntil).mock.calls.map(([work]) => work));
  await app.dispose();
});

const run = (request: Request) => {
  // beta.59: the handler type expects a context argument; this layer stack
  // needs none at runtime — pass undefined like the api.request-scope tests.
  return app.handler(request, undefined as never);
};

const callbackUrl = (state?: string, code = "code_1") =>
  `https://executor.test/auth/callback${state ? `?state=${encodeURIComponent(state)}` : ""}${state ? "&" : "?"}code=${code}`;

describe("workos callback · CSRF state hardening", () => {
  for (const returnTo of ["/\\evil.example", "/safe/../api/auth/me"]) {
    it(`keeps an unsafe return destination on the homepage: ${JSON.stringify(returnTo)}`, async () => {
      const state = encodeLoginState({ nonce: "redirect-boundary", returnTo });
      const res = await run(
        new Request(callbackUrl(state), {
          headers: { cookie: `${STATE_COOKIE}=${state}` },
          redirect: "manual",
        }),
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
      expect(res.headers.get("set-cookie") ?? "").toContain(SESSION_COOKIE);
    });
  }

  it("restarts login without exchanging a code that has no state", async () => {
    const res = await run(
      new Request(callbackUrl(undefined, "unbound-code"), { redirect: "manual" }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/api/auth/login");
    expect(res.headers.get("set-cookie") ?? "").not.toContain(SESSION_COOKIE);
  });

  it("discards an existing login cookie when restarting a callback without state", async () => {
    const res = await run(
      new Request(callbackUrl(undefined, "unbound-code"), {
        headers: { cookie: `${STATE_COOKIE}=victim-login-state` },
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/api/auth/login");
    expect(res.headers.get("set-cookie")).toContain(`${STATE_COOKIE}=; Max-Age=0`);
    expect(res.headers.get("set-cookie") ?? "").not.toContain(SESSION_COOKIE);
  });

  it("rejects empty state instead of treating it as a provider-initiated login", async () => {
    const res = await run(new Request(`${callbackUrl(undefined, "unbound-code")}&state=`));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid login state");
    expect(res.headers.get("set-cookie") ?? "").not.toContain(SESSION_COOKIE);
  });

  it("rejects a state that does not match the login cookie", async () => {
    const res = await run(
      new Request(callbackUrl("attacker-controlled-state"), {
        headers: { cookie: `${STATE_COOKIE}=victim-login-state` },
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid login state");
  });

  it("accepts a fresh state matching the cookie and issues a session (302 + cookie)", async () => {
    // /login sets the cookie; simulate its value for this callback.
    const state = encodeLoginState({ nonce: "nonce-123", returnTo: "/" });
    const res = await run(
      new Request(callbackUrl(state), {
        headers: { cookie: `${STATE_COOKIE}=${state}` },
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie") ?? "").toContain(SESSION_COOKIE);
  });

  it("rejects a replayed state (single-use contract preserved downstream)", async () => {
    // Replay of a state whose cookie is gone (already consumed by the login
    // round-trip) must fail closed.
    const state = encodeLoginState({ nonce: "nonce-replay", returnTo: "/" });
    const first = await run(
      new Request(callbackUrl(state), {
        headers: { cookie: `${STATE_COOKIE}=${state}` },
        redirect: "manual",
      }),
    );
    expect(first.status).toBe(302);

    // Second callback: same state, no cookie (session-store consumed it).
    const replay = await run(new Request(callbackUrl(state), { redirect: "manual" }));
    expect(replay.status).toBe(400);
  });
});

describe("logout browser cleanup", () => {
  it("clears browser storage when the browser presents an auth hint", async () => {
    const response = await run(
      new Request("https://executor.test/auth/logout", {
        method: "POST",
        headers: { cookie: "executor-auth-hint=1" },
        redirect: "manual",
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("clear-site-data")).toBe('"cache", "storage"');
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("does not clear storage for a request without same-site cookies", async () => {
    const response = await run(
      new Request("https://executor.test/auth/logout", {
        method: "POST",
        redirect: "manual",
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("clear-site-data")).toBeNull();
  });
});
