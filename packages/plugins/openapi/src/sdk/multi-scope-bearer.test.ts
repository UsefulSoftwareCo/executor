// ---------------------------------------------------------------------------
// End-to-end shape test for multi-user bearer-token auth on the OpenAPI
// plugin. Models the Vercel-style scenario:
//
//   - An org admin uploads the Vercel OpenAPI spec once. The stored source
//     declares an `Authorization` credential slot, but NOT the token value
//     or even a concrete secret id.
//   - Each user (alice, bob) writes their own personal access token at
//     their own user scope and binds that same slot to their own row.
//   - Invoking a Vercel tool through alice injects alice's token;
//     through bob injects bob's. The org scope never stores a value —
//     per-user scopes are the only source of truth for the bearer.
//
// This is the tier-1 win: the scope-partitioning `SecretProvider` lets
// the same secret id carry a distinct value in each user's scope, so a
// single stored source description serves every user without duplicating
// source rows per tenant.
// ---------------------------------------------------------------------------

import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import { HttpClient, HttpRouter, HttpServerRequest } from "effect/unstable/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";

import {
  collectSchemas,
  createExecutor,
  definePlugin,
  makeInMemoryBlobStore,
  Scope,
  ScopeId,
  SecretId,
  SetSecretInput,
  ToolInvocationError,
  type InvokeOptions,
  type SecretProvider,
} from "@executor-js/sdk";
import { makeMemoryAdapter } from "@executor-js/storage-core/testing/memory";

import { openApiPlugin } from "./plugin";
import { ConfiguredHeaderBinding, OpenApiSourceBindingInput } from "./types";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };

// ---------------------------------------------------------------------------
// Test API — a single endpoint that echoes the Authorization header so the
// test can assert which user's token got injected.
// ---------------------------------------------------------------------------

class EchoHeaders extends Schema.Class<EchoHeaders>("EchoHeaders")({
  authorization: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
}) {}

const ProjectsGroup = HttpApiGroup.make("projects").add(
  HttpApiEndpoint.get("list", "/v9/projects", { success: EchoHeaders }),
);

const VercelApi = HttpApi.make("vercelApi").add(ProjectsGroup);
const specJson = JSON.stringify(OpenApi.fromApi(VercelApi));

const ProjectsGroupLive = HttpApiBuilder.group(VercelApi, "projects", (handlers) =>
  handlers.handle("list", () =>
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(req.url, "http://executor.test");
      return new EchoHeaders({
        authorization: req.headers["authorization"],
        token: url.searchParams.get("token") ?? undefined,
      });
    }),
  ),
);

const ApiLive = HttpApiBuilder.layer(VercelApi).pipe(Layer.provide(ProjectsGroupLive));

const TestLayer = HttpRouter.serve(ApiLive, {
  disableListenLog: true,
  disableLogger: true,
}).pipe(Layer.provideMerge(NodeHttpServer.layerTest));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

layer(TestLayer)("OpenAPI multi-scope bearer (Vercel-style)", (it) => {
  it.effect("admin-added source; each user's per-scope token wins on invocation", () =>
    Effect.gen(function* () {
      // Scope-partitioning in-memory provider. The composite key is
      // what makes the tier-1 fix observable: same secret id, different
      // value per scope. A flat `Map<id, value>` provider would lose
      // one of the users' tokens on the second write.
      const secretStore = new Map<string, string>();
      const key = (scope: string, id: string) => `${scope}\u0000${id}`;
      const memoryProvider: SecretProvider = {
        key: "memory",
        writable: true,
        get: (id, scope) => Effect.sync(() => secretStore.get(key(scope, id)) ?? null),
        set: (id, value, scope) =>
          Effect.sync(() => {
            secretStore.set(key(scope, id), value);
          }),
        delete: (id, scope) => Effect.sync(() => secretStore.delete(key(scope, id))),
      };
      const memorySecretsPlugin = definePlugin(() => ({
        id: "memory-secrets" as const,
        storage: () => ({}),
        secretProviders: [memoryProvider],
      }));

      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);
      const baseUrl = "";
      const plugins = [
        openApiPlugin({ httpClientLayer: clientLayer }),
        memorySecretsPlugin(),
      ] as const;

      // One adapter + blob store backing all three executors: mirrors a
      // multi-tenant deployment where admin + users share infra but
      // each sits at a different scope stack.
      const schema = collectSchemas(plugins);
      const adapter = makeMemoryAdapter({ schema });
      const blobs = makeInMemoryBlobStore();

      const now = new Date();
      const orgScope = new Scope({
        id: ScopeId.make("org"),
        name: "acme-org",
        createdAt: now,
      });
      const aliceScope = new Scope({
        id: ScopeId.make("user-alice"),
        name: "alice",
        createdAt: now,
      });
      const bobScope = new Scope({
        id: ScopeId.make("user-bob"),
        name: "bob",
        createdAt: now,
      });

      const adminExec = yield* createExecutor({
        scopes: [orgScope],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
      });
      const aliceExec = yield* createExecutor({
        scopes: [aliceScope, orgScope],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
      });
      const bobExec = yield* createExecutor({
        scopes: [bobScope, orgScope],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
      });

      // -------------------------------------------------------------
      // 1. Admin adds the Vercel OpenAPI source at org scope. The
      //    stored source declares a credential slot, not a concrete
      //    credential. Each user will bind their own secret to that slot.
      // -------------------------------------------------------------
      yield* adminExec.openapi.addSpec({
        spec: specJson,
        scope: String(orgScope.id),
        namespace: "vercel",
        baseUrl,
        headers: {
          Authorization: new ConfiguredHeaderBinding({
            kind: "binding",
            slot: "auth:vercel_api_token",
            prefix: "Bearer ",
          }),
        },
        queryParams: {
          token: new ConfiguredHeaderBinding({
            kind: "binding",
            slot: "query_param:vercel_team_token",
          }),
        },
      });

      // -------------------------------------------------------------
      // 2. Each user writes their personal access token under the
      //    same secret id, but at their own scope. Tier-1 scope
      //    routing means these coexist in the provider — alice's
      //    write does not overwrite bob's.
      // -------------------------------------------------------------
      yield* aliceExec.secrets.set(
        new SetSecretInput({
          id: SecretId.make("vercel_api_token"),
          scope: aliceScope.id,
          name: "Vercel API Token (alice)",
          value: "alice-vercel-token",
        }),
      );
      yield* aliceExec.secrets.set(
        new SetSecretInput({
          id: SecretId.make("vercel_team_token"),
          scope: aliceScope.id,
          name: "Vercel Team Token (alice)",
          value: "alice-team",
        }),
      );
      yield* bobExec.secrets.set(
        new SetSecretInput({
          id: SecretId.make("vercel_api_token"),
          scope: bobScope.id,
          name: "Vercel API Token (bob)",
          value: "bob-vercel-token",
        }),
      );
      yield* bobExec.secrets.set(
        new SetSecretInput({
          id: SecretId.make("vercel_team_token"),
          scope: bobScope.id,
          name: "Vercel Team Token (bob)",
          value: "bob-team",
        }),
      );

      // -------------------------------------------------------------
      // 3. Each user explicitly binds the inherited source slot at
      //    their own scope. Same secret id, same source, different
      //    binding owner and provider value.
      // -------------------------------------------------------------
      yield* aliceExec.openapi.setSourceBinding(
        new OpenApiSourceBindingInput({
          sourceId: "vercel",
          sourceScope: orgScope.id,
          scope: aliceScope.id,
          slot: "auth:vercel_api_token",
          value: {
            kind: "secret",
            secretId: SecretId.make("vercel_api_token"),
          },
        }),
      );
      yield* aliceExec.openapi.setSourceBinding(
        new OpenApiSourceBindingInput({
          sourceId: "vercel",
          sourceScope: orgScope.id,
          scope: aliceScope.id,
          slot: "query_param:vercel_team_token",
          value: {
            kind: "secret",
            secretId: SecretId.make("vercel_team_token"),
          },
        }),
      );
      yield* bobExec.openapi.setSourceBinding(
        new OpenApiSourceBindingInput({
          sourceId: "vercel",
          sourceScope: orgScope.id,
          scope: bobScope.id,
          slot: "auth:vercel_api_token",
          value: {
            kind: "secret",
            secretId: SecretId.make("vercel_api_token"),
          },
        }),
      );
      yield* bobExec.openapi.setSourceBinding(
        new OpenApiSourceBindingInput({
          sourceId: "vercel",
          sourceScope: orgScope.id,
          scope: bobScope.id,
          slot: "query_param:vercel_team_token",
          value: {
            kind: "secret",
            secretId: SecretId.make("vercel_team_token"),
          },
        }),
      );

      // -------------------------------------------------------------
      // 4. Invoking the shared tool through each user's executor
      //    resolves the nearest credential binding. Alice's scope
      //    yields her token; bob's scope yields his. Same source, same
      //    tool, different injected bearer.
      // -------------------------------------------------------------
      const aliceResult = (yield* aliceExec.tools.invoke(
        "vercel.projects.list",
        {},
        autoApprove,
      )) as {
        data: { authorization?: string; token?: string } | null;
        error: unknown;
      };
      expect(aliceResult.error).toBeNull();
      expect(aliceResult.data?.authorization).toBe("Bearer alice-vercel-token");
      expect(aliceResult.data?.token).toBe("alice-team");

      const bobResult = (yield* bobExec.tools.invoke("vercel.projects.list", {}, autoApprove)) as {
        data: { authorization?: string; token?: string } | null;
        error: unknown;
      };
      expect(bobResult.error).toBeNull();
      expect(bobResult.data?.authorization).toBe("Bearer bob-vercel-token");
      expect(bobResult.data?.token).toBe("bob-team");

      // -------------------------------------------------------------
      // 5. Scope attribution: each user's token is pinned to their
      //    own scope, never smuggled into the org fallback.
      // -------------------------------------------------------------
      const aliceRows = yield* aliceExec.secrets.list();
      const aliceToken = aliceRows.find((r) => String(r.id) === "vercel_api_token");
      expect(String(aliceToken?.scopeId)).toBe("user-alice");

      const bobRows = yield* bobExec.secrets.list();
      const bobToken = bobRows.find((r) => String(r.id) === "vercel_api_token");
      expect(String(bobToken?.scopeId)).toBe("user-bob");

      // Admin's scope never received a token — `get` at the org
      // scope yields null and the source is effectively unusable
      // for the admin role, exactly as designed.
      const adminToken = yield* adminExec.secrets.get("vercel_api_token");
      expect(adminToken).toBeNull();

      // -------------------------------------------------------------
      // 6. Cross-user isolation on enumeration: alice does not see
      //    bob's token row, and vice versa.
      // -------------------------------------------------------------
      const aliceIds = new Set(aliceRows.map((r) => `${String(r.scopeId)}:${String(r.id)}`));
      expect(aliceIds).toContain("user-alice:vercel_api_token");
      expect(aliceIds).not.toContain("user-bob:vercel_api_token");

      const bobIds = new Set(bobRows.map((r) => `${String(r.scopeId)}:${String(r.id)}`));
      expect(bobIds).toContain("user-bob:vercel_api_token");
      expect(bobIds).not.toContain("user-alice:vercel_api_token");
    }),
  );

  it.effect("per-user bindings can point the same shared header slot at different secret ids", () =>
    Effect.gen(function* () {
      const secretStore = new Map<string, string>();
      const key = (scope: string, id: string) => `${scope}\u0000${id}`;
      const memoryProvider: SecretProvider = {
        key: "memory",
        writable: true,
        get: (id, scope) => Effect.sync(() => secretStore.get(key(scope, id)) ?? null),
        set: (id, value, scope) =>
          Effect.sync(() => {
            secretStore.set(key(scope, id), value);
          }),
        delete: (id, scope) => Effect.sync(() => secretStore.delete(key(scope, id))),
      };
      const memorySecretsPlugin = definePlugin(() => ({
        id: "memory-secrets" as const,
        storage: () => ({}),
        secretProviders: [memoryProvider],
      }));

      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);
      const baseUrl = "";
      const plugins = [
        openApiPlugin({ httpClientLayer: clientLayer }),
        memorySecretsPlugin(),
      ] as const;

      const schema = collectSchemas(plugins);
      const adapter = makeMemoryAdapter({ schema });
      const blobs = makeInMemoryBlobStore();

      const now = new Date();
      const orgScope = new Scope({
        id: ScopeId.make("org"),
        name: "acme-org",
        createdAt: now,
      });
      const aliceScope = new Scope({
        id: ScopeId.make("user-alice"),
        name: "alice",
        createdAt: now,
      });
      const bobScope = new Scope({
        id: ScopeId.make("user-bob"),
        name: "bob",
        createdAt: now,
      });

      const adminExec = yield* createExecutor({
        scopes: [orgScope],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
      });
      const aliceExec = yield* createExecutor({
        scopes: [aliceScope, orgScope],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
      });
      const bobExec = yield* createExecutor({
        scopes: [bobScope, orgScope],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
      });

      yield* adminExec.openapi.addSpec({
        spec: specJson,
        scope: String(orgScope.id),
        namespace: "vercel",
        baseUrl,
        headers: {
          Authorization: new ConfiguredHeaderBinding({
            kind: "binding",
            slot: "auth:personal-token",
            prefix: "Bearer ",
          }),
        },
      });

      yield* aliceExec.secrets.set(
        new SetSecretInput({
          id: SecretId.make("alice_vercel_pat"),
          scope: aliceScope.id,
          name: "Alice Vercel PAT",
          value: "alice-vercel-token",
        }),
      );
      yield* bobExec.secrets.set(
        new SetSecretInput({
          id: SecretId.make("bob_vercel_pat"),
          scope: bobScope.id,
          name: "Bob Vercel PAT",
          value: "bob-vercel-token",
        }),
      );

      yield* aliceExec.openapi.setSourceBinding(
        new OpenApiSourceBindingInput({
          sourceId: "vercel",
          sourceScope: orgScope.id,
          scope: aliceScope.id,
          slot: "auth:personal-token",
          value: {
            kind: "secret",
            secretId: SecretId.make("alice_vercel_pat"),
          },
        }),
      );
      yield* bobExec.openapi.setSourceBinding(
        new OpenApiSourceBindingInput({
          sourceId: "vercel",
          sourceScope: orgScope.id,
          scope: bobScope.id,
          slot: "auth:personal-token",
          value: {
            kind: "secret",
            secretId: SecretId.make("bob_vercel_pat"),
          },
        }),
      );

      const aliceResult = (yield* aliceExec.tools.invoke(
        "vercel.projects.list",
        {},
        autoApprove,
      )) as { data: { authorization?: string } | null; error: unknown };
      expect(aliceResult.error).toBeNull();
      expect(aliceResult.data?.authorization).toBe("Bearer alice-vercel-token");

      const bobResult = (yield* bobExec.tools.invoke("vercel.projects.list", {}, autoApprove)) as {
        data: { authorization?: string } | null;
        error: unknown;
      };
      expect(bobResult.error).toBeNull();
      expect(bobResult.data?.authorization).toBe("Bearer bob-vercel-token");
    }),
  );

  it.effect(
    "source binding precedence falls back to shared auth and source deletion clears descendant bindings",
    () =>
      Effect.gen(function* () {
        const secretStore = new Map<string, string>();
        const key = (scope: string, id: string) => `${scope}\u0000${id}`;
        const memoryProvider: SecretProvider = {
          key: "memory",
          writable: true,
          get: (id, scope) => Effect.sync(() => secretStore.get(key(scope, id)) ?? null),
          set: (id, value, scope) =>
            Effect.sync(() => {
              secretStore.set(key(scope, id), value);
            }),
          delete: (id, scope) => Effect.sync(() => secretStore.delete(key(scope, id))),
        };
        const memorySecretsPlugin = definePlugin(() => ({
          id: "memory-secrets" as const,
          storage: () => ({}),
          secretProviders: [memoryProvider],
        }));

        const httpClient = yield* HttpClient.HttpClient;
        const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);
        const baseUrl = "";
        const plugins = [
          openApiPlugin({ httpClientLayer: clientLayer }),
          memorySecretsPlugin(),
        ] as const;

        const schema = collectSchemas(plugins);
        const adapter = makeMemoryAdapter({ schema });
        const blobs = makeInMemoryBlobStore();

        const now = new Date();
        const orgScope = new Scope({
          id: ScopeId.make("org"),
          name: "acme-org",
          createdAt: now,
        });
        const aliceScope = new Scope({
          id: ScopeId.make("user-alice"),
          name: "alice",
          createdAt: now,
        });

        const adminExec = yield* createExecutor({
          scopes: [orgScope],
          adapter,
          blobs,
          plugins,
          onElicitation: "accept-all",
        });
        const aliceExec = yield* createExecutor({
          scopes: [aliceScope, orgScope],
          adapter,
          blobs,
          plugins,
          onElicitation: "accept-all",
        });

        yield* adminExec.openapi.addSpec({
          spec: specJson,
          scope: String(orgScope.id),
          namespace: "vercel",
          baseUrl,
          headers: {
            Authorization: new ConfiguredHeaderBinding({
              kind: "binding",
              slot: "auth:token",
              prefix: "Bearer ",
            }),
          },
        });

        yield* adminExec.secrets.set(
          new SetSecretInput({
            id: SecretId.make("org_vercel_pat"),
            scope: orgScope.id,
            name: "Org Vercel PAT",
            value: "org-token",
          }),
        );
        yield* adminExec.openapi.setSourceBinding(
          new OpenApiSourceBindingInput({
            sourceId: "vercel",
            sourceScope: orgScope.id,
            scope: orgScope.id,
            slot: "auth:token",
            value: {
              kind: "secret",
              secretId: SecretId.make("org_vercel_pat"),
            },
          }),
        );

        const sharedResult = (yield* aliceExec.tools.invoke(
          "vercel.projects.list",
          {},
          autoApprove,
        )) as { data: { authorization?: string } | null; error: unknown };
        expect(sharedResult.error).toBeNull();
        expect(sharedResult.data?.authorization).toBe("Bearer org-token");

        yield* aliceExec.secrets.set(
          new SetSecretInput({
            id: SecretId.make("alice_vercel_pat"),
            scope: aliceScope.id,
            name: "Alice Vercel PAT",
            value: "alice-token",
          }),
        );
        yield* aliceExec.openapi.setSourceBinding(
          new OpenApiSourceBindingInput({
            sourceId: "vercel",
            sourceScope: orgScope.id,
            scope: aliceScope.id,
            slot: "auth:token",
            value: {
              kind: "secret",
              secretId: SecretId.make("alice_vercel_pat"),
            },
          }),
        );

        const overrideResult = (yield* aliceExec.tools.invoke(
          "vercel.projects.list",
          {},
          autoApprove,
        )) as { data: { authorization?: string } | null; error: unknown };
        expect(overrideResult.error).toBeNull();
        expect(overrideResult.data?.authorization).toBe("Bearer alice-token");

        yield* aliceExec.openapi.removeSourceBinding(
          "vercel",
          String(orgScope.id),
          "auth:token",
          String(aliceScope.id),
        );

        const fallbackResult = (yield* aliceExec.tools.invoke(
          "vercel.projects.list",
          {},
          autoApprove,
        )) as { data: { authorization?: string } | null; error: unknown };
        expect(fallbackResult.error).toBeNull();
        expect(fallbackResult.data?.authorization).toBe("Bearer org-token");

        yield* aliceExec.openapi.setSourceBinding(
          new OpenApiSourceBindingInput({
            sourceId: "vercel",
            sourceScope: orgScope.id,
            scope: aliceScope.id,
            slot: "auth:token",
            value: {
              kind: "secret",
              secretId: SecretId.make("alice_vercel_pat"),
            },
          }),
        );

        yield* adminExec.openapi.removeSpec("vercel", String(orgScope.id));
        yield* adminExec.openapi.addSpec({
          spec: specJson,
          scope: String(orgScope.id),
          namespace: "vercel",
          baseUrl,
          headers: {
            Authorization: new ConfiguredHeaderBinding({
              kind: "binding",
              slot: "auth:token",
              prefix: "Bearer ",
            }),
          },
        });

        const bindingsAfterReadd = yield* aliceExec.openapi.listSourceBindings(
          "vercel",
          String(orgScope.id),
        );
        expect(bindingsAfterReadd).toEqual([]);

        const error = yield* Effect.flip(
          aliceExec.tools.invoke("vercel.projects.list", {}, autoApprove),
        );
        expect(error).toBeInstanceOf(ToolInvocationError);
        expect(error).toEqual(
          expect.objectContaining({
            message: expect.stringContaining('Missing binding for header "Authorization"'),
          }),
        );
      }),
  );

  it.effect("user-scope source shadows inherit the org baseUrl", () =>
    Effect.gen(function* () {
      const memorySecretsPlugin = definePlugin(() => ({
        id: "memory-secrets" as const,
        storage: () => ({}),
        secretProviders: [],
      }));

      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);
      const plugins = [
        openApiPlugin({ httpClientLayer: clientLayer }),
        memorySecretsPlugin(),
      ] as const;

      const schema = collectSchemas(plugins);
      const adapter = makeMemoryAdapter({ schema });
      const blobs = makeInMemoryBlobStore();
      const now = new Date();
      const orgScope = new Scope({
        id: ScopeId.make("org"),
        name: "acme-org",
        createdAt: now,
      });
      const aliceScope = new Scope({
        id: ScopeId.make("user-alice"),
        name: "alice",
        createdAt: now,
      });

      const adminExec = yield* createExecutor({
        scopes: [orgScope],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
      });
      const aliceExec = yield* createExecutor({
        scopes: [aliceScope, orgScope],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
      });

      yield* adminExec.openapi.addSpec({
        spec: specJson,
        scope: String(orgScope.id),
        namespace: "vercel",
        baseUrl: "https://api.vercel.example",
      });

      yield* aliceExec.openapi.addSpec({
        spec: specJson,
        scope: String(aliceScope.id),
        namespace: "vercel",
      });

      const source = yield* aliceExec.openapi.getSource("vercel", String(aliceScope.id));
      expect(source?.scope).toBe(aliceScope.id);
      expect(source?.config.baseUrl).toBe("https://api.vercel.example");
    }),
  );

  it.effect(
    "user-scope source shadows resolve inherited org bindings at the org source scope",
    () =>
      Effect.gen(function* () {
        const secretStore = new Map<string, string>();
        const key = (scope: string, id: string) => `${scope}\u0000${id}`;
        const memoryProvider: SecretProvider = {
          key: "memory",
          writable: true,
          get: (id, scope) => Effect.sync(() => secretStore.get(key(scope, id)) ?? null),
          set: (id, value, scope) =>
            Effect.sync(() => {
              secretStore.set(key(scope, id), value);
            }),
          delete: (id, scope) => Effect.sync(() => secretStore.delete(key(scope, id))),
        };
        const memorySecretsPlugin = definePlugin(() => ({
          id: "memory-secrets" as const,
          storage: () => ({}),
          secretProviders: [memoryProvider],
        }));

        const httpClient = yield* HttpClient.HttpClient;
        const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);
        const baseUrl = "";
        const plugins = [
          openApiPlugin({ httpClientLayer: clientLayer }),
          memorySecretsPlugin(),
        ] as const;

        const schema = collectSchemas(plugins);
        const adapter = makeMemoryAdapter({ schema });
        const blobs = makeInMemoryBlobStore();
        const now = new Date();
        const orgScope = new Scope({
          id: ScopeId.make("org"),
          name: "acme-org",
          createdAt: now,
        });
        const aliceScope = new Scope({
          id: ScopeId.make("user-alice"),
          name: "alice",
          createdAt: now,
        });

        const adminExec = yield* createExecutor({
          scopes: [orgScope],
          adapter,
          blobs,
          plugins,
          onElicitation: "accept-all",
        });
        const aliceExec = yield* createExecutor({
          scopes: [aliceScope, orgScope],
          adapter,
          blobs,
          plugins,
          onElicitation: "accept-all",
        });

        yield* adminExec.openapi.addSpec({
          spec: specJson,
          scope: String(orgScope.id),
          namespace: "vercel",
          baseUrl,
          headers: {
            Authorization: new ConfiguredHeaderBinding({
              kind: "binding",
              slot: "auth:token",
              prefix: "Bearer ",
            }),
          },
        });
        yield* aliceExec.openapi.addSpec({
          spec: specJson,
          scope: String(aliceScope.id),
          namespace: "vercel",
        });

        yield* aliceExec.secrets.set(
          new SetSecretInput({
            id: SecretId.make("alice_vercel_pat"),
            scope: aliceScope.id,
            name: "Alice Vercel PAT",
            value: "alice-token",
          }),
        );
        yield* aliceExec.openapi.setSourceBinding(
          new OpenApiSourceBindingInput({
            sourceId: "vercel",
            sourceScope: orgScope.id,
            scope: aliceScope.id,
            slot: "auth:token",
            value: {
              kind: "secret",
              secretId: SecretId.make("alice_vercel_pat"),
            },
          }),
        );

        const result = (yield* aliceExec.tools.invoke("vercel.projects.list", {}, autoApprove)) as {
          data: { authorization?: string } | null;
          error: unknown;
        };
        expect(result.error).toBeNull();
        expect(result.data?.authorization).toBe("Bearer alice-token");
      }),
  );

  it.effect("org binding resolves the org secret even when a user has the same secret id", () =>
    Effect.gen(function* () {
      const secretStore = new Map<string, string>();
      const key = (scope: string, id: string) => `${scope}\u0000${id}`;
      const memoryProvider: SecretProvider = {
        key: "memory",
        writable: true,
        get: (id, scope) => Effect.sync(() => secretStore.get(key(scope, id)) ?? null),
        set: (id, value, scope) =>
          Effect.sync(() => {
            secretStore.set(key(scope, id), value);
          }),
        delete: (id, scope) => Effect.sync(() => secretStore.delete(key(scope, id))),
      };
      const memorySecretsPlugin = definePlugin(() => ({
        id: "memory-secrets" as const,
        storage: () => ({}),
        secretProviders: [memoryProvider],
      }));

      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);
      const plugins = [
        openApiPlugin({ httpClientLayer: clientLayer }),
        memorySecretsPlugin(),
      ] as const;

      const adapter = makeMemoryAdapter({ schema: collectSchemas(plugins) });
      const blobs = makeInMemoryBlobStore();
      const now = new Date();
      const orgScope = new Scope({
        id: ScopeId.make("org"),
        name: "org",
        createdAt: now,
      });
      const userScope = new Scope({
        id: ScopeId.make("user"),
        name: "user",
        createdAt: now,
      });

      const adminExec = yield* createExecutor({
        scopes: [orgScope],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
      });
      const userExec = yield* createExecutor({
        scopes: [userScope, orgScope],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
      });

      yield* adminExec.openapi.addSpec({
        spec: specJson,
        scope: String(orgScope.id),
        namespace: "vercel",
        baseUrl: "",
        headers: {
          Authorization: new ConfiguredHeaderBinding({
            kind: "binding",
            slot: "auth:shared-token",
            prefix: "Bearer ",
          }),
        },
      });
      yield* adminExec.secrets.set(
        new SetSecretInput({
          id: SecretId.make("shared-token"),
          scope: orgScope.id,
          name: "Org token",
          value: "org-token",
        }),
      );
      yield* adminExec.openapi.setSourceBinding(
        new OpenApiSourceBindingInput({
          sourceId: "vercel",
          sourceScope: orgScope.id,
          scope: orgScope.id,
          slot: "auth:shared-token",
          value: { kind: "secret", secretId: SecretId.make("shared-token") },
        }),
      );

      yield* userExec.secrets.set(
        new SetSecretInput({
          id: SecretId.make("shared-token"),
          scope: userScope.id,
          name: "User token with colliding id",
          value: "user-token",
        }),
      );

      const result = (yield* userExec.tools.invoke("vercel.projects.list", {}, autoApprove)) as {
        data: { authorization?: string } | null;
        error: unknown;
      };

      expect(result.error).toBeNull();
      expect(result.data?.authorization).toBe("Bearer org-token");
    }),
  );

  it.effect("personal binding can override the source with an org-owned secret", () =>
    Effect.gen(function* () {
      const secretStore = new Map<string, string>();
      const key = (scope: string, id: string) => `${scope}\u0000${id}`;
      const memoryProvider: SecretProvider = {
        key: "memory",
        writable: true,
        get: (id, scope) => Effect.sync(() => secretStore.get(key(scope, id)) ?? null),
        set: (id, value, scope) =>
          Effect.sync(() => {
            secretStore.set(key(scope, id), value);
          }),
        delete: (id, scope) => Effect.sync(() => secretStore.delete(key(scope, id))),
      };
      const memorySecretsPlugin = definePlugin(() => ({
        id: "memory-secrets" as const,
        storage: () => ({}),
        secretProviders: [memoryProvider],
      }));

      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);
      const plugins = [
        openApiPlugin({ httpClientLayer: clientLayer }),
        memorySecretsPlugin(),
      ] as const;

      const adapter = makeMemoryAdapter({ schema: collectSchemas(plugins) });
      const blobs = makeInMemoryBlobStore();
      const now = new Date();
      const orgScope = new Scope({
        id: ScopeId.make("org"),
        name: "org",
        createdAt: now,
      });
      const userScope = new Scope({
        id: ScopeId.make("user"),
        name: "user",
        createdAt: now,
      });

      const adminExec = yield* createExecutor({
        scopes: [orgScope],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
      });
      const userExec = yield* createExecutor({
        scopes: [userScope, orgScope],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
      });

      yield* adminExec.openapi.addSpec({
        spec: specJson,
        scope: String(orgScope.id),
        namespace: "vercel",
        baseUrl: "",
        headers: {
          Authorization: new ConfiguredHeaderBinding({
            kind: "binding",
            slot: "auth:personal-choice",
            prefix: "Bearer ",
          }),
        },
      });
      yield* adminExec.secrets.set(
        new SetSecretInput({
          id: SecretId.make("org-choice-token"),
          scope: orgScope.id,
          name: "Org choice token",
          value: "org-choice",
        }),
      );

      yield* userExec.openapi.setSourceBinding(
        new OpenApiSourceBindingInput({
          sourceId: "vercel",
          sourceScope: orgScope.id,
          scope: userScope.id,
          slot: "auth:personal-choice",
          value: {
            kind: "secret",
            secretId: SecretId.make("org-choice-token"),
            secretScopeId: orgScope.id,
          },
        }),
      );

      const result = (yield* userExec.tools.invoke("vercel.projects.list", {}, autoApprove)) as {
        data: { authorization?: string } | null;
        error: unknown;
      };

      expect(result.error).toBeNull();
      expect(result.data?.authorization).toBe("Bearer org-choice");
    }),
  );
});
