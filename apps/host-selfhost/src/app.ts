import { HttpApiSwagger } from "effect/unstable/httpapi";
import { HttpEffect, HttpRouter } from "effect/unstable/http";
import { Layer } from "effect";

import { composePluginApi, ExecutorApp, textFailureStrategy } from "@executor-js/api/server";

import { runSqliteAuthConfigMigration } from "@executor-js/sdk/http-auth";

import { resolveAuthProviders } from "./auth";
import { authConfigTransforms } from "./db/auth-config-migration";
import { makeSelfHostAdminApiLayer } from "./admin/handlers";
import { makeSelfHostSystemApiLayer } from "./system/handlers";
import { selfHostAccountMiddleware } from "./account";
import { loadConfig, SELF_HOST_NAMESPACE, SELF_HOST_SCHEMA_VERSION } from "./config";
import { createSelfHostDb, SelfHostDb, SelfHostDbProvider } from "./db/self-host-db";
import {
  SelfHostCodeExecutorProvider,
  SelfHostHostConfig,
  SelfHostPluginsProvider,
} from "./execution";
import { makeSelfHostMcpSeams } from "./mcp";
import { selfHostPlugins } from "./plugins";
import { ErrorCaptureLive } from "./observability";

// ===========================================================================
// The self-hosted Executor app, as ONE `ExecutorApp.make` call.
//
// The whole scenario in 60 seconds: Better Auth (cookie/bearer/api-key identity
// + /api/auth handler + account API + MCP OAuth) over a libSQL file, QuickJS
// in-process code execution, in-process MCP, console error capture, Swagger at
// /docs — and NO billing (the cloud `extensions.services` + /autumn route are
// simply absent). `diff` against the cloud app is the entire product difference.
//
// `ExecutorApp.make` owns the assembly (execution-stack middleware wrapping the
// protected API, the MCP envelope, the account API on the /api-prefixed router,
// the extension routes, provideMerge(boot)). This file's job is the eager async
// boot + slotting self-host's seam Layers into the named slots.
//
// Built eagerly (async) so the DB connection, schema migration, and Better Auth
// org/admin seeding happen at boot — fail fast on misconfig. The DB is opened
// ONCE and shared (Layer.succeed) by the per-request executor, Better Auth, and
// the MCP session store.
// ===========================================================================

export interface MakeSelfHostAppOptions {
  /** Override the SQLite path (tests point at a throwaway file). */
  readonly dbPath?: string;
}

export const makeSelfHostApp = async (options: MakeSelfHostAppOptions = {}) => {
  const config = loadConfig();

  // ---- eager async boot: the shared libSQL handle -----------------------
  const dbHandle = await createSelfHostDb({
    path: options.dbPath ?? config.dbPath,
    namespace: SELF_HOST_NAMESPACE,
    version: SELF_HOST_SCHEMA_VERSION,
  });

  // One-off data migration: rewrite pre-canonical integration auth configs
  // into the shared placements model. Idempotent — a no-op once every row is
  // canonical (same defensive-at-boot pattern as the column adds above).
  await runSqliteAuthConfigMigration(dbHandle.client, authConfigTransforms);

  // ---- auth providers ---------------------------------------------------
  // Better Auth: cookie/bearer/api-key identity + /api/auth handler + account
  // API + MCP OAuth seam, all over the shared libSQL handle.
  const { identityLayer, authHandler, betterAuth } = await resolveAuthProviders(dbHandle);

  // ---- the in-process MCP serving seams (+ shutdown hook) ----------------
  const mcp = makeSelfHostMcpSeams(dbHandle, betterAuth);

  const { appLayer, toWebHandler } = ExecutorApp.make({
    plugins: selfHostPlugins,
    providers: {
      identity: identityLayer,
      account: selfHostAccountMiddleware(betterAuth),
      db: SelfHostDbProvider,
      engine: { codeExecutor: SelfHostCodeExecutorProvider }, // decorator defaults to no-op (no metering)
      mcp: { auth: mcp.auth, sessions: mcp.sessions, reporter: mcp.reporter },
      plugins: { provider: SelfHostPluginsProvider, config: SelfHostHostConfig },
      errorCapture: ErrorCaptureLive,
    },
    extensions: {
      routes: [
        // Better Auth owns /api/auth/* — the full path reaches it unmodified.
        HttpRouter.add("*", "/api/auth/*", HttpEffect.fromWebHandler(authHandler)),
        // App-local admin (invite-code) API, served under /api/admin/*.
        makeSelfHostAdminApiLayer({ betterAuth, db: dbHandle, mountPrefix: "/api" }),
        // Public system API: /api/health + /api/setup-status (unauthenticated).
        makeSelfHostSystemApiLayer({ betterAuth, db: dbHandle, mountPrefix: "/api" }),
        // Swagger UI at /docs, over the /api-prefixed spec (matches the served paths).
        HttpApiSwagger.layer(composePluginApi(selfHostPlugins).prefix("/api"), { path: "/docs" }),
      ],
    },
    config: { mountPrefix: "/api", failure: textFailureStrategy },
    // The boot-scoped context provideMerge'd under everything: the long-lived DB
    // handle (read by the DbProvider seam, Better Auth, and the MCP store) + the
    // resolved identity (captured once by the execution middleware + MCP auth).
    boot: Layer.merge(Layer.succeed(SelfHostDb)(dbHandle), identityLayer),
  });

  return {
    // Every route requirement is provided (the seams + boot resolve to nothing
    // residual), so the assembled app is a `Layer<never>` — the precise shape
    // `serve.ts` binds to the Bun socket. `make` types its `appLayer` loosely
    // (it can't prove each host's resolution); self-host narrows it here.
    AppLayer: appLayer as Layer.Layer<never>,
    toWebHandler,
    closeDb: async () => {
      await mcp.close();
      await dbHandle.close();
    },
  };
};

export interface SelfHostApiHandler {
  /** Unified web handler: serves /api/*, /api/auth/*, /mcp, and /docs. */
  readonly handler: (request: Request) => Promise<Response>;
  readonly dispose: () => Promise<void>;
}

// Web-handler binding of `AppLayer` — used by tests (and the same shape cloud
// uses for Workers). The self-host server (serve.ts) binds `AppLayer` to a
// listening socket instead. We wrap `dispose` to also close the DB / MCP store.
export const makeSelfHostApiHandler = async (
  options: MakeSelfHostAppOptions = {},
): Promise<SelfHostApiHandler> => {
  const { toWebHandler, closeDb } = await makeSelfHostApp(options);
  const web = toWebHandler();
  return {
    handler: web.handler,
    dispose: async () => {
      await web.dispose();
      await closeDb();
    },
  };
};
