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
//   - EngineDecorator      -> the billing decorator that meters each execution
//                            to Autumn. BOTH cloud execution planes (the HTTP
//                            `/api/*` executor plane AND the MCP session DO) use
//                            the metered stack (`CloudMeteredExecutionStackLayer`,
//                            ../engine/execution-stack-metered.ts), since the MCP
//                            server is the primary execution surface. Billing
//                            still lives in the cloud app, not this neutral
//                            seams module; the decorator is composed on top.
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import { Layer } from "effect";

import {
  CodeExecutorProvider,
  DbProvider,
  HostConfig,
  PluginsProvider,
  collectTables,
  type HostConfigShape,
} from "@executor-js/api/server";
import { makeDynamicWorkerExecutor } from "@executor-js/runtime-dynamic-worker";
import type { AnyPlugin } from "@executor-js/sdk";

import executorConfig from "../../executor.config";
import { DbService } from "../db/db";
import { cloudDbProviderLayer } from "../db/fuma";

export { makeExecutionStack } from "@executor-js/api/server";

// The executor table set is fixed (plugin-independent), so the per-request
// DbProvider rebuilds the fuma client over the same schema.
export const CloudDbProvider = cloudDbProviderLayer(collectTables());

const cloudPluginFactory = executorConfig.plugins as (deps: {
  readonly workosCredentials: {
    readonly apiKey: string;
    readonly clientId: string;
    readonly apiUrl?: string;
  };
  readonly activeToolkitSlug?: string;
}) => readonly AnyPlugin[];

// Fresh plugin instances per request, carrying the Worker env's WorkOS Vault
// credentials. Matches the old `createScopedExecutor`'s `orgPlugins()`.
export const CloudPluginsProvider: Layer.Layer<PluginsProvider> = Layer.succeed(PluginsProvider)({
  plugins: (context) =>
    cloudPluginFactory({
      workosCredentials: {
        apiKey: env.WORKOS_API_KEY,
        clientId: env.WORKOS_CLIENT_ID,
        apiUrl: env.WORKOS_API_URL,
      },
      activeToolkitSlug:
        context?.mcpResource?.kind === "toolkit" ? context.mcpResource.slug : undefined,
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

/**
 * Cloud's host config, parameterized by the ONE seam its two execution planes
 * genuinely disagree about: where a deferred tool-catalog refresh runs.
 *
 * The MCP session Durable Object holds its database handle for the life of the
 * session, so it can hand the batch straight to `ctx.waitUntil` and forget it.
 * The HTTP plane's handle dies with its request and gets no seam at all (see
 * {@link CloudHostConfig}). Nothing else about the config differs, which is why
 * this is a parameter rather than a second config module.
 */
export const makeCloudHostConfig = (
  deferToolSync: HostConfigShape["deferToolSync"],
): Layer.Layer<HostConfig> =>
  Layer.sync(HostConfig, () => ({
    // SSRF / private-network egress guard. Config-driven, NOT a test flag:
    // production leaves `ALLOW_LOCAL_NETWORK` unset so the guard stays ON (`false`);
    // the e2e dev-server env opts in with `"true"` so in-scenario fixture
    // servers on localhost are reachable. See `hosted-http-client.ts`.
    allowLocalNetwork: env.ALLOW_LOCAL_NETWORK === "true",
    webBaseUrl: env.VITE_PUBLIC_SITE_URL ?? "https://executor.sh",
    oauthCallbackPath: `${CLOUD_MOUNT_PREFIX}/oauth/callback`,
    // WorkOS Vault is cloud's credential storage implementation detail, not a
    // user-selectable provider surface.
    exposeCredentialProviders: false,
    deferToolSync,
  }));

/**
 * The HTTP plane's config, and the one seam it CANNOT fill: `deferToolSync` is
 * absent, so a tools read over `/api/*` still refreshes an expired catalog
 * inline.
 *
 * Not an omission. The postgres pool a request's executor closes over is
 * acquired and released inside `requestScopedMiddleware`'s `Effect.scoped`,
 * which wraps the ROUTE HANDLER — so the pool is torn down while the handler's
 * `HttpServerResponse` is still a value, strictly before `HttpEffect.toHandled`
 * writes it. There is therefore no window on this plane that is both after the
 * response and before the socket closes: work scheduled with `waitUntil` finds
 * a dead pool, and work drained inside the scope is simply inline work with
 * extra steps. `api.request-scope.node.test.ts` pins that ordering, so a future
 * change to the request lifecycle will say so rather than making this comment
 * quietly wrong.
 *
 * Holding the pool open past the response instead — deferring the scope close
 * into `waitUntil` — is the one thing that would make the window exist, and it
 * is the thing `closePostgres` was written to prevent. That finalizer awaits
 * the teardown precisely so live-plus-closing sockets stay bounded by what is
 * in flight; unbounded, the backlog is the sustained-load cascade recorded in
 * `db/db.ts`. Trading a socket leak for a background refresh is not a trade
 * this plane should make, and it would make it on EVERY request, not just the
 * ones that deferred.
 *
 * The alternative — giving the batch a short-lived pool of its own via
 * `makeDbLayer()` — does not fit either: the task the sdk hands over is already
 * bound to the executor that built it, so re-targeting it means rebuilding a
 * whole second executor in the background. That is a background scheduler, a
 * different feature with a different failure surface, not a wiring detail.
 *
 * Cloud's high-volume tools read is `tools/list` over MCP, and that plane DOES
 * defer: the session Durable Object holds its database handle for the life of
 * the session (see `mcp/session-durable-object.ts`).
 */
export const CloudHostConfig: Layer.Layer<HostConfig> = makeCloudHostConfig(undefined);

export const CloudCodeExecutorProvider: Layer.Layer<CodeExecutorProvider> = Layer.sync(
  CodeExecutorProvider,
  () => makeDynamicWorkerExecutor({ loader: env.LOADER }),
);

/**
 * The four billing-free execution-stack seams (db / plugins / host-config /
 * code-executor): everything `makeExecutionStack` reads EXCEPT the
 * `EngineDecorator`. Both cloud planes compose this with the billing decorator
 * via `CloudMeteredExecutionStackLayer` (../engine/execution-stack-metered.ts);
 * exported so that overlay builds over the SAME four seams. There is no neutral
 * no-op-decorator variant anymore: every cloud execution meters.
 */
export const makeCloudExecutionSeamsLayer = (
  hostConfig: Layer.Layer<HostConfig>,
): Layer.Layer<
  DbProvider | PluginsProvider | HostConfig | CodeExecutorProvider,
  never,
  DbService
> => Layer.mergeAll(CloudDbProvider, CloudPluginsProvider, hostConfig, CloudCodeExecutorProvider);

export const CloudExecutionSeamsLayer: Layer.Layer<
  DbProvider | PluginsProvider | HostConfig | CodeExecutorProvider,
  never,
  DbService
> = makeCloudExecutionSeamsLayer(CloudHostConfig);
