import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import {
  IntegrationSlug,
  createExecutor,
  definePlugin,
  type AuthMethodDescriptor,
  type Executor,
  type IntegrationRecord,
} from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";

import { ExecutorApi } from "../api";
import { observabilityMiddleware } from "../observability";
import { CoreHandlers, ExecutionEngineService, ExecutorService } from "../server";

// ---------------------------------------------------------------------------
// The catalog response surfaces each plugin's DECLARED auth methods (projected
// from the integration's stored config via `describeAuthMethods`). This proves
// the visible bug is fixed: an OAuth integration with ZERO connections still
// advertises an `oauth` method, and an apikey/header integration advertises an
// `apikey` method — the client no longer has to infer from connections.
//
// We register integrations through a lightweight inline plugin so the test
// stays in `@executor-js/api` without a cross-package dependency on the MCP
// plugin; the MCP-specific projection is covered by the MCP plugin's own
// `describe-auth-methods` test.
// ---------------------------------------------------------------------------

const OAUTH_METHOD: AuthMethodDescriptor = {
  id: "oauth2",
  label: "OAuth",
  kind: "oauth",
  template: "oauth2",
  oauth: { discoveryUrl: "https://x.example/oauth/mcp", supportsDynamicRegistration: true },
};

const APIKEY_METHOD: AuthMethodDescriptor = {
  id: "header",
  label: "API key (header)",
  kind: "apikey",
  template: "header",
  placements: [{ carrier: "header", name: "Authorization", prefix: "" }],
};

// A plugin that projects its stored `config.methods` blob straight back as the
// declared auth methods, exercising the catalog wiring end-to-end.
const declaringPlugin = definePlugin(() => ({
  id: "declaring" as const,
  storage: () => ({}),
  describeAuthMethods: (record: IntegrationRecord): readonly AuthMethodDescriptor[] => {
    const config = record.config as {
      readonly methods?: readonly AuthMethodDescriptor[];
      readonly displayUrl?: string;
    };
    return config?.methods ?? [];
  },
  describeIntegrationDisplay: (record: IntegrationRecord) => {
    const config = record.config as {
      readonly methods?: readonly AuthMethodDescriptor[];
      readonly displayUrl?: string;
    };
    return { url: config?.displayUrl };
  },
  extension: (ctx) => ({
    seed: (slug: IntegrationSlug, methods: readonly AuthMethodDescriptor[], displayUrl?: string) =>
      ctx.core.integrations.register({
        slug,
        description: String(slug),
        config: { methods, displayUrl },
      }),
  }),
}))();

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

interface IntegrationResponseBody {
  readonly slug: string;
  readonly authMethods: readonly AuthMethodDescriptor[];
  readonly displayUrl?: string;
}

describe("catalog surfaces declared auth methods", () => {
  it.effect("an OAuth integration with zero connections advertises an oauth method", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [declaringPlugin] }));
      const slug = IntegrationSlug.make("oauth-server");
      yield* executor.declaring.seed(slug, [OAUTH_METHOD]);

      const web = yield* webHandlerFor(executor);
      const context = handlerContextFor(executor);

      const response = yield* Effect.promise(() =>
        web.handler(
          new Request(`http://localhost/integrations/${encodeURIComponent(String(slug))}`),
          context,
        ),
      );
      expect(response.status).toBe(200);
      const body = (yield* Effect.promise(() => response.json())) as IntegrationResponseBody;

      expect(body.authMethods).toEqual([OAUTH_METHOD]);
      expect(body.authMethods[0]?.kind).toBe("oauth");
      expect(body.authMethods[0]?.oauth?.supportsDynamicRegistration).toBe(true);
    }),
  );

  it.effect("an apikey integration advertises an apikey method", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [declaringPlugin] }));
      const slug = IntegrationSlug.make("apikey-server");
      yield* executor.declaring.seed(slug, [APIKEY_METHOD]);

      const web = yield* webHandlerFor(executor);
      const context = handlerContextFor(executor);

      const response = yield* Effect.promise(() =>
        web.handler(
          new Request(`http://localhost/integrations/${encodeURIComponent(String(slug))}`),
          context,
        ),
      );
      expect(response.status).toBe(200);
      const body = (yield* Effect.promise(() => response.json())) as IntegrationResponseBody;

      expect(body.authMethods).toEqual([APIKEY_METHOD]);
      expect(body.authMethods[0]?.kind).toBe("apikey");
    }),
  );

  it.effect("list surfaces authMethods and a plugin with no projector yields []", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [declaringPlugin] }));
      yield* executor.declaring.seed(IntegrationSlug.make("oauth-server"), [OAUTH_METHOD]);
      yield* executor.declaring.seed(IntegrationSlug.make("bare-server"), []);

      const web = yield* webHandlerFor(executor);
      const context = handlerContextFor(executor);

      const response = yield* Effect.promise(() =>
        web.handler(new Request("http://localhost/integrations"), context),
      );
      expect(response.status).toBe(200);
      const body = (yield* Effect.promise(() =>
        response.json(),
      )) as readonly IntegrationResponseBody[];

      const oauth = body.find((i) => i.slug === "oauth-server");
      const bare = body.find((i) => i.slug === "bare-server");
      expect(oauth?.authMethods).toEqual([OAUTH_METHOD]);
      expect(bare?.authMethods).toEqual([]);
    }),
  );

  it.effect("surfaces plugin-derived display URLs without exposing config", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [declaringPlugin] }));
      const slug = IntegrationSlug.make("autumn");
      yield* executor.declaring.seed(slug, [], "https://api.useautumn.com");

      const web = yield* webHandlerFor(executor);
      const context = handlerContextFor(executor);

      const response = yield* Effect.promise(() =>
        web.handler(
          new Request(`http://localhost/integrations/${encodeURIComponent(String(slug))}`),
          context,
        ),
      );
      expect(response.status).toBe(200);
      const body = (yield* Effect.promise(() => response.json())) as IntegrationResponseBody;

      expect(body.displayUrl).toBe("https://api.useautumn.com");
      expect("config" in body).toBe(false);
    }),
  );
});
