// ---------------------------------------------------------------------------
// Focused tests — the WorkOS login callback's CSRF gate.
//
// The callback's CSRF check must be unconditional: no state ⇒ 400 before any
// WorkOS call; a replayed (already consumed) state ⇒ 400; a fresh state
// matching the cookie ⇒ 302 + session.
//
// Test seams follow repo conventions: @effect/vitest, Layer.succeed stubs
// (see org-selector-auth.node.test.ts), and HttpRouter.toWebHandler for the
// HTTP surface (see api.request-scope.node.test.ts).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpApi } from "effect/unstable/httpapi";

import { CloudAuthPublicHandlers } from "./handlers";
import { CloudAuthPublicApi } from "./api";
import { UserStoreService } from "./context";
import { WorkOSClient, type WorkOSClientService } from "./workos";
import { encodeLoginState } from "./login-state";

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
        return () =>
          Effect.succeed({
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

const stubUsers = Layer.succeed(UserStoreService)({
  use: (_op, fn) =>
    Effect.promise(() =>
      fn({
        ensureAccount: async (id: string) => ({ id, createdAt: new Date() }),
        getAccount: async (id: string) => ({ id, createdAt: new Date() }),
        upsertOrganization: async (org: { id: string; name: string }) => ({
          ...org,
          slug: org.id,
          createdAt: new Date(),
        }),
        getOrganization: async (id: string) => ({
          id,
          name: "Org " + id,
          slug: id,
          createdAt: new Date(),
        }),
        getOrganizationBySlug: async (slug: string) => ({
          id: slug,
          name: slug,
          slug,
          createdAt: new Date(),
        }),
        deleteOrganizationCascade: async () => {},
      }),
    ),
});

// Only the public group is under test; the session group (and its SessionAuth
// middleware, which needs a live DB) is out of scope — the callback route lives
// in CloudAuthPublicApi and requires no middleware.
const PublicApi = HttpApi.make("cloudWeb").add(CloudAuthPublicApi);

const App = HttpApiBuilder.layer(PublicApi).pipe(
  Layer.provide(CloudAuthPublicHandlers),
  Layer.provide(stubWorkOS),
  Layer.provide(stubUsers),
  Layer.provide(HttpServer.layerServices),
);

const run = (request: Request) => {
  const handler = HttpRouter.toWebHandler(App, { disableLogger: true }).handler;
  // beta.59: the handler type expects a context argument; this layer stack
  // needs none at runtime — pass undefined like the api.request-scope tests.
  return handler(request, undefined as never);
};

const callbackUrl = (state?: string, code = "code_1") =>
  `https://executor.test/auth/callback${state ? `?state=${encodeURIComponent(state)}` : ""}${state ? "&" : "?"}code=${code}`;

describe("workos callback · CSRF state hardening", () => {
  it("rejects a callback with NO state (the former bypass) before any WorkOS call", async () => {
    const res = await run(new Request(callbackUrl(undefined), { redirect: "manual" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid login state");
    expect(res.headers.get("set-cookie") ?? "").not.toContain(SESSION_COOKIE);
  });

  it("rejects a state that does not match the login cookie", async () => {
    const res = await run(
      new Request(callbackUrl("attacker-controlled-state"), { redirect: "manual" }),
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
