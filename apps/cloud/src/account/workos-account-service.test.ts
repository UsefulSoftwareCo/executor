import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { AccountHttpApi } from "@executor-js/api";
import { AccountHandlers } from "@executor-js/api/server";

import { ApiKeyService } from "../auth/api-keys";
import { UserStoreService } from "../auth/context";
import type { Session } from "../auth/middleware";
import { WorkOSClient, type WorkOSClientService } from "../auth/workos";
import { AutumnService } from "../services/autumn";
import { AccountCaller, workosAccountProvider } from "./workos-account-service";

// ---------------------------------------------------------------------------
// Mounts the SHARED, provider-neutral AccountHandlers over the cloud WorkOS
// AccountProvider and drives the routes through a web handler, proving that
// `/account/me` (authenticated) and `/account/api-keys` return the neutral
// shapes. The caller is now resolved ONCE by the cookie-only session
// middleware (account-api.ts) and injected as `AccountCaller`; these tests
// drive the service with that resolved caller directly. The shared React
// `AccountApiClient` hits these exact paths.
// ---------------------------------------------------------------------------

const authedSession: Session = {
  accountId: "user_1",
  email: "user@test.com",
  name: "Test User",
  avatarUrl: null,
  organizationId: "org_1",
  sealedSession: "sealed_session",
  refreshedSession: null,
};

const orgLessSession: Session = { ...authedSession, organizationId: null };

const stubWorkOS = (overrides: Partial<WorkOSClientService> = {}) =>
  Layer.succeed(
    WorkOSClient,
    new Proxy({} as WorkOSClientService, {
      get: (_target, prop) => {
        if (typeof prop === "string" && prop in overrides) {
          return overrides[prop as keyof WorkOSClientService];
        }
        return () => Effect.void;
      },
    }),
  );

// User store stub — `resolveOrganization` reads `getOrganization` first, so
// returning the mirrored org short-circuits the WorkOS fallback.
const stubUserStore = Layer.succeed(UserStoreService)({
  use: (<A>(fn: (s: unknown) => Promise<A>) =>
    Effect.promise(() =>
      fn({
        getOrganization: () => Promise.resolve({ id: "org_1", name: "Test Org" }),
        upsertOrganization: (org: { id: string; name: string }) => Promise.resolve(org),
      }),
    )) as UserStoreService["Service"]["use"],
});

const stubApiKeys = Layer.succeed(ApiKeyService)({
  validate: () => Effect.succeed(null),
  listUserKeys: () =>
    Effect.succeed([
      {
        id: "key_1",
        name: "Local CLI",
        obfuscatedValue: "exk_…a1b2",
        createdAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-04-01T00:00:00Z",
        lastUsedAt: null,
      },
    ]),
  createUserKey: () =>
    Effect.succeed({
      id: "key_2",
      name: "New key",
      obfuscatedValue: "exk_…c3d4",
      createdAt: "2026-04-02T00:00:00Z",
      updatedAt: "2026-04-02T00:00:00Z",
      lastUsedAt: null,
      value: "exk_secret_value",
    }),
  revokeUserKey: () => Effect.void,
} satisfies ApiKeyService["Service"]);

const stubAutumn = Layer.succeed(AutumnService)({
  use: (() => Effect.succeed({ subscriptions: [] })) as AutumnService["Service"]["use"],
  trackExecution: () => Effect.void,
} satisfies AutumnService["Service"]);

const makeFetch = (caller: Session | null, workos: Partial<WorkOSClientService> = {}) => {
  const serviceLive = workosAccountProvider.pipe(
    Layer.provide(stubWorkOS(workos)),
    Layer.provide(stubApiKeys),
    Layer.provide(stubAutumn),
    Layer.provide(stubUserStore),
    Layer.provide(Layer.succeed(AccountCaller)({ session: caller })),
  );
  const apiLayer = HttpApiBuilder.layer(AccountHttpApi).pipe(
    Layer.provide(AccountHandlers),
    Layer.provideMerge(serviceLive),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
  );
  const web = HttpRouter.toWebHandler(apiLayer, { disableLogger: true });
  return web.handler as (request: Request) => Promise<Response>;
};

// The service only reads `data[*].organizationId` + `data[*].status`, so stub
// the minimal membership-list shape matching that contract rather than the full
// WorkOS SDK types — same approach as `auth/handlers.node.test.ts`.
const stubMemberships = (
  data: ReadonlyArray<{ organizationId: string; status: string }>,
): WorkOSClientService["listUserMemberships"] =>
  // oxlint-disable-next-line executor/no-double-cast -- test stub: minimal contract shape, not the full SDK list type
  (() => Effect.succeed({ data })) as unknown as WorkOSClientService["listUserMemberships"];

describe("Cloud Account API (neutral surface, WorkOS-backed)", () => {
  it.effect("GET /account/me returns the neutral user + organization for an authed session", () =>
    Effect.gen(function* () {
      const fetch = makeFetch(authedSession, {
        listUserMemberships: stubMemberships([{ organizationId: "org_1", status: "active" }]),
      });

      const response = yield* Effect.promise(() =>
        fetch(new Request("http://test.local/account/me")),
      );
      expect(response.status).toBe(200);
      const body = yield* Effect.promise(() => response.json());
      expect(body).toEqual({
        user: {
          id: "user_1",
          email: "user@test.com",
          name: "Test User",
          avatarUrl: null,
        },
        organization: { id: "org_1", name: "Test Org" },
      });
    }),
  );

  it.effect("GET /account/me returns 401 when there is no valid session", () =>
    Effect.gen(function* () {
      const fetch = makeFetch(null);

      const response = yield* Effect.promise(() =>
        fetch(new Request("http://test.local/account/me")),
      );
      expect(response.status).toBe(401);
    }),
  );

  it.effect("GET /account/api-keys returns the caller's keys in the neutral shape", () =>
    Effect.gen(function* () {
      const fetch = makeFetch(authedSession, {
        listUserMemberships: stubMemberships([{ organizationId: "org_1", status: "active" }]),
      });

      const response = yield* Effect.promise(() =>
        fetch(new Request("http://test.local/account/api-keys")),
      );
      expect(response.status).toBe(200);
      const body = (yield* Effect.promise(() => response.json())) as {
        apiKeys: ReadonlyArray<{ id: string; name: string }>;
      };
      expect(body.apiKeys).toEqual([
        {
          id: "key_1",
          name: "Local CLI",
          obfuscatedValue: "exk_…a1b2",
          createdAt: "2026-04-01T00:00:00Z",
          updatedAt: "2026-04-01T00:00:00Z",
          lastUsedAt: null,
        },
      ]);
    }),
  );

  it.effect("GET /account/api-keys returns 403 when the session has no organization", () =>
    Effect.gen(function* () {
      const fetch = makeFetch(orgLessSession);

      const response = yield* Effect.promise(() =>
        fetch(new Request("http://test.local/account/api-keys")),
      );
      expect(response.status).toBe(403);
    }),
  );
});
