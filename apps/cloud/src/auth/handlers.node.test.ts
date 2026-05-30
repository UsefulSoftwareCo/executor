import { HttpApiBuilder, HttpApi } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Layer } from "effect";
import type { Effect as EffectType } from "effect/Effect";

import { CloudAuthPublicApi } from "./api";
import { CloudAuthPublicHandlers } from "./handlers";
import { UserStoreService } from "./context";
import { WorkOSError } from "./errors";
import { WorkOSClient } from "./workos";

const TestAuthPublicApi = HttpApi.make("cloudWeb").add(CloudAuthPublicApi);
type EffectSuccess<T> = T extends EffectType<infer A, infer _E, infer _R> ? A : never;
type AuthenticateWithCodeResult = EffectSuccess<
  ReturnType<WorkOSClient["Service"]["authenticateWithCode"]>
>;
const fakeUser: AuthenticateWithCodeResult["user"] = {
  object: "user",
  id: "user_1",
  email: "test@example.com",
  emailVerified: true,
  profilePictureUrl: null,
  firstName: null,
  lastName: null,
  lastSignInAt: null,
  locale: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  externalId: null,
  metadata: {},
};

class UnstubbedWorkOSMethod extends Data.TaggedError("UnstubbedWorkOSMethod")<{
  method: string;
}> {}

const makeAuthFetch = (workos: Partial<WorkOSClient["Service"]>) => {
  const WorkOSTest = Layer.succeed(
    WorkOSClient,
    new Proxy(workos as WorkOSClient["Service"], {
      get: (target, prop) => {
        if (prop in target) return target[prop as keyof typeof target];
        return () =>
          Effect.fail(
            new UnstubbedWorkOSMethod({
              method: typeof prop === "string" ? prop : (prop.description ?? "symbol"),
            }),
          );
      },
    }),
  );
  const UserStoreTest = Layer.succeed(UserStoreService)({
    use: <A>() => Effect.sync(() => undefined as A),
  });
  const apiLayer = HttpApiBuilder.layer(TestAuthPublicApi).pipe(
    Layer.provide(CloudAuthPublicHandlers),
    Layer.provideMerge(WorkOSTest),
    Layer.provideMerge(UserStoreTest),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
  );
  const web = HttpRouter.toWebHandler(apiLayer, { disableLogger: true });
  return web.handler as (request: Request) => Promise<Response>;
};

describe("Auth callback handlers", () => {
  it.effect("routes login", () =>
    Effect.gen(function* () {
      let observedState: string | undefined;
      const fetch = makeAuthFetch({
        getAuthorizationUrl: (_redirectUri: string, state?: string) => {
          observedState = state;
          return `https://auth.example.test?state=${state}`;
        },
      });
      const response = yield* Effect.promise(() =>
        fetch(new Request("http://test.local/auth/login")),
      );
      expect(response.status).toBe(302);
      expect(observedState).toMatch(/^[0-9a-f]{64}$/);
      expect(response.headers.get("location")).toBe(
        `https://auth.example.test?state=${observedState}`,
      );
      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain(`wos-login-state=${observedState}`);
      expect(setCookie).toContain("Max-Age=600");
    }),
  );

  it.effect("rejects callback state without the matching login state cookie", () =>
    Effect.gen(function* () {
      let authenticateCalls = 0;
      const fetch = makeAuthFetch({
        authenticateWithCode: () =>
          Effect.sync(() => {
            authenticateCalls++;
            const result: AuthenticateWithCodeResult = {
              user: fakeUser,
              accessToken: "access_token",
              refreshToken: "refresh_token",
              sealedSession: "sealed_session",
            };
            return result;
          }),
      });

      const response = yield* Effect.promise(() =>
        fetch(
          new Request("http://test.local/auth/callback?code=attacker-code&state=attacker-state"),
        ),
      );

      expect(response.status).toBe(400);
      expect(authenticateCalls).toBe(0);
    }),
  );

  // Some WorkOS-initiated redirects don't include a state parameter.
  // The schema treats state as optional; the handler skips the CSRF
  // check when state is absent and proceeds with the code exchange.
  it.effect("accepts a callback without state", () =>
    Effect.gen(function* () {
      const fetch = makeAuthFetch({
        authenticateWithCode: () =>
          Effect.succeed({
            user: fakeUser,
            accessToken: "access_token",
            refreshToken: "refresh_token",
            organizationId: "org_1",
            sealedSession: "sealed_session_no_state",
          } satisfies AuthenticateWithCodeResult),
      });

      const response = yield* Effect.promise(() =>
        fetch(new Request("http://test.local/auth/callback?code=stateless-code")),
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/");
      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("wos-session=sealed_session_no_state");
    }),
  );

  it.effect("sets the session cookie and clears login state on matching callback state", () =>
    Effect.gen(function* () {
      const fetch = makeAuthFetch({
        authenticateWithCode: () =>
          Effect.succeed({
            user: fakeUser,
            accessToken: "access_token",
            refreshToken: "refresh_token",
            organizationId: "org_1",
            sealedSession: "sealed_session",
          } satisfies AuthenticateWithCodeResult),
      });

      const response = yield* Effect.promise(() =>
        fetch(
          new Request("http://test.local/auth/callback?code=code&state=state_1", {
            headers: { cookie: "wos-login-state=state_1" },
          }),
        ),
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/");
      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("wos-session=sealed_session");
      expect(setCookie).toContain("Max-Age=604800");
      expect(setCookie).toContain("wos-login-state=");
      expect(setCookie).toContain("Max-Age=0");
    }),
  );

  // Regression: an invited user signing in for the first time has only a
  // *pending* membership (the WorkOS-side representation of an unaccepted
  // invitation). The callback used to pick `data[0]` regardless of status
  // and call refreshSession into that org, which 400s and surfaces as
  // WorkOSError → 500. We now skip pending memberships entirely.
  it.effect("does not refresh into a pending membership; leaves session org-less", () =>
    Effect.gen(function* () {
      let refreshCalls = 0;
      const fetch = makeAuthFetch({
        authenticateWithCode: () =>
          Effect.succeed({
            user: fakeUser,
            accessToken: "access_token",
            refreshToken: "refresh_token",
            sealedSession: "sealed_session_no_org",
          } satisfies AuthenticateWithCodeResult),
        // The handler only reads `data[*].organizationId` and
        // `data[*].status`, so we stub a minimal shape matching that
        // contract instead of hand-rolling the full WorkOS SDK types.
        // oxlint-disable-next-line executor/no-double-cast
        listUserMemberships: (() =>
          Effect.succeed({
            data: [
              {
                organizationId: "org_pending",
                status: "pending",
              },
            ],
          })) as unknown as WorkOSClient["Service"]["listUserMemberships"],
        refreshSession: () =>
          Effect.sync(() => {
            refreshCalls++;
            return null;
          }),
      });

      const response = yield* Effect.promise(() =>
        fetch(
          new Request("http://test.local/auth/callback?code=code&state=state_2", {
            headers: { cookie: "wos-login-state=state_2" },
          }),
        ),
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/");
      expect(refreshCalls).toBe(0);
      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("wos-session=sealed_session_no_org");
    }),
  );

  // Regression: even with an active membership, if WorkOS rejects the
  // refresh (e.g. membership just revoked, brief race), the callback
  // should still succeed with an org-less session rather than 500.
  it.effect("falls through to org-less session when refresh fails", () =>
    Effect.gen(function* () {
      const fetch = makeAuthFetch({
        authenticateWithCode: () =>
          Effect.succeed({
            user: fakeUser,
            accessToken: "access_token",
            refreshToken: "refresh_token",
            sealedSession: "sealed_session_fallback",
          } satisfies AuthenticateWithCodeResult),
        // Same minimal-shape stub as above — see comment in the
        // pending-membership test.
        // oxlint-disable-next-line executor/no-double-cast
        listUserMemberships: (() =>
          Effect.succeed({
            data: [
              {
                organizationId: "org_active",
                status: "active",
              },
            ],
          })) as unknown as WorkOSClient["Service"]["listUserMemberships"],
        refreshSession: (() =>
          Effect.fail(new WorkOSError())) as WorkOSClient["Service"]["refreshSession"],
      });

      const response = yield* Effect.promise(() =>
        fetch(
          new Request("http://test.local/auth/callback?code=code&state=state_3", {
            headers: { cookie: "wos-login-state=state_3" },
          }),
        ),
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/");
      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("wos-session=sealed_session_fallback");
    }),
  );
});
