import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolName,
  createExecutor,
  definePlugin,
  type Executor,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { ExecutorApi } from "./api";
import { observabilityMiddleware } from "./observability";
import { CoreHandlers, ExecutionEngineService, ExecutorService } from "./server";

// ---------------------------------------------------------------------------
// v2 owner-scoped API behaviour.
//
// v1's "explicit target scope" tests gated writes by a route scope vs a payload
// `targetScope`, and exercised the `[user, org]` scope-stack shadowing rules.
// v2 has neither: the executor binds `{ tenant, subject }` from auth, addresses
// name their owner explicitly (`tools.<int>.<owner>.<conn>.<tool>`), and there is
// no shadowing (D12) — an org connection and a user connection are DISTINCT rows
// with distinct addresses. These ports keep the spirit (writes target an owner,
// owner rows are independent) against the real v2 surface.
// ---------------------------------------------------------------------------

// removed: "policy update uses the row target scope instead of the route read
//   scope" — v2 policies have no route read-scope vs payload target-scope split;
//   they are owner-scoped. The owner-scoped create/update path is covered below.
// removed: "OAuth start requires the route scope to match the requested token
//   scope" and "OAuth complete requires the route scope to match the pending
//   session scope" — v2 OAuth carries no scope segment; start/complete are stubbed
//   in the SDK (milestone 2) and have no scope-matching gate to assert.

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

const INTEGRATION = IntegrationSlug.make("vercel");

// A plugin that owns the `vercel` integration and produces one tool per
// connection so the per-connection address scheme is exercised.
const vercelPlugin = definePlugin(() => ({
  id: "vercel" as const,
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({
      tools: [{ name: ToolName.make("deploy"), description: "deploy" }],
    }),
  invokeTool: () => Effect.succeed({ ok: true }),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: INTEGRATION,
        description: "Vercel",
        config: {},
      }),
  }),
}))();

describe("core API owner-scoped writes (v2)", () => {
  it.effect("policy create + update target an explicit owner", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({}));
      const web = yield* webHandlerFor(executor);
      const context = handlerContextFor(executor);

      const createResponse = yield* Effect.promise(() =>
        web.handler(
          new Request("http://localhost/policies", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              owner: "org",
              pattern: "vercel.*",
              action: "require_approval",
            }),
          }),
          context,
        ),
      );
      expect(createResponse.status).toBe(200);
      const created = (yield* Effect.promise(() => createResponse.json())) as {
        id: string;
      };

      const updateResponse = yield* Effect.promise(() =>
        web.handler(
          new Request(`http://localhost/policies/${encodeURIComponent(created.id)}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ owner: "org", action: "block" }),
          }),
          context,
        ),
      );

      expect(updateResponse.status).toBe(200);
      const policies = yield* executor.policies.list();
      expect(policies[0]).toMatchObject({
        id: created.id,
        owner: "org",
        action: "block",
      });
    }),
  );

  it.effect("connection remove deletes the named owner row, not the other owner", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        plugins: [memoryCredentialsPlugin(), vercelPlugin] as const,
      });
      const executor = yield* createExecutor(config);
      yield* executor.vercel.seed();
      const web = yield* webHandlerFor(executor);
      const context = handlerContextFor(executor);

      const name = ConnectionName.make("default");
      yield* executor.connections.create({
        owner: "org",
        name,
        integration: INTEGRATION,
        template: AuthTemplateSlug.make("apiKey"),
        value: "org-token",
      });
      yield* executor.connections.create({
        owner: "user",
        name,
        integration: INTEGRATION,
        template: AuthTemplateSlug.make("apiKey"),
        value: "user-token",
      });

      const response = yield* Effect.promise(() =>
        web.handler(
          new Request(`http://localhost/connections/org/${INTEGRATION}/${name}`, {
            method: "DELETE",
          }),
          context,
        ),
      );

      expect(response.status).toBe(200);
      // The org row is gone; the user row survives (no shadowing — distinct rows).
      const remaining = yield* executor.connections.list({
        integration: INTEGRATION,
      });
      expect(remaining.map((c) => c.owner).sort()).toEqual(["user"]);
    }),
  );

  it.effect("connection create accepts pasted values payloads", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        plugins: [memoryCredentialsPlugin(), vercelPlugin] as const,
      });
      const executor = yield* createExecutor(config);
      yield* executor.vercel.seed();
      const web = yield* webHandlerFor(executor);
      const context = handlerContextFor(executor);

      const response = yield* Effect.promise(() =>
        web.handler(
          new Request("http://localhost/connections", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              owner: "user",
              name: "api-key",
              integration: "vercel",
              template: "apiKey",
              values: { token: "user-token" },
            }),
          }),
          context,
        ),
      );

      expect(response.status).toBe(200);
      const body = (yield* Effect.promise(() => response.json())) as {
        readonly owner: string;
        readonly name: string;
        readonly provider: string;
      };
      expect(body).toMatchObject({
        owner: "user",
        name: "apiKey",
        provider: "memory",
      });
    }),
  );

  it.effect("connection list returns both owners' rows under one integration", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        plugins: [memoryCredentialsPlugin(), vercelPlugin] as const,
      });
      const executor = yield* createExecutor(config);
      yield* executor.vercel.seed();
      const web = yield* webHandlerFor(executor);
      const context = handlerContextFor(executor);

      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("default"),
        integration: INTEGRATION,
        template: AuthTemplateSlug.make("apiKey"),
        value: "org-token",
      });
      yield* executor.connections.create({
        owner: "user",
        name: ConnectionName.make("personal"),
        integration: INTEGRATION,
        template: AuthTemplateSlug.make("apiKey"),
        value: "user-token",
      });

      const response = yield* Effect.promise(() =>
        web.handler(new Request("http://localhost/connections", { method: "GET" }), context),
      );
      expect(response.status).toBe(200);
      const body = (yield* Effect.promise(() => response.json())) as ReadonlyArray<{
        readonly owner: string;
        readonly name: string;
      }>;
      expect(body.map((c) => `${c.owner}:${c.name}`).sort()).toEqual([
        "org:default",
        "user:personal",
      ]);
    }),
  );
});
