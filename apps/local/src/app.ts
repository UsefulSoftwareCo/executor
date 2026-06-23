import { HttpApiSwagger } from "effect/unstable/httpapi";
import { Layer } from "effect";

import {
  composePluginApi,
  ExecutorApp,
  FixedExecutionProvider,
  textFailureStrategy,
} from "@executor-js/api/server";
import { createExecutionEngine } from "@executor-js/execution";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { composeExecutionObservers, type AnyPlugin } from "@executor-js/sdk";

import { getExecutorBundle, type LocalExecutor } from "./executor";
import { makeLocalIdentityLayer } from "./identity";
import { ErrorCaptureLive } from "./observability";

// ===========================================================================
// The LOCAL Executor app, as ONE `ExecutorApp.make` call.
//
// The whole scenario in 60 seconds: single-user identity (always the one local
// Principal) over a SINGLE boot-built executor scoped to the working directory
// (`<basename>-<hash>`, with `oauthEndpointUrlPolicy: { allowHttp: true }`),
// QuickJS in-process code execution, console error capture, Swagger at /docs —
// and NO account API, NO usage metering. `diff` against
// `apps/host-selfhost/src/app.ts` is the whole product difference: local serves
// its ONE cwd executor directly (the `fixedExecution` seam) instead of building
// a per-request `[user-org:…, org]` scoped executor from identity.
//
// `ExecutorApp.make` owns the assembly (the fixed-execution middleware wrapping
// the protected API, the extension routes, provideMerge(boot)). This file's job
// is the eager async boot — building the ONE executor + engine — and slotting
// local's seam Layers into the named slots.
//
// What legitimately stays LOCAL-PLATFORM (the thin `serve.ts` Bun shell, NOT
// make()'s job): the socket binding + idleTimeout, static SPA serving (embedded
// /disk/dev-vite), the one-time legacy SQLite import (run inside the boot bundle,
// BEFORE the executor reaches this seam), the single-credential network gate, the
// /mcp + /api/mcp-sessions resume + /api/oauth/await routes (an in-process,
// single-engine MCP handler with a browser-approval store — local's own surface,
// not the shared multi-user McpServingRoutes envelope), and the `/api`-prefix
// stripping. So `mcp` and `account` are OMITTED, and `mountPrefix` is left at
// root (the Bun shell strips `/api` before the handler).
// ===========================================================================

/**
 * The fixed-execution seam: the ONE boot executor + engine + plugin extension
 * map, projected under `FixedExecutionProvider`. The executor already holds its
 * cwd scope, libSQL db handle, plugins, and `allowHttp` policy (built in
 * `executor.ts`), so local supplies no `DbProvider`/`PluginsProvider`/
 * `HostConfig`/`CodeExecutorProvider` seams — the fixed executor is the whole
 * execution model.
 */
const localFixedExecutionLayer = (
  executor: LocalExecutor,
  plugins: readonly AnyPlugin[],
): Layer.Layer<FixedExecutionProvider> =>
  Layer.succeed(FixedExecutionProvider)({
    executor,
    engine: createExecutionEngine({
      executor,
      codeExecutor: makeQuickJsExecutor(),
      // Local bypasses makeExecutionStack, so compose plugin observers here.
      observer: composeExecutionObservers(plugins, executor),
    }),
    // The executor IS its own plugin-extension map (`executor[pluginId]`); the
    // fixed middleware reads `executor[id]` to satisfy each plugin's
    // `*ExtensionService` Tag per request — identical binding to the prior
    // `composePluginHandlers(plugins, executor)` boot-bind.
    extensions: executor,
  });

export interface LocalApiHandler {
  /** The unified web handler: serves the typed API (at root — the Bun shell strips `/api`) + /docs. */
  readonly handler: (request: Request) => Promise<Response>;
  readonly dispose: () => Promise<void>;
}

/**
 * Build the local app's API web-handler. Awaits the shared boot bundle (the one
 * cwd-scoped executor, after the legacy SQLite import), then composes
 * `ExecutorApp.make` over local's seams and binds it to a `fetch`-style handler.
 *
 * Mirrors self-host's `makeSelfHostApiHandler`: production-unconditional wiring
 * (no test-only branches), with `serve.ts`'s `handlers` injection hook as the
 * test seam where a test wants to bypass the boot graph.
 */
export const makeLocalApiHandler = async (token: string): Promise<LocalApiHandler> => {
  const { executor, plugins } = await getExecutorBundle();

  // Build the fixed-execution seam ONCE (one executor + one engine). The same
  // Layer is the `fixedExecution` seam declaration AND lives in `boot` so the
  // fixed middleware's residual `FixedExecutionProvider` resolves there — exactly
  // as self-host declares `db: SelfHostDbProvider` and puts the handle in `boot`.
  const fixedExecution = localFixedExecutionLayer(executor, plugins);

  // The authoritative identity gate for the typed `/api`: validates the boot
  // bearer token and resolves the one local Principal. The Bun shell
  // (`serve.ts`) fast-path-rejects unauthenticated requests with the same token.
  const identity = makeLocalIdentityLayer(token);

  const { toWebHandler } = ExecutorApp.make({
    plugins,
    providers: {
      // Single-user: validates the boot bearer token and resolves the one local
      // Principal. Boot-scoped (`RIdentity = never`), captured once.
      identity,
      // The ONE boot executor + engine, served directly — local's fixed
      // execution model (no per-request scoped-executor rebuild).
      fixedExecution,
      // account omitted (local has no account API).
      // mcp omitted (local's /mcp is its own in-process surface in serve.ts).
      errorCapture: ErrorCaptureLive,
    },
    extensions: {
      // Swagger UI at /docs, over the root-mounted spec (matches the served
      // paths — local serves the API at root; the Bun shell strips `/api`).
      routes: [HttpApiSwagger.layer(composePluginApi(plugins), { path: "/docs" })],
    },
    // No mountPrefix: local serves the typed API at root and the Bun shell
    // strips the `/api` prefix before dispatching here. Local renders identity
    // failures as text (matching self-host); the single-user provider never
    // produces one in practice.
    config: { failure: textFailureStrategy },
    // The boot-scoped context provideMerge'd under everything: the identity
    // provider (captured once by the fixed-execution middleware) + the fixed
    // execution seam (the one executor + engine + extension map).
    boot: Layer.merge(identity, fixedExecution),
  });

  const web = toWebHandler();
  return { handler: web.handler, dispose: web.dispose };
};
