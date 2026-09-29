import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ToolName,
  createExecutor,
  definePlugin,
  type Executor,
} from "@executor-js/sdk";
import {
  makeTestConfig,
  memoryCredentialsPlugin,
  serveOAuthTestServer,
  type OAuthTestServerShape,
} from "@executor-js/sdk/testing";

import { ExecutorApi } from "../api";
import { observabilityMiddleware } from "../observability";
import { CoreHandlers, ExecutionEngineService, ExecutorService } from "../server";

// `POST /connections/:owner/:integration/:name/oauth/refresh` — the on-demand
// OAuth refresh grant, driven over HTTP against a live test authorization
// server.

const webHandlerFor = (executor: Executor) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(ExecutorApi).pipe(
          Layer.provide(CoreHandlers),
          Layer.provide(observabilityMiddleware(ExecutorApi)),
          Layer.provide(Layer.succeed(ExecutorService)(executor)),
          Layer.provide(
            Layer.succeed(ExecutionEngineService)({} as ExecutionEngineService["Service"]),
          ),
          Layer.provideMerge(HttpServer.layerServices),
          Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
        ),
        { disableLogger: true },
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  );

const handlerContextFor = (executor: Executor) =>
  Context.make(ExecutorService, executor).pipe(
    Context.add(ExecutionEngineService, {} as ExecutionEngineService["Service"]),
  );

const INTEGRATION = IntegrationSlug.make("acme");
const TEMPLATE = AuthTemplateSlug.make("oauth");
const CLIENT = OAuthClientSlug.make("acme-app");

const acmePlugin = definePlugin(() => ({
  id: "acme" as const,
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({
      tools: [{ name: ToolName.make("whoami"), description: "whoami" }],
    }),
  describeAuthMethods: () => [
    {
      id: "oauth",
      label: "OAuth2",
      kind: "oauth" as const,
      template: String(TEMPLATE),
      oauth: { scopes: ["read"] },
    },
  ],
  invokeTool: ({ credential }) => Effect.succeed({ token: credential.value }),
  checkHealth: ({ credential }) =>
    Effect.succeed({
      status: credential.value === null ? "expired" : "healthy",
      checkedAt: Date.now(),
    }),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: INTEGRATION,
        description: "Acme",
        config: {},
      }),
  }),
}))();

const plugins = [memoryCredentialsPlugin(), acmePlugin] as const;

const connectOAuth = (executor: Executor<typeof plugins>, server: OAuthTestServerShape) =>
  Effect.gen(function* () {
    yield* executor.acme.seed();
    yield* executor.oauth.createClient({
      owner: "org",
      slug: CLIENT,
      authorizationUrl: server.authorizationEndpoint,
      tokenUrl: server.tokenEndpoint,
      grant: "authorization_code",
      clientId: "test-client",
      clientSecret: "test-secret",
    });
    const started = yield* executor.oauth.start({
      owner: "org",
      client: CLIENT,
      clientOwner: "org",
      name: ConnectionName.make("main"),
      integration: INTEGRATION,
      template: TEMPLATE,
    });
    expect(started.status).toBe("redirect");
    if (started.status !== "redirect") return;
    const callback = yield* server.completeAuthorizationCodeFlow({
      authorizationUrl: started.authorizationUrl,
    });
    yield* executor.oauth.complete({ state: started.state, code: callback.code });
  });

const refreshRequest = (owner: string, name: string) =>
  new Request(`http://localhost/connections/${owner}/${INTEGRATION}/${name}/oauth/refresh`, {
    method: "POST",
  });

const refreshGrantCount = (server: OAuthTestServerShape) =>
  server.requests.pipe(
    Effect.map(
      (requests) =>
        requests.filter(
          (request) =>
            request.path === "/token" && request.body.includes("grant_type=refresh_token"),
        ).length,
    ),
  );

describe("POST /connections/:owner/:integration/:name/oauth/refresh", () => {
  it.effect("refreshes a token that is nowhere near expiry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({
          scopes: ["read"],
          tokenExpiresInSeconds: 3600,
        });
        const config = makeTestConfig({ plugins });
        const executor = yield* createExecutor(config);
        yield* Effect.addFinalizer(() => executor.close().pipe(Effect.ignore));
        yield* connectOAuth(executor, server);
        yield* server.clearRequests;
        const web = yield* webHandlerFor(executor);

        const response = yield* Effect.promise(() =>
          web.handler(refreshRequest("org", "main"), handlerContextFor(executor)),
        );
        expect(response.status).toBe(200);
        const body = (yield* Effect.promise(() => response.json())) as {
          readonly refreshed: boolean;
          readonly expiresAt: number | null;
          readonly health: { readonly status: string };
        };
        expect(body.refreshed).toBe(true);
        expect(body.expiresAt).toBeGreaterThan(Date.now() + 30 * 60_000);
        expect(body.health.status).toBe("healthy");
        expect(yield* refreshGrantCount(server)).toBe(1);
      }),
    ),
  );

  it.effect("maps non-OAuth and unknown connections to 400 and 404", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = makeTestConfig({ plugins });
        const executor = yield* createExecutor(config);
        yield* Effect.addFinalizer(() => executor.close().pipe(Effect.ignore));
        yield* executor.acme.seed();
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("pasted"),
          integration: INTEGRATION,
          template: AuthTemplateSlug.make("apiKey"),
          value: "static-token",
        });
        const web = yield* webHandlerFor(executor);
        const context = handlerContextFor(executor);

        const notOAuth = yield* Effect.promise(() =>
          web.handler(refreshRequest("org", "pasted"), context),
        );
        expect(notOAuth.status).toBe(400);
        expect(yield* Effect.promise(() => notOAuth.json())).toMatchObject({
          _tag: "InvalidConnectionInputError",
        });

        const missing = yield* Effect.promise(() =>
          web.handler(refreshRequest("org", "nope"), context),
        );
        expect(missing.status).toBe(404);
      }),
    ),
  );

  it.effect("refuses a workspace connection for a member without workspace writes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const config = makeTestConfig({ plugins });
        const admin = yield* createExecutor(config);
        const member = yield* createExecutor({ ...config, orgWrites: "denied" });
        yield* Effect.addFinalizer(() =>
          admin.close().pipe(Effect.andThen(member.close()), Effect.ignore),
        );
        yield* connectOAuth(admin, server);
        yield* server.clearRequests;
        const web = yield* webHandlerFor(member);

        const response = yield* Effect.promise(() =>
          web.handler(refreshRequest("org", "main"), handlerContextFor(member)),
        );
        expect(response.status).toBe(403);
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          _tag: "OrgWriteDeniedError",
        });
        expect(yield* refreshGrantCount(server), "nothing reached the token endpoint").toBe(0);
      }),
    ),
  );
});
