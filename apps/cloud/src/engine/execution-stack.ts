// ---------------------------------------------------------------------------
// Cloud execution-stack seams.
//
// The shared `makeExecutionStack` (@executor-js/api/server) owns the body:
//   makeScopedExecutor -> createExecutionEngine -> EngineDecorator.decorate.
// Used by the protected HTTP API (per-request) and the MCP session DO
// (per-session) so changes to the stack flow to both. Cloud supplies the five
// seam Layers it reads from; the only cloud-specific differences are the
// Cloudflare dynamic-worker code substrate and the usage-metering decorator.
//
//   - DbProvider          -> cloudDbProviderLayer: rebuilds the postgres-js fuma
//                            client per request off the request-scoped
//                            `DbService.db` (Hyperdrive forbids sharing an I/O
//                            handle across requests). The shared factory reads
//                            `db` without caching, preserving per-request rebuild.
//   - PluginsProvider      -> fresh per-request plugins with the Worker env's
//                            WorkOS credentials.
//   - HostConfig           -> `allowLocalNetwork` is config-driven (the
//                            `ALLOW_LOCAL_NETWORK` var; production leaves it unset
//                            -> `false`, the test workers set it `"true"`). It is
//                            an SSRF/private-network guard, so it MUST NOT key off
//                            a test flag. `webBaseUrl` is `VITE_PUBLIC_SITE_URL ??
//                            executor.sh`.
//   - CodeExecutorProvider -> `makeDynamicWorkerExecutor({ loader: env.LOADER })`.
//   - EngineDecorator      -> the BASE stack uses the no-op decorator (the MCP
//                            session DO never meters); the METERED stack (HTTP
//                            executor plane only) overrides it with the billing
//                            decorator (`CloudMeteredExecutionStackLayer`,
//                            ../engine/execution-stack-metered.ts). Billing lives in
//                            the cloud app, not this neutral stack.
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import { Layer } from "effect";

import {
  CodeExecutorProvider,
  DbProvider,
  EngineDecorator,
  EngineDecoratorNoop,
  HostConfig,
  PluginsProvider,
  collectTables,
} from "@executor-js/api/server";
import { makeDynamicWorkerExecutor } from "@executor-js/runtime-dynamic-worker";

import executorConfig from "../../executor.config";
import { DbService } from "../db/db";
import { cloudDbProviderLayer } from "../db/fuma";

export { makeExecutionStack } from "@executor-js/api/server";

// The executor table set is fixed (plugin-independent), so the per-request
// DbProvider rebuilds the fuma client over the same schema.
export const CloudDbProvider = cloudDbProviderLayer(collectTables());

// Fresh plugin instances per request, carrying the Worker env's WorkOS Vault
// credentials. Matches the old `createScopedExecutor`'s `orgPlugins()`.
export const CloudPluginsProvider: Layer.Layer<PluginsProvider> = Layer.succeed(PluginsProvider)({
  plugins: () =>
    executorConfig.plugins({
      workosCredentials: {
        apiKey: env.WORKOS_API_KEY,
        clientId: env.WORKOS_CLIENT_ID,
      },
    }),
});

/**
 * The path prefix the cloud mounts its typed API under. SINGLE SOURCE OF TRUTH:
 * `app.ts` passes this as `ExecutorApp.make({ config: { mountPrefix } })`, and
 * `make` derives the OAuth callback (`${webBaseUrl}${CLOUD_MOUNT_PREFIX}/oauth/callback`)
 * from that same `mountPrefix`, so the redirect URI the host sends to providers
 * always matches the route that actually serves the callback — no second knob.
 */
export const CLOUD_MOUNT_PREFIX = "/api" as const;

export const CloudHostConfig: Layer.Layer<HostConfig> = Layer.sync(HostConfig, () => ({
  // SSRF / private-network egress guard. Config-driven, NOT a test flag:
  // production leaves `ALLOW_LOCAL_NETWORK` unset so the guard stays ON (`false`);
  // the test workers (`wrangler.test.jsonc` / `wrangler.miniflare.jsonc`) opt in
  // with `"true"` so fixtures can reach localhost. See `hosted-http-client.ts`.
  allowLocalNetwork: env.ALLOW_LOCAL_NETWORK === "true",
  webBaseUrl: env.VITE_PUBLIC_SITE_URL ?? "https://executor.sh",
  // `oauthCallbackPath` is NOT set here — `ExecutorApp.make` derives it from the
  // `mountPrefix` cloud passes (`CLOUD_MOUNT_PREFIX`), so the callback can't drift
  // from the route that serves it.
  // WorkOS Vault is cloud's credential storage implementation detail, not a
  // user-selectable provider surface.
  exposeCredentialProviders: false,
}));

export const CloudCodeExecutorProvider: Layer.Layer<CodeExecutorProvider> = Layer.sync(
  CodeExecutorProvider,
  () => makeDynamicWorkerExecutor({ loader: env.LOADER }),
);

/**
 * The four billing-free execution-stack seams (db / plugins / host-config /
 * code-executor) — everything `makeExecutionStack` reads EXCEPT the
 * `EngineDecorator`. The metered HTTP plane composes this with the billing
 * decorator (../engine/execution-stack-metered.ts); the neutral stack below adds
 * the no-op decorator. Exported so the metered overlay builds over the SAME four
 * seams rather than relying on a layer override.
 */
export const CloudExecutionSeamsLayer: Layer.Layer<
  DbProvider | PluginsProvider | HostConfig | CodeExecutorProvider,
  never,
  DbService
> = Layer.mergeAll(
  CloudDbProvider,
  CloudPluginsProvider,
  CloudHostConfig,
  CloudCodeExecutorProvider,
);

/**
 * The five execution-stack seams the shared `makeExecutionStack` reads from,
 * with the NO-OP engine decorator. This is the neutral stack: it requires only
 * `DbService` (per-request Hyperdrive db) and carries NO billing dependency, so
 * the MCP session DO — which never meters — can build an engine without dragging
 * in any billing service.
 *
 * The HTTP executor plane (the only path that meters) uses
 * `CloudMeteredExecutionStackLayer` (../engine/execution-stack-metered.ts), which
 * swaps the no-op decorator for the billing one.
 */
export const CloudExecutionStackLayer: Layer.Layer<
  DbProvider | PluginsProvider | HostConfig | CodeExecutorProvider | EngineDecorator,
  never,
  DbService
> = Layer.merge(CloudExecutionSeamsLayer, EngineDecoratorNoop);
