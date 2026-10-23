import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";

import {
  collectTables,
  ConnectionAddress,
  CredentialId,
  DelegationDeniedError,
  DelegationId,
  DelegationScopeVersion,
  Subject,
  Tenant,
  ToolAddress,
  type DelegationCapability,
  type DelegationContext,
} from "@executor-js/sdk";
import { createSqliteTestFumaDb } from "@executor-js/sdk/testing";

import { ExecutorApi } from "../api";
import { CoreHandlers } from "../handlers";
import { textFailureStrategy, makeExecutionStackMiddleware } from "./execution-stack-middleware";
import { CodeExecutorProvider, EngineDecoratorNoop } from "./execution-stack";
import { DbProvider } from "./executor-fuma-db";
import { HostConfig, PluginsProvider } from "./scoped-executor";
import type { CodeExecutor } from "./execution-stack";
import type { DelegatedPrincipal, IdentityFailure } from "./identity";

const TENANT = "delegation-middleware-tenant";
const TARGET = "verified-human-target";
const MACHINE = "machine-actor";
const ALLOWED_TOOL = ToolAddress.make("tools.example.user.main.allowed");
const ALLOWED_CONNECTION = ConnectionAddress.make("tools.example.user.main");

const makeDelegation = (
  calls: DelegationCapability[],
  actions: readonly ("discover" | "invoke")[] = ["discover", "invoke"],
): DelegationContext => ({
  kind: "delegated",
  tenant: Tenant.make(TENANT),
  grantId: DelegationId.make("grant_middleware"),
  credentialId: CredentialId.make("credential_middleware"),
  actorSubject: Subject.make(MACHINE),
  effectiveSubject: Subject.make(TARGET),
  scopeVersion: DelegationScopeVersion.make("scope_middleware"),
  credentialRef: "machine-reference",
  expiresAt: Date.now() + 60_000,
  scope: {
    actions,
    toolkitMembership: [],
    toolAddresses: [ALLOWED_TOOL],
    connectionAddresses: [ALLOWED_CONNECTION],
  },
  revalidate: (capability) =>
    Effect.gen(function* () {
      calls.push(capability);
      if (capability.operation === "management") {
        return yield* new DelegationDeniedError({
          reason: "management",
          message: "Delegated credentials cannot manage accounts.",
        });
      }
      if (
        (capability.operation === "catalog" || capability.operation === "schema") &&
        !actions.includes("discover")
      ) {
        return yield* new DelegationDeniedError({
          reason: "scope",
          message: "Delegation action is outside the consented scope.",
        });
      }
      if (capability.operation === "invoke" && !actions.includes("invoke")) {
        return yield* new DelegationDeniedError({
          reason: "scope",
          message: "Delegation action is outside the consented scope.",
        });
      }
      if (capability.tool !== undefined && String(capability.tool) !== String(ALLOWED_TOOL)) {
        return yield* new DelegationDeniedError({
          reason: "scope",
          message: "Tool is outside the grant.",
        });
      }
      if (
        capability.connection !== undefined &&
        String(capability.connection) !== String(ALLOWED_CONNECTION)
      ) {
        return yield* new DelegationDeniedError({
          reason: "scope",
          message: "Connection is outside the grant.",
        });
      }
    }),
});

const makePrincipal = (
  delegation: DelegationContext,
  includeContext = true,
): DelegatedPrincipal => ({
  kind: "delegated",
  accountId: TARGET,
  organizationId: TENANT,
  organizationName: "Delegation test tenant",
  email: "",
  name: null,
  avatarUrl: null,
  roles: [],
  orgRoleModel: "organization",
  orgRole: "member",
  tenant: TENANT,
  grantId: String(delegation.grantId),
  credentialId: String(delegation.credentialId),
  credentialRef: delegation.credentialRef,
  actorSubject: MACHINE,
  effectiveSubject: TARGET,
  scopeVersion: String(delegation.scopeVersion),
  ...(includeContext ? { delegation } : {}),
});

const codeExecutor: CodeExecutor = {
  execute: (_code, invoker) =>
    invoker.invoke({ path: "example.user.main.allowed", args: {} }).pipe(
      Effect.map((result) => ({ result, logs: [] })),
      Effect.catchCause(() => Effect.succeed({ result: null, logs: [] })),
    ),
};

const managementProbe = (hits: string[]) =>
  HttpRouter.addAll([
    HttpRouter.route(
      "GET",
      "/account/api-keys",
      Effect.sync(() => {
        hits.push("account");
        return HttpServerResponse.empty();
      }),
    ),
    HttpRouter.route(
      "GET",
      "/admin/users",
      Effect.sync(() => {
        hits.push("admin");
        return HttpServerResponse.empty();
      }),
    ),
    HttpRouter.route(
      "*",
      "/*",
      Effect.sync(() => {
        hits.push("fallback");
        return HttpServerResponse.empty();
      }),
    ),
  ]);

const makeHandler = async (
  calls: DelegationCapability[],
  hits: string[],
  includeContext = true,
  actions: readonly ("discover" | "invoke")[] = ["discover", "invoke"],
) => {
  const db = await createSqliteTestFumaDb({ tables: collectTables() });
  const delegation = makeDelegation(calls, actions);
  const ExecutionMiddleware = makeExecutionStackMiddleware<
    readonly [],
    IdentityFailure,
    never,
    never,
    never,
    never
  >({
    plugins: [],
    authenticate: () => Effect.succeed(makePrincipal(delegation, includeContext)),
    strategy: textFailureStrategy,
    stackLayer: Layer.mergeAll(
      Layer.succeed(DbProvider)({ db: db.db, fuma: db.fuma, close: db.close }),
      Layer.succeed(PluginsProvider)({ plugins: () => [] }),
      Layer.succeed(HostConfig)({ allowLocalNetwork: false, oauthCallbackPath: "/oauth/callback" }),
      Layer.succeed(CodeExecutorProvider)(codeExecutor),
      EngineDecoratorNoop,
    ),
  });
  const api = HttpApiBuilder.layer(ExecutorApi).pipe(Layer.provide(CoreHandlers));
  const app = Layer.merge(api, managementProbe(hits)).pipe(
    Layer.provide(ExecutionMiddleware.layer),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
  );
  const web = HttpRouter.toWebHandler(app, { disableLogger: true });
  return {
    handler: web.handler,
    dispose: async () => {
      await web.dispose();
      await db.close();
    },
  };
};

describe("delegated HTTP execution middleware", () => {
  it("rejects management and account/admin paths before handlers or storage", async () => {
    const calls: DelegationCapability[] = [];
    const hits: string[] = [];
    const web = await makeHandler(calls, hits);
    await (async () => {
      const requests: readonly [string, string, string?][] = [
        ["GET", "/account/api-keys", "account"],
        ["GET", "/admin/users", "admin"],
        ["POST", "/connections", "connections"],
        ["GET", "/integrations", "integrations"],
        ["POST", "/oauth/clients", "oauth"],
        ["GET", "/providers", "providers"],
        ["POST", "/policies", "policies"],
        ["POST", "/artifacts", "artifacts"],
        ["POST", "/api/%61dmin/users"],
        ["GET", "/api%2Faccount%2Fapi-keys"],
        ["GET", "/api/organizations/org_1/tools"],
      ];
      for (const [method, path] of requests) {
        const response = await web.handler(
          new Request(`http://test.local${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body: method === "POST" ? "{}" : undefined,
          }),
          Context.empty(),
        );
        expect(response.status, `${method} ${path}`).toBe(403);
      }
      expect(hits).toEqual([]);
      expect(calls).toEqual([]);
    })().finally(() => web.dispose());
  });

  it("rejects delegated identity without live context before ordinary tools", async () => {
    const calls: DelegationCapability[] = [];
    const hits: string[] = [];
    const web = await makeHandler(calls, hits, false);
    const response = await web.handler(new Request("http://test.local/tools"), Context.empty());
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
    expect(hits).toEqual([]);
    await web.dispose();
  });

  it("passes tool discovery, schema and execution through the scoped executor", async () => {
    const calls: DelegationCapability[] = [];
    const hits: string[] = [];
    const web = await makeHandler(calls, hits);
    await (async () => {
      const list = await web.handler(new Request("http://test.local/tools"), Context.empty());
      expect(list.status).toBe(200);

      const schema = await web.handler(
        new Request(
          `http://test.local/tools/schema?address=${encodeURIComponent(String(ALLOWED_TOOL))}`,
        ),
        Context.empty(),
      );
      expect(schema.status).toBe(404);

      const execution = await web.handler(
        new Request("http://test.local/executions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: "return await tools.example.user.main.allowed({})" }),
        }),
        Context.empty(),
      );
      expect(execution.status).not.toBe(403);
      expect(calls.map((call) => call.operation)).toEqual(
        expect.arrayContaining(["catalog", "schema", "invoke"]),
      );
      expect(
        calls.some(
          (call) =>
            call.operation === "schema" && String(call.connection) === String(ALLOWED_CONNECTION),
        ),
      ).toBe(true);
      expect(
        calls.some(
          (call) =>
            call.operation === "invoke" && String(call.connection) === String(ALLOWED_CONNECTION),
        ),
      ).toBe(true);

      const resume = await web.handler(
        new Request("http://test.local/executions/unknown/resume", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "decline" }),
        }),
        Context.empty(),
      );
      expect(resume.status).toBe(410);
    })().finally(() => web.dispose());
  });

  it("renders an invoke-only catalog denial as a safe HTTP 403", async () => {
    const calls: DelegationCapability[] = [];
    const hits: string[] = [];
    const web = await makeHandler(calls, hits, true, ["invoke"]);
    await (async () => {
      const response = await web.handler(new Request("http://test.local/tools"), Context.empty());
      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body).not.toContain("DelegationDeniedError");
      expect(body).not.toContain("Delegation action is outside the consented scope.");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.operation).toBe("catalog");
      expect(hits).toEqual([]);
    })().finally(() => web.dispose());
  });
});
