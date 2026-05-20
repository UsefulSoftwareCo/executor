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

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpServerRequest } from "effect/unstable/http";

import {
  createExecutor,
  definePlugin,
  Scope,
  ScopeId,
  SecretId,
  SetSecretInput,
  SetSourceCredentialBindingInput,
  RemoveSourceCredentialBindingInput,
  type InvokeOptions,
  type SecretProvider,
} from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";
import {
  addOpenApiTestSource,
  makeOpenApiTestSourceConfig,
  serveOpenApiHttpApiTestServer,
  unwrapInvocation,
} from "@executor-js/plugin-openapi/testing";

import { openApiPlugin } from "./plugin";
import { ConfiguredHeaderBinding } from "./types";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };

// ---------------------------------------------------------------------------
// Test API — a single endpoint that echoes the Authorization header so the
// test can assert which user's token got injected.
// ---------------------------------------------------------------------------

const EchoHeaders = Schema.Struct({
  authorization: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
});
type EchoHeaders = typeof EchoHeaders.Type;

const ProjectsGroup = HttpApiGroup.make("projects").add(
  HttpApiEndpoint.get("list", "/v9/projects", { success: EchoHeaders }),
);

const VercelApi = HttpApi.make("vercelApi").add(ProjectsGroup);

const ProjectsGroupLive = HttpApiBuilder.group(VercelApi, "projects", (handlers) =>
  handlers.handle("list", () =>
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(req.url, "http://executor.test");
      return EchoHeaders.make({
        authorization: req.headers["authorization"],
        token: url.searchParams.get("token") ?? undefined,
      });
    }),
  ),
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAPI multi-scope bearer (Vercel-style)", () => {
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

      const openApiServer = yield* serveOpenApiHttpApiTestServer({
        api: VercelApi,
        handlersLayer: ProjectsGroupLive,
      });
      const clientLayer = FetchHttpClient.layer;
      const plugins = [
        openApiPlugin({ httpClientLayer: clientLayer }),
        memorySecretsPlugin(),
      ] as const;

      // One adapter + blob store backing all three executors: mirrors a
      // multi-tenant deployment where admin + users share infra but
      // each sits at a different scope stack.
      const config = makeTestConfig({ plugins });

      const now = new Date();
      const orgScope = Scope.make({
        id: ScopeId.make("org"),
        name: "acme-org",
        createdAt: now,
      });
      const aliceScope = Scope.make({
        id: ScopeId.make("user-alice"),
        name: "alice",
        createdAt: now,
      });
      const bobScope = Scope.make({
        id: ScopeId.make("user-bob"),
        name: "bob",
        createdAt: now,
      });

      const adminExec = yield* createExecutor({
        ...config,
        scopes: [orgScope],
        plugins,
        onElicitation: "accept-all",
      });
      const aliceExec = yield* createExecutor({
        ...config,
        scopes: [aliceScope, orgScope],
        plugins,
        onElicitation: "accept-all",
      });
      const bobExec = yield* createExecutor({
        ...config,
        scopes: [bobScope, orgScope],
        plugins,
        onElicitation: "accept-all",
      });

      // -------------------------------------------------------------
      // 1. Admin adds the Vercel OpenAPI source at org scope. The
      //    stored source declares a credential slot, not a concrete
      //    credential. Each user will bind their own secret to that slot.
      // -------------------------------------------------------------
      yield* addOpenApiTestSource(adminExec, openApiServer, {
        scope: String(orgScope.id),
        namespace: "vercel",
        headers: {
          Authorization: ConfiguredHeaderBinding.make({
            kind: "binding",
            slot: "auth:vercel_api_token",
            prefix: "Bearer ",
          }),
        },
        queryParams: {
          token: ConfiguredHeaderBinding.make({
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
        SetSecretInput.make({
          id: SecretId.make("vercel_api_token"),
          scope: aliceScope.id,
          name: "Vercel API Token (alice)",
          value: "alice-vercel-token",
        }),
      );
      yield* aliceExec.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("vercel_team_token"),
          scope: aliceScope.id,
          name: "Vercel Team Token (alice)",
          value: "alice-team",
        }),
      );
      yield* bobExec.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("vercel_api_token"),
          scope: bobScope.id,
          name: "Vercel API Token (bob)",
          value: "bob-vercel-token",
        }),
      );
      yield* bobExec.secrets.set(
        SetSecretInput.make({
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
      yield* aliceExec.sources.setBinding(
        SetSourceCredentialBindingInput.make({
          source: { id: "vercel", scope: orgScope.id },
          scope: aliceScope.id,
          slotKey: "auth:vercel_api_token",
          value: {
            kind: "secret",
            secretId: SecretId.make("vercel_api_token"),
          },
        }),
      );
      yield* aliceExec.sources.setBinding(
        SetSourceCredentialBindingInput.make({
          source: { id: "vercel", scope: orgScope.id },
          scope: aliceScope.id,
          slotKey: "query_param:vercel_team_token",
          value: {
            kind: "secret",
            secretId: SecretId.make("vercel_team_token"),
          },
        }),
      );
      yield* bobExec.sources.setBinding(
        SetSourceCredentialBindingInput.make({
          source: { id: "vercel", scope: orgScope.id },
          scope: bobScope.id,
          slotKey: "auth:vercel_api_token",
          value: {
            kind: "secret",
            secretId: SecretId.make("vercel_api_token"),
          },
        }),
      );
      yield* bobExec.sources.setBinding(
        SetSourceCredentialBindingInput.make({
          source: { id: "vercel", scope: orgScope.id },
          scope: bobScope.id,
          slotKey: "query_param:vercel_team_token",
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
      const aliceResult = unwrapInvocation(
        yield* aliceExec.tools.invoke("vercel.projects.list", {}, autoApprove),
      );
      expect(aliceResult.error).toBeNull();
      const aliceData = aliceResult.data as EchoHeaders | null;
      expect(aliceData?.authorization).toBe("Bearer alice-vercel-token");
      expect(aliceData?.token).toBe("alice-team");

      const bobResult = unwrapInvocation(
        yield* bobExec.tools.invoke("vercel.projects.list", {}, autoApprove),
      );
      expect(bobResult.error).toBeNull();
      const bobData = bobResult.data as EchoHeaders | null;
      expect(bobData?.authorization).toBe("Bearer bob-vercel-token");
      expect(bobData?.token).toBe("bob-team");

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

      const openApiServer = yield* serveOpenApiHttpApiTestServer({
        api: VercelApi,
        handlersLayer: ProjectsGroupLive,
      });
      const clientLayer = FetchHttpClient.layer;
      const plugins = [
        openApiPlugin({ httpClientLayer: clientLayer }),
        memorySecretsPlugin(),
      ] as const;
      const config = makeTestConfig({ plugins });

      const now = new Date();
      const orgScope = Scope.make({
        id: ScopeId.make("org"),
        name: "acme-org",
        createdAt: now,
      });
      const aliceScope = Scope.make({
        id: ScopeId.make("user-alice"),
        name: "alice",
        createdAt: now,
      });
      const bobScope = Scope.make({
        id: ScopeId.make("user-bob"),
        name: "bob",
        createdAt: now,
      });

      const adminExec = yield* createExecutor({
        ...config,
        scopes: [orgScope],
        plugins,
        onElicitation: "accept-all",
      });
      const aliceExec = yield* createExecutor({
        ...config,
        scopes: [aliceScope, orgScope],
        plugins,
        onElicitation: "accept-all",
      });
      const bobExec = yield* createExecutor({
        ...config,
        scopes: [bobScope, orgScope],
        plugins,
        onElicitation: "accept-all",
      });

      yield* addOpenApiTestSource(adminExec, openApiServer, {
        scope: String(orgScope.id),
        namespace: "vercel",
        headers: {
          Authorization: ConfiguredHeaderBinding.make({
            kind: "binding",
            slot: "auth:personal-token",
            prefix: "Bearer ",
          }),
        },
      });

      yield* aliceExec.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("alice_vercel_pat"),
          scope: aliceScope.id,
          name: "Alice Vercel PAT",
          value: "alice-vercel-token",
        }),
      );
      yield* bobExec.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("bob_vercel_pat"),
          scope: bobScope.id,
          name: "Bob Vercel PAT",
          value: "bob-vercel-token",
        }),
      );

      yield* aliceExec.sources.setBinding(
        SetSourceCredentialBindingInput.make({
          source: { id: "vercel", scope: orgScope.id },
          scope: aliceScope.id,
          slotKey: "auth:personal-token",
          value: {
            kind: "secret",
            secretId: SecretId.make("alice_vercel_pat"),
          },
        }),
      );
      yield* bobExec.sources.setBinding(
        SetSourceCredentialBindingInput.make({
          source: { id: "vercel", scope: orgScope.id },
          scope: bobScope.id,
          slotKey: "auth:personal-token",
          value: {
            kind: "secret",
            secretId: SecretId.make("bob_vercel_pat"),
          },
        }),
      );

      const aliceResult = unwrapInvocation(
        yield* aliceExec.tools.invoke("vercel.projects.list", {}, autoApprove),
      );
      expect(aliceResult.error).toBeNull();
      expect((aliceResult.data as EchoHeaders | null)?.authorization).toBe(
        "Bearer alice-vercel-token",
      );

      const bobResult = unwrapInvocation(
        yield* bobExec.tools.invoke("vercel.projects.list", {}, autoApprove),
      );
      expect(bobResult.error).toBeNull();
      expect((bobResult.data as EchoHeaders | null)?.authorization).toBe("Bearer bob-vercel-token");
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

        const openApiServer = yield* serveOpenApiHttpApiTestServer({
          api: VercelApi,
          handlersLayer: ProjectsGroupLive,
        });
        const clientLayer = FetchHttpClient.layer;
        const plugins = [
          openApiPlugin({ httpClientLayer: clientLayer }),
          memorySecretsPlugin(),
        ] as const;
        const config = makeTestConfig({ plugins });

        const now = new Date();
        const orgScope = Scope.make({
          id: ScopeId.make("org"),
          name: "acme-org",
          createdAt: now,
        });
        const aliceScope = Scope.make({
          id: ScopeId.make("user-alice"),
          name: "alice",
          createdAt: now,
        });

        const adminExec = yield* createExecutor({
          ...config,
          scopes: [orgScope],
          plugins,
          onElicitation: "accept-all",
        });
        const aliceExec = yield* createExecutor({
          ...config,
          scopes: [aliceScope, orgScope],
          plugins,
          onElicitation: "accept-all",
        });

        yield* addOpenApiTestSource(adminExec, openApiServer, {
          scope: String(orgScope.id),
          namespace: "vercel",
          headers: {
            Authorization: ConfiguredHeaderBinding.make({
              kind: "binding",
              slot: "auth:token",
              prefix: "Bearer ",
            }),
          },
        });

        yield* adminExec.secrets.set(
          SetSecretInput.make({
            id: SecretId.make("org_vercel_pat"),
            scope: orgScope.id,
            name: "Org Vercel PAT",
            value: "org-token",
          }),
        );
        yield* adminExec.sources.setBinding(
          SetSourceCredentialBindingInput.make({
            source: { id: "vercel", scope: orgScope.id },
            scope: orgScope.id,
            slotKey: "auth:token",
            value: {
              kind: "secret",
              secretId: SecretId.make("org_vercel_pat"),
            },
          }),
        );

        const sharedResult = unwrapInvocation(
          yield* aliceExec.tools.invoke("vercel.projects.list", {}, autoApprove),
        );
        expect(sharedResult.error).toBeNull();
        expect((sharedResult.data as EchoHeaders | null)?.authorization).toBe("Bearer org-token");

        yield* aliceExec.secrets.set(
          SetSecretInput.make({
            id: SecretId.make("alice_vercel_pat"),
            scope: aliceScope.id,
            name: "Alice Vercel PAT",
            value: "alice-token",
          }),
        );
        yield* aliceExec.sources.setBinding(
          SetSourceCredentialBindingInput.make({
            source: { id: "vercel", scope: orgScope.id },
            scope: aliceScope.id,
            slotKey: "auth:token",
            value: {
              kind: "secret",
              secretId: SecretId.make("alice_vercel_pat"),
            },
          }),
        );

        const overrideResult = unwrapInvocation(
          yield* aliceExec.tools.invoke("vercel.projects.list", {}, autoApprove),
        );
        expect(overrideResult.error).toBeNull();
        expect((overrideResult.data as EchoHeaders | null)?.authorization).toBe(
          "Bearer alice-token",
        );

        yield* aliceExec.sources.removeBinding(
          RemoveSourceCredentialBindingInput.make({
            source: { id: "vercel", scope: orgScope.id },
            slotKey: "auth:token",
            scope: aliceScope.id,
          }),
        );

        const fallbackResult = unwrapInvocation(
          yield* aliceExec.tools.invoke("vercel.projects.list", {}, autoApprove),
        );
        expect(fallbackResult.error).toBeNull();
        expect((fallbackResult.data as EchoHeaders | null)?.authorization).toBe("Bearer org-token");

        yield* aliceExec.sources.setBinding(
          SetSourceCredentialBindingInput.make({
            source: { id: "vercel", scope: orgScope.id },
            scope: aliceScope.id,
            slotKey: "auth:token",
            value: {
              kind: "secret",
              secretId: SecretId.make("alice_vercel_pat"),
            },
          }),
        );

        yield* adminExec.openapi.removeSpec("vercel", String(orgScope.id));
        yield* addOpenApiTestSource(adminExec, openApiServer, {
          scope: String(orgScope.id),
          namespace: "vercel",
          headers: {
            Authorization: ConfiguredHeaderBinding.make({
              kind: "binding",
              slot: "auth:token",
              prefix: "Bearer ",
            }),
          },
        });

        const bindingsAfterReadd = yield* aliceExec.sources.listBindings({
          source: { id: "vercel", scope: orgScope.id },
        });
        expect(bindingsAfterReadd).toEqual([]);

        const result = yield* aliceExec.tools.invoke("vercel.projects.list", {}, autoApprove);
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "credential_binding_missing",
            message: expect.stringContaining('Missing binding for header "Authorization"'),
            details: {
              category: "authentication",
              credential: {
                label: "Authorization",
                slotKey: "auth:token",
              },
            },
          },
        });
      }),
  );

  it.effect("user-scope source shadows inherit the org baseUrl", () =>
    Effect.gen(function* () {
      const memorySecretsPlugin = definePlugin(() => ({
        id: "memory-secrets" as const,
        storage: () => ({}),
        secretProviders: [],
      }));

      const openApiServer = yield* serveOpenApiHttpApiTestServer({
        api: VercelApi,
        handlersLayer: ProjectsGroupLive,
      });
      const clientLayer = FetchHttpClient.layer;
      const plugins = [
        openApiPlugin({ httpClientLayer: clientLayer }),
        memorySecretsPlugin(),
      ] as const;
      const config = makeTestConfig({ plugins });
      const now = new Date();
      const orgScope = Scope.make({
        id: ScopeId.make("org"),
        name: "acme-org",
        createdAt: now,
      });
      const aliceScope = Scope.make({
        id: ScopeId.make("user-alice"),
        name: "alice",
        createdAt: now,
      });

      const adminExec = yield* createExecutor({
        ...config,
        scopes: [orgScope],
        plugins,
        onElicitation: "accept-all",
      });
      const aliceExec = yield* createExecutor({
        ...config,
        scopes: [aliceScope, orgScope],
        plugins,
        onElicitation: "accept-all",
      });

      yield* adminExec.openapi.addSpec(
        makeOpenApiTestSourceConfig(openApiServer, {
          scope: String(orgScope.id),
          namespace: "vercel",
          baseUrl: "https://api.vercel.example",
        }),
      );

      yield* addOpenApiTestSource(aliceExec, openApiServer, {
        scope: String(aliceScope.id),
        namespace: "vercel",
        baseUrl: null,
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

        const openApiServer = yield* serveOpenApiHttpApiTestServer({
          api: VercelApi,
          handlersLayer: ProjectsGroupLive,
        });
        const clientLayer = FetchHttpClient.layer;
        const plugins = [
          openApiPlugin({ httpClientLayer: clientLayer }),
          memorySecretsPlugin(),
        ] as const;
        const config = makeTestConfig({ plugins });
        const now = new Date();
        const orgScope = Scope.make({
          id: ScopeId.make("org"),
          name: "acme-org",
          createdAt: now,
        });
        const aliceScope = Scope.make({
          id: ScopeId.make("user-alice"),
          name: "alice",
          createdAt: now,
        });

        const adminExec = yield* createExecutor({
          ...config,
          scopes: [orgScope],
          plugins,
          onElicitation: "accept-all",
        });
        const aliceExec = yield* createExecutor({
          ...config,
          scopes: [aliceScope, orgScope],
          plugins,
          onElicitation: "accept-all",
        });

        yield* addOpenApiTestSource(adminExec, openApiServer, {
          scope: String(orgScope.id),
          namespace: "vercel",
          headers: {
            Authorization: ConfiguredHeaderBinding.make({
              kind: "binding",
              slot: "auth:token",
              prefix: "Bearer ",
            }),
          },
        });
        yield* addOpenApiTestSource(aliceExec, openApiServer, {
          scope: String(aliceScope.id),
          namespace: "vercel",
          baseUrl: null,
        });

        yield* aliceExec.secrets.set(
          SetSecretInput.make({
            id: SecretId.make("alice_vercel_pat"),
            scope: aliceScope.id,
            name: "Alice Vercel PAT",
            value: "alice-token",
          }),
        );
        yield* aliceExec.sources.setBinding(
          SetSourceCredentialBindingInput.make({
            source: { id: "vercel", scope: orgScope.id },
            scope: aliceScope.id,
            slotKey: "auth:token",
            value: {
              kind: "secret",
              secretId: SecretId.make("alice_vercel_pat"),
            },
          }),
        );

        const result = unwrapInvocation(
          yield* aliceExec.tools.invoke("vercel.projects.list", {}, autoApprove),
        );
        expect(result.error).toBeNull();
        expect((result.data as EchoHeaders | null)?.authorization).toBe("Bearer alice-token");
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

      const openApiServer = yield* serveOpenApiHttpApiTestServer({
        api: VercelApi,
        handlersLayer: ProjectsGroupLive,
      });
      const clientLayer = FetchHttpClient.layer;
      const plugins = [
        openApiPlugin({ httpClientLayer: clientLayer }),
        memorySecretsPlugin(),
      ] as const;
      const config = makeTestConfig({ plugins });
      const now = new Date();
      const orgScope = Scope.make({
        id: ScopeId.make("org"),
        name: "org",
        createdAt: now,
      });
      const userScope = Scope.make({
        id: ScopeId.make("user"),
        name: "user",
        createdAt: now,
      });

      const adminExec = yield* createExecutor({
        ...config,
        scopes: [orgScope],
        plugins,
        onElicitation: "accept-all",
      });
      const userExec = yield* createExecutor({
        ...config,
        scopes: [userScope, orgScope],
        plugins,
        onElicitation: "accept-all",
      });

      yield* addOpenApiTestSource(adminExec, openApiServer, {
        scope: String(orgScope.id),
        namespace: "vercel",
        headers: {
          Authorization: ConfiguredHeaderBinding.make({
            kind: "binding",
            slot: "auth:shared-token",
            prefix: "Bearer ",
          }),
        },
      });
      yield* adminExec.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("shared-token"),
          scope: orgScope.id,
          name: "Org token",
          value: "org-token",
        }),
      );
      yield* adminExec.sources.setBinding(
        SetSourceCredentialBindingInput.make({
          source: { id: "vercel", scope: orgScope.id },
          scope: orgScope.id,
          slotKey: "auth:shared-token",
          value: { kind: "secret", secretId: SecretId.make("shared-token") },
        }),
      );

      yield* userExec.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("shared-token"),
          scope: userScope.id,
          name: "User token with colliding id",
          value: "user-token",
        }),
      );

      const result = unwrapInvocation(
        yield* userExec.tools.invoke("vercel.projects.list", {}, autoApprove),
      );

      expect(result.error).toBeNull();
      expect((result.data as EchoHeaders | null)?.authorization).toBe("Bearer org-token");
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

      const openApiServer = yield* serveOpenApiHttpApiTestServer({
        api: VercelApi,
        handlersLayer: ProjectsGroupLive,
      });
      const clientLayer = FetchHttpClient.layer;
      const plugins = [
        openApiPlugin({ httpClientLayer: clientLayer }),
        memorySecretsPlugin(),
      ] as const;
      const config = makeTestConfig({ plugins });
      const now = new Date();
      const orgScope = Scope.make({
        id: ScopeId.make("org"),
        name: "org",
        createdAt: now,
      });
      const userScope = Scope.make({
        id: ScopeId.make("user"),
        name: "user",
        createdAt: now,
      });

      const adminExec = yield* createExecutor({
        ...config,
        scopes: [orgScope],
        plugins,
        onElicitation: "accept-all",
      });
      const userExec = yield* createExecutor({
        ...config,
        scopes: [userScope, orgScope],
        plugins,
        onElicitation: "accept-all",
      });

      yield* addOpenApiTestSource(adminExec, openApiServer, {
        scope: String(orgScope.id),
        namespace: "vercel",
        headers: {
          Authorization: ConfiguredHeaderBinding.make({
            kind: "binding",
            slot: "auth:personal-choice",
            prefix: "Bearer ",
          }),
        },
      });
      yield* adminExec.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("org-choice-token"),
          scope: orgScope.id,
          name: "Org choice token",
          value: "org-choice",
        }),
      );

      yield* userExec.sources.setBinding(
        SetSourceCredentialBindingInput.make({
          source: { id: "vercel", scope: orgScope.id },
          scope: userScope.id,
          slotKey: "auth:personal-choice",
          value: {
            kind: "secret",
            secretId: SecretId.make("org-choice-token"),
            secretScopeId: orgScope.id,
          },
        }),
      );

      const result = unwrapInvocation(
        yield* userExec.tools.invoke("vercel.projects.list", {}, autoApprove),
      );

      expect(result.error).toBeNull();
      expect((result.data as EchoHeaders | null)?.authorization).toBe("Bearer org-choice");
    }),
  );
});
