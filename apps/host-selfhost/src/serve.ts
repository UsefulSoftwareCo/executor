/**
 * Self-hosted Executor server.
 *
 * The entire HTTP app is ONE Effect `AppLayer`; the platform is just a provided
 * layer. Self-host binds it to a listening Bun socket via `BunHttpServer.layer`.
 * All routing lives in the Effect router — no hand-written fetch:
 *   - /api/*       typed API (auth-gated)
 *   - /api/auth/*  Better Auth
 *   - /mcp         MCP (per-user)
 *   - /docs        Swagger
 *   - everything else: the built web SPA (static files + index.html fallback)
 *
 * Run directly:  bun run apps/host-selfhost/src/serve.ts  (after `bun run build`)
 */

import { fileURLToPath } from "node:url";

import {
  Headers as EffectHeaders,
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpStaticServer,
} from "effect/unstable/http";
import { BunFileSystem, BunHttpServer, BunPath, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";

import { makeSelfHostApp } from "./app";
import { loadConfig } from "./config";
import type { BetterAuthHandle } from "./auth";
import {
  OAUTH_CALLBACK_PATH,
  oauthCallbackSignInRedirectLocation,
} from "./auth/oauth-callback-login";
import { MCP_ORIGINAL_PATH_HEADER, stripMcpOrgSegment } from "./mcp/org-path";

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
const assetsDir = fileURLToPath(new URL("../dist/assets/", import.meta.url));

// Rewrite `/<org>/mcp` (and its OAuth discovery path) to the bare path before
// routing, so the "Connect an agent" card's org-pinned URL reaches the real
// `/mcp` route — see ./mcp/org-path. The original org-scoped pathname is
// preserved on MCP_ORIGINAL_PATH_HEADER so the protected-resource metadata
// (./mcp/auth.ts) can echo it back to a client that dialed org-scoped, rather
// than always advertising the bare form (which fails the MCP SDK's same-origin
// resource check for org-scoped clients). A no-op for every other request,
// aside from scrubbing any client-supplied value of that header so it can't be
// spoofed into an unrewritten request.
const selfHostHttpMiddleware = (betterAuth: BetterAuthHandle) =>
  HttpMiddleware.make((httpApp) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, "http://host.internal");
      if (
        url.pathname === OAUTH_CALLBACK_PATH &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        const headers = new Headers(request.headers as Record<string, string>);
        const webRequest = new Request(url, { method: request.method, headers });
        const location = yield* Effect.promise(() =>
          oauthCallbackSignInRedirectLocation(webRequest, betterAuth.auth),
        );
        if (location) return HttpServerResponse.redirect(location, { status: 302 });
      }

      const rewritten = stripMcpOrgSegment(url.pathname);
      if (rewritten === null) {
        // Never let a client dictate the org-scoped echo below by smuggling
        // this header in directly — it's only ever trustworthy when WE set it
        // a few lines down, for a request we ourselves just rewrote.
        if (!EffectHeaders.has(request.headers, MCP_ORIGINAL_PATH_HEADER)) return yield* httpApp;
        return yield* httpApp.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            request.modify({
              headers: EffectHeaders.remove(request.headers, MCP_ORIGINAL_PATH_HEADER),
            }),
          ),
        );
      }
      return yield* httpApp.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          request.modify({
            url: `${rewritten}${url.search}`,
            headers: EffectHeaders.set(request.headers, MCP_ORIGINAL_PATH_HEADER, url.pathname),
          }),
        ),
      );
    }),
  );

export const startServer = async (): Promise<void> => {
  const config = loadConfig();
  const { AppLayer, betterAuth } = await makeSelfHostApp();

  // Serve the built SPA, split by cacheability so a redeploy is picked up at
  // once instead of stranding browsers on a stale shell:
  //   - `/assets/*` are Vite content-hashed (a new build emits new filenames),
  //     so they're safe to cache forever.
  //   - index.html (and the SPA fallback for client routes) is the mutable
  //     entry point that references those hashes; it must always revalidate, or
  //     a browser keeps an old index.html plus its old hashed bundles (still in
  //     cache) and renders a stale UI until a hard refresh.
  // Without explicit headers `HttpStaticServer` sends no Cache-Control at all,
  // so browsers heuristically cache index.html across deploys. The hashed
  // `/assets` route is the more specific match, so it wins over the SPA
  // catch-all. Other built-in API/docs/auth/mcp routes still take precedence;
  // `spa: true` falls back to index.html for any remaining path (client routing).
  const AssetsLive = HttpStaticServer.layer({
    root: assetsDir,
    prefix: "/assets",
    cacheControl: "public, max-age=31536000, immutable",
  }).pipe(Layer.provide(BunFileSystem.layer), Layer.provide(BunPath.layer));

  const SpaLive = HttpStaticServer.layer({
    root: distDir,
    spa: true,
    cacheControl: "no-cache",
  }).pipe(Layer.provide(BunFileSystem.layer), Layer.provide(BunPath.layer));

  const ServerLive = HttpRouter.serve(Layer.mergeAll(AppLayer, AssetsLive, SpaLive), {
    middleware: selfHostHttpMiddleware(betterAuth),
  }).pipe(
    Layer.provide(
      BunHttpServer.layer({ hostname: config.host, port: config.port, idleTimeout: 0 }),
    ),
  );

  await BunRuntime.runMain(Layer.launch(ServerLive));
};

if (import.meta.main) {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: process entry point; turn a pre-runtime startup failure (config/DB open) into a diagnosable log + non-zero exit instead of an opaque unhandled rejection
  try {
    await startServer();
  } catch (error) {
    // oxlint-disable-next-line executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: format an arbitrary thrown startup error for the container log
    const detail = error instanceof Error ? (error.stack ?? error.message) : error;
    console.error("[executor] failed to start:", detail);
    process.exit(1);
  }
}
