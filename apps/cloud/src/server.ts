import * as Sentry from "@sentry/cloudflare";
import handler from "@tanstack/react-start/server-entry";

import { McpSessionDO as McpSessionDOBase } from "./mcp-session";

// ---------------------------------------------------------------------------
// Sentry config
// ---------------------------------------------------------------------------

const sentryOptions = (env: Env) => ({
  dsn: env.SENTRY_DSN,
  tracesSampleRate: 0,
  enableLogs: true,
  sendDefaultPii: true,
  skipOpenTelemetrySetup: true,
  // Our DO methods (init/handleRequest/alarm) live on the prototype, not on
  // the instance. Sentry's default DO auto-wrap only visits own properties,
  // which misses prototype methods — so errors thrown inside init() never
  // reach Sentry. This flag opts into prototype-method instrumentation.
  instrumentPrototypeMethods: true,
});

// ---------------------------------------------------------------------------
// Durable Object — wrapped with Sentry so DO errors land in Sentry (inits the
// client inside the DO isolate, which plain `Sentry.captureException` cannot
// do on its own). OTEL is installed through Effect layers, not a global fetch
// wrapper.
// ---------------------------------------------------------------------------

export const McpSessionDO = Sentry.instrumentDurableObjectWithSentry(
  sentryOptions,
  McpSessionDOBase,
);

// ---------------------------------------------------------------------------
// Worker fetch handler
// ---------------------------------------------------------------------------

const fetchHandler = handler.fetch as (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Response | Promise<Response>;

const cloudflareHandler: ExportedHandler<Env> = {
  fetch: (request, env, ctx) => fetchHandler(request, env, ctx),
};

export default Sentry.withSentry(sentryOptions, cloudflareHandler);
