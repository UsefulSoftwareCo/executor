import { Layer } from "effect";
import { HttpServer } from "effect/unstable/http";

import { DbProvider, ExecutorApp } from "@executor-js/api/server";

import { cloudPlugins } from "./plugins";
import { CoreSharedServices } from "./auth/workos";
import { makeCloudExtensionRoutes } from "./extensions/routes";
import { RequestScopedServicesLive } from "./api/layers";
import { CloudMeteringEngineDecorator } from "./engine/execution-stack-metered";
import { workosAccountMiddleware } from "./account/account-api";
import { ApiKeyService } from "./auth/api-keys";
import { cloudIdentityFailureStrategy, workosIdentityLayer } from "./auth/workos-auth-provider";
import { DbService } from "./db/db";
import { cloudMcpAuth } from "./mcp";
import { McpSessionDOSqlite } from "./mcp/session-durable-object";
import { ErrorCaptureLive } from "./observability";
import { AutumnService } from "./extensions/billing/service";
import {
  CLOUD_MOUNT_PREFIX,
  CloudCodeExecutorProvider,
  CloudDbProvider,
  CloudHostConfig,
  CloudPluginsProvider,
} from "./engine/execution-stack";
import { WorkerTelemetryLive } from "./observability/telemetry";

// ===========================================================================
// The Executor CLOUD app, as ONE `ExecutorApp.make` call.
//
// The whole scenario in 60 seconds: WorkOS identity (api-key Bearer OR sealed-
// session cookie, api-key wins) over a per-request Hyperdrive→Postgres socket,
// the Cloudflare dynamic-worker code substrate, MCP served by a Durable-Object
// session store (the DO surfaced via `config.mcpExport`), console+Sentry error
// capture — and Autumn BILLING entering ONLY as extensions: the engine
// metering decorator, the account seat-gate, the `/api/billing/*` proxy route,
// and the createOrganization free-limit gate. `diff` against
// `apps/host-selfhost/src/app.ts` is the entire product difference.
//
// `ExecutorApp.make` owns the assembly (the execution-stack middleware wrapping
// the protected API, the MCP envelope, the account API on the /api-prefixed
// router, the extension routes, provideMerge(boot)). This file slots cloud's
// Pass-6 provider Layers into the named seams.
//
// Request scoping (Cloudflare Workers' I/O isolation): the postgres.js socket
// MUST be rebuilt per request. `requestScoped` is folded by `make` into the
// execution-stack middleware; the account + session extension routes fold their
// own `requestScopedMiddleware`. `boot` holds only long-lived context (WorkOS
// client, telemetry, billing service shell, the resolved identity provider).
// ===========================================================================

// The WorkOS control plane: the raw SDK client (`CoreSharedServices`) is the
// base; the api-key service builds on it, so each WorkOS-dependent service shares
// the one boot `WorkOSClient`. Surfaces both tags (the api-key service is read by
// the account provider + MCP seam, AND by the per-request identity layer below).
// Lives in `boot`, so `workosIdentityLayer`'s residual `WorkOSClient |
// ApiKeyService` (the long-lived control plane it reads) resolves from there.
// Tests point the REAL client at a WorkOS emulator via WORKOS_API_URL — no
// layer substitution.
const apiKeyService = ApiKeyService.WorkOS.pipe(Layer.provide(CoreSharedServices));
const controlPlane = Layer.mergeAll(CoreSharedServices, apiKeyService);

// `CloudDbProvider` only reads the per-request `DbService` at runtime; we widen
// its residual type to also carry the boot `AutumnService` the metering
// decorator reads, so `make` infers `RDb = DbService | AutumnService` (both
// satisfied by `boot`, `DbService` per request via `requestScoped`).
const cloudDb: Layer.Layer<DbProvider, never, DbService | AutumnService> = CloudDbProvider;

const { appLayer, toWebHandler, mcpExport } = ExecutorApp.make({
  plugins: cloudPlugins,
  providers: {
    // Identity: the NEUTRAL `IdentityProvider`. WorkOS api-key Bearer BEATS
    // sealed-session cookie (precedence inside `workosIdentityLayer`). Maps
    // rejected credentials to the shared `Unauthorized | NoOrganization |
    // Unavailable`; cloud's failure strategy renders the exact `{ error, code }`
    // JSON bytes at 401/403/503. The facade builds `authenticate` from the
    // `IdentityProvider` tag and provides THIS layer per request over
    // `requestScoped`, so the identity resolution lives in the request fiber's
    // socket scope. Its residual `UserStoreService` resolves from `requestScoped`
    // (the per-request socket); `WorkOSClient | ApiKeyService` from `boot`.
    identity: workosIdentityLayer,
    // The WorkOS account API (me / api-keys / org), built per request so the
    // service closes over the per-request postgres socket; carries the Autumn
    // seat-gate. Self-combines `requestScopedMiddleware`.
    account: workosAccountMiddleware(RequestScopedServicesLive),
    db: cloudDb,
    engine: {
      codeExecutor: CloudCodeExecutorProvider,
      // Billing-as-extension #1: the usage-metering decorator (reads AutumnService).
      decorator: CloudMeteringEngineDecorator,
    },
    // No `sessions` seam: `server.ts` intercepts `/mcp` transport for the
    // hibernatable Agent bridge, so the app envelope mounts only cloud's OAuth
    // discovery docs (via the `auth` seam). No `reporter` either: it only wrapped
    // the envelope's `/mcp` transport route, which cloud no longer serves here
    // (the Agent DO captures its own defects via Sentry in `server.ts`).
    mcp: {
      auth: cloudMcpAuth,
    },
    plugins: { provider: CloudPluginsProvider, config: CloudHostConfig },
    errorCapture: ErrorCaptureLive,
  },
  extensions: {
    // Cloud's app-only HTTP surface: WorkOS session routes, domain-verification,
    // Swagger/OpenAPI, the Autumn billing proxy, request-failure logging.
    routes: makeCloudExtensionRoutes(RequestScopedServicesLive),
  },
  config: {
    mountPrefix: CLOUD_MOUNT_PREFIX,
    // Cloud renders the shared identity errors as its exact `{ error, code }`
    // JSON at 401/403/503 (byte-identical to the old `HttpResponseError` bodies).
    failure: cloudIdentityFailureStrategy,
    // The MCP session Durable Object class — a top-level Workers export a Layer
    // can't return; surfaced so `server.ts` can re-export it.
    mcpExport: McpSessionDOSqlite,
  },
  // The long-lived (boot-scoped) context provideMerge'd under everything: the
  // WorkOS control plane (the raw `WorkOSClient` + `ApiKeyService` the per-request
  // identity layer reads residually), billing's service shell (read by the
  // metered decorator + free-limit gate), the worker tracer, and the HTTP
  // platform. A boot-time WorkOS misconfig is unrecoverable -> `orDie`.
  boot: controlPlane.pipe(
    Layer.merge(
      Layer.mergeAll(WorkerTelemetryLive, HttpServer.layerServices, AutumnService.Default),
    ),
    // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: a boot-time WorkOS misconfiguration is unrecoverable
    Layer.orDie,
  ),
  // Per request: the postgres socket (`DbService` / `UserStoreService`). The facade
  // provide-merges `providers.identity` over THIS layer, so the neutral
  // `IdentityProvider` is rebuilt per request in the same fiber scope as the socket
  // it reads (Cloudflare Workers' I/O isolation) — the identity layer's per-request
  // `UserStoreService` is covered by this layer (its `WorkOSClient | ApiKeyService`
  // by `boot`).
  requestScoped: RequestScopedServicesLive,
});

export { McpSessionDOSqlite };

export const CloudAppLayer = appLayer;
export const cloudMcpExport = mcpExport;

// The unified cloud web handler: serves /api/* (incl. /api/billing/*, /api/docs),
// /mcp, /.well-known/* — everything the worker dispatches.
export const cloudApiHandler = toWebHandler;
