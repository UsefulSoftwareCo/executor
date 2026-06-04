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

import { HttpRouter, HttpStaticServer } from "effect/unstable/http";
import { BunFileSystem, BunHttpServer, BunPath, BunRuntime } from "@effect/platform-bun";
import { Layer } from "effect";

import { makeSelfHostApp } from "./app";
import { loadConfig } from "./config";

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));

export const startServer = async (): Promise<void> => {
  const config = loadConfig();
  const { AppLayer } = await makeSelfHostApp();

  // Serve the built SPA. Specific API/docs/auth/mcp routes take precedence;
  // `spa: true` falls back to index.html for any other path (client routing).
  const StaticLive = HttpStaticServer.layer({ root: distDir, spa: true }).pipe(
    Layer.provide(BunFileSystem.layer),
    Layer.provide(BunPath.layer),
  );

  const ServerLive = HttpRouter.serve(Layer.mergeAll(AppLayer, StaticLive)).pipe(
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
