import { HttpApiSwagger } from "effect/unstable/httpapi";
import { Effect, Layer } from "effect";

import {
  composePluginApi,
  ExecutorApp,
  IdentityProvider,
  type Principal,
  textFailureStrategy,
  Unauthorized,
} from "@executor-js/api/server";
import {
  authenticated,
  McpAuthProvider,
  unauthorized,
  type AuthOutcome,
} from "@executor-js/host-mcp";

import { createSelfHostDb, SelfHostDb, SelfHostDbProvider } from "../db/self-host-db";
import {
  SelfHostCodeExecutorProvider,
  SelfHostHostConfig,
  SelfHostPluginsProvider,
} from "../execution";
import { loadConfig, SELF_HOST_NAMESPACE, SELF_HOST_SCHEMA_VERSION } from "../config";
import {
  makeSelfHostMcpSessionStore,
  selfHostMcpReporter,
  selfHostMcpSessions,
} from "../mcp/session-store";
import { selfHostPlugins } from "../plugins";
import { ErrorCaptureLive } from "../observability";

// ===========================================================================
// Self-host TEST harness — the throwaway composition tests use to exercise the
// shared app graph WITHOUT booting Better Auth.
//
// Production (`makeSelfHostApp`) is unconditional: it always builds Better Auth
// over the libSQL file, mounts the account API, and serves the real MCP OAuth
// seam. Tests that don't need a real auth backend (scope-stack isolation, the
// QuickJS sandbox, encrypted-secret-at-rest) want a trivial, deterministic
// identity and no auth secret. That test-only wiring used to live in production
// behind `if (injectedIdentity)` branches; it now lives HERE.
//
// `makeSelfHostTestApp` composes `ExecutorApp.make` directly with:
//   - a test `IdentityProvider` (single-admin or header-driven),
//   - a stub `McpAuthProvider` (no OAuth Authorization Server; authenticate via
//     the same injected identity),
//   - NO account API (Better Auth is never constructed),
//   - a throwaway libSQL path.
//
// Tests that DO need the real Better Auth backend (multi-user sign-up, the MCP
// OAuth DCR -> authorize -> token flow) use the production `makeSelfHostApiHandler`
// instead — that path is the honest unconditional composition.
// ===========================================================================

// ---------------------------------------------------------------------------
// Test identities — trivial `IdentityProvider` implementations of the shared
// tag. The single-admin one resolves every request to one configured admin; the
// header-driven one reads the identity from request headers so a single handler
// can serve many distinct identities concurrently (cross-fiber scope-leak test).
// ---------------------------------------------------------------------------

export interface SingleAdminOptions {
  readonly userId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly email?: string;
}

/** Every request is the configured single admin. */
export const singleAdminIdentityLayer = (
  options: SingleAdminOptions,
): Layer.Layer<IdentityProvider> =>
  Layer.succeed(
    IdentityProvider,
    IdentityProvider.of({
      authenticate: () =>
        Effect.succeed<Principal>({
          accountId: options.userId,
          organizationId: options.organizationId,
          organizationName: options.organizationName,
          email: options.email ?? "admin@localhost",
          name: "Admin",
          avatarUrl: null,
          roles: ["admin"],
        }),
    }),
  );

/**
 * Resolve the identity from `x-test-user` / `x-test-org` headers (missing either
 * -> `Unauthorized`). Lets one handler serve many identities concurrently.
 */
export const headerIdentityLayer: Layer.Layer<IdentityProvider> = Layer.succeed(
  IdentityProvider,
  IdentityProvider.of({
    authenticate: (request) => {
      const userId = request.headers.get("x-test-user");
      const organizationId = request.headers.get("x-test-org");
      if (!userId || !organizationId) return Effect.fail(new Unauthorized());
      return Effect.succeed<Principal>({
        accountId: userId,
        organizationId,
        organizationName: `Org ${organizationId}`,
        email: `${userId}@test`,
        name: userId,
        avatarUrl: null,
        roles: ["admin"],
      });
    },
  }),
);

// ---------------------------------------------------------------------------
// Stub McpAuthProvider — no OAuth Authorization Server, so the declared metadata
// docs 404; authentication delegates to the injected test `IdentityProvider`.
// Keeps /mcp mountable under the test composition without Better Auth.
// ---------------------------------------------------------------------------

const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

const resourceMetadataUrlFor = (request: Request): string =>
  `${new URL(request.url).origin}${PROTECTED_RESOURCE_METADATA_PATH}`;

const notFoundResponse = (): Effect.Effect<Response> =>
  Effect.sync(() => new Response("Not Found", { status: 404 }));

const stubMcpAuth: Layer.Layer<McpAuthProvider, never, IdentityProvider> = Layer.effect(
  McpAuthProvider,
  Effect.gen(function* () {
    const fallback = yield* IdentityProvider;
    const challengeFor = (request: Request): string =>
      `Bearer resource_metadata="${resourceMetadataUrlFor(request)}"`;
    return {
      discoveryRoutes: [
        { path: PROTECTED_RESOURCE_METADATA_PATH, handler: notFoundResponse },
        { path: AUTHORIZATION_SERVER_METADATA_PATH, handler: notFoundResponse },
      ],
      resourceMetadataUrl: resourceMetadataUrlFor,
      authenticate: (request: Request): Effect.Effect<AuthOutcome> =>
        fallback.authenticate(request).pipe(
          Effect.map((principal) =>
            principal ? authenticated(principal) : unauthorized(challengeFor(request)),
          ),
          Effect.catchTags({
            Unauthorized: () => Effect.succeed(unauthorized(challengeFor(request))),
            NoOrganization: () => Effect.succeed(unauthorized(challengeFor(request))),
          }),
        ),
    };
  }),
);

// ---------------------------------------------------------------------------
// makeSelfHostTestApp — the same `ExecutorApp.make` composition the production
// app uses, but with the test identity + stub MCP auth + no account, over a
// throwaway libSQL file. Returns the same `{ handler, dispose }` shape the
// production `makeSelfHostApiHandler` returns.
// ---------------------------------------------------------------------------

export interface MakeSelfHostTestAppOptions {
  /** The test `IdentityProvider` (single-admin / header-driven). */
  readonly identity: Layer.Layer<IdentityProvider>;
  /** Override the SQLite path (defaults to the config data dir). */
  readonly dbPath?: string;
}

export interface SelfHostTestHandler {
  /** Unified web handler: serves /api/*, /mcp, and /docs (no /api/auth). */
  readonly handler: (request: Request) => Promise<Response>;
  readonly dispose: () => Promise<void>;
}

export const makeSelfHostTestApp = async (
  options: MakeSelfHostTestAppOptions,
): Promise<SelfHostTestHandler> => {
  const config = loadConfig();

  const dbHandle = await createSelfHostDb({
    path: options.dbPath ?? config.dbPath,
    namespace: SELF_HOST_NAMESPACE,
    version: SELF_HOST_SCHEMA_VERSION,
  });

  const sessionStore = makeSelfHostMcpSessionStore(dbHandle);

  const { toWebHandler } = ExecutorApp.make({
    plugins: selfHostPlugins,
    providers: {
      identity: options.identity,
      db: SelfHostDbProvider,
      engine: { codeExecutor: SelfHostCodeExecutorProvider },
      mcp: {
        auth: stubMcpAuth,
        sessions: selfHostMcpSessions(sessionStore),
        reporter: selfHostMcpReporter,
      },
      plugins: { provider: SelfHostPluginsProvider, config: SelfHostHostConfig },
      errorCapture: ErrorCaptureLive,
    },
    extensions: {
      routes: [
        HttpApiSwagger.layer(composePluginApi(selfHostPlugins).prefix("/api"), { path: "/docs" }),
      ],
    },
    config: { mountPrefix: "/api", failure: textFailureStrategy },
    // The test identity is boot-scoped exactly as production's is: no
    // requestScoped layer, so the execution middleware leaves IdentityProvider
    // residual and `provideMerge(boot)` supplies it.
    boot: Layer.merge(Layer.succeed(SelfHostDb)(dbHandle), options.identity),
  });

  const web = toWebHandler();
  return {
    handler: web.handler,
    dispose: async () => {
      await web.dispose();
      await sessionStore.close();
      await dbHandle.close();
    },
  };
};
