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
import { resolveMcpOrgPath } from "./mcp/org-path";

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));

// Validate `/<org>/mcp` and its OAuth discovery path before routing. The live
// org id or slug reaches the bare MCP route; foreign scopes get a plain 404.
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

      const scopedPath = resolveMcpOrgPath(url.pathname, {
        id: betterAuth.organizationId,
        slug: betterAuth.organizationSlug,
      });
      if (scopedPath.kind === "none") return yield* httpApp;
      if (scopedPath.kind === "reject")
        return HttpServerResponse.text("Not Found", { status: 404 });
      return yield* httpApp.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          request.modify({ url: `${scopedPath.pathname}${url.search}` }),
        ),
      );
    }),
  );

export const startServer = async (): Promise<void> => {
  const config = loadConfig();
  const { AppLayer, betterAuth } = await makeSelfHostApp();

  // Serve the built SPA. Specific API/docs/auth/mcp routes take precedence;
  // `spa: true` falls back to index.html for any other path (client routing).
  const StaticLive = HttpStaticServer.layer({ root: distDir, spa: true }).pipe(
    Layer.provide(BunFileSystem.layer),
    Layer.provide(BunPath.layer),
  );

  const ServerLive = HttpRouter.serve(Layer.mergeAll(AppLayer, StaticLive), {
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
