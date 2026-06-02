import { Effect } from "effect";

import { dbProviderLayer, ExecutorApp, textFailureStrategy } from "@executor-js/api/server";

import { loadConfig, type CloudflareEnv } from "./config";
import { makeCloudflarePlugins } from "./plugins";
import { createD1ExecutorDb } from "./db/d1";
import { cloudflareAccessIdentityLayer } from "./auth/cloudflare-access";
import {
  CloudflareCodeExecutorProvider,
  makeCloudflareHostConfig,
  makeCloudflarePluginsProvider,
} from "./execution";
import { ErrorCaptureLive } from "./observability";
import { cloudflareAccountMiddleware } from "./account/account-provider";
import { makeCloudflareMcpSeams } from "./mcp";
import { preloadQuickJs } from "./quickjs";

// ===========================================================================
// The Cloudflare host, as ONE `ExecutorApp.make` call — the 4th app alongside
// cloud / self-host / local, differing only by the injected Layers.
//
// The whole scenario in 60 seconds: Cloudflare Access is the identity (validate
// the Cf-Access-Jwt-Assertion JWT — no Better Auth, no WorkOS, no app login),
// D1 is the SQLite store (same FumaDB assembly as self-host), QuickJS is the
// in-process code substrate, no billing, single-tenant. `diff` against
// host-selfhost/src/app.ts is three injected Layers: identity, db, plugins/config.
//
// Built per isolate (async) so the D1 schema bring-up happens once at first
// fetch; `env` arrives with that fetch (a Worker has no module-scope bindings),
// so the providers close over it instead of reading process.env.
// ===========================================================================

export const makeCloudflareApp = async (env: CloudflareEnv) => {
  const config = loadConfig(env);
  const plugins = makeCloudflarePlugins(config.secretKey);

  // Load the Workers-compatible (WASM-inlined) QuickJS variant before any
  // executor is built — the default variant can't fetch its .wasm on Workers.
  await preloadQuickJs();

  // Open + idempotently bring up the D1 schema once (the long-lived handle the
  // per-request scoped executor reads through the DbProvider seam).
  const dbHandle = await createD1ExecutorDb(env.DB, env.BLOBS);
  const identityLayer = cloudflareAccessIdentityLayer(config);
  // MCP runs through the `MCP_SESSION` Durable Object (cross-isolate sessions);
  // each session DO opens its own D1 handle, so it takes `env`, not `dbHandle`.
  const mcp = makeCloudflareMcpSeams(config, env);

  const { appLayer, toWebHandler } = ExecutorApp.make({
    plugins,
    providers: {
      identity: identityLayer,
      db: dbProviderLayer(Effect.succeed(dbHandle)),
      engine: { codeExecutor: CloudflareCodeExecutorProvider }, // decorator defaults to no-op
      plugins: {
        provider: makeCloudflarePluginsProvider(config),
        config: makeCloudflareHostConfig(config),
      },
      errorCapture: ErrorCaptureLive,
      // The account API (`/api/account/*`) backs the shared multiplayer shell's
      // auth context; `me` reflects the Access principal. Members/keys are
      // Access-managed, so the rest of the surface is stubbed.
      account: cloudflareAccountMiddleware(config),
      // The MCP serving envelope: Access-JWT auth + the shared in-process session
      // store over the QuickJS engine.
      mcp: { auth: mcp.auth, sessions: mcp.sessions, reporter: mcp.reporter },
    },
    config: { mountPrefix: "/api", failure: textFailureStrategy },
    boot: identityLayer,
  });

  return { appLayer, toWebHandler };
};
