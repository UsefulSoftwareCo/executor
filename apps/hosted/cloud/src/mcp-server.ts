/**
 * Private entry point for MCP session objects. An object that wakes in a fresh isolate loads and
 * initializes only this Worker: the executor, the MCP grant checks and the protocol servers, not
 * the API with its routes, dashboard, sign-in, email, billing and schedules.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Layer } from "effect";
import { Api } from "./infrastructure/api-worker.ts";
import { appDataSupervisors } from "./infrastructure/app-data.ts";
import { cloudAuthDatabase } from "./infrastructure/auth-database.ts";
import { McpSession } from "./infrastructure/mcp.ts";
import { cloudMcpIdentity } from "./infrastructure/mcp-auth.ts";
import { McpServer } from "./infrastructure/mcp-server-worker.ts";
import { makeMcpSession } from "./infrastructure/mcp-session.ts";
import { postHogBindings } from "./infrastructure/posthog.ts";
import { sentryBindings } from "./infrastructure/sentry.ts";
import { cloudServingProduct } from "./infrastructure/serving-product.ts";
import {
  cloudObservability,
  cloudTelemetry,
  telemetryBindings,
} from "./infrastructure/telemetry.ts";
import { workerBuild } from "./infrastructure/worker-build.ts";

/** The executor and MCP identity are built once per isolate and shared by its objects. */
const mcpSession = Effect.gen(function* () {
  const executor = yield* cloudServingProduct(yield* appDataSupervisors);
  return yield* makeMcpSession({ executor, identity: yield* cloudMcpIdentity });
}).pipe(Effect.orDie);

export default McpServer.make(
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url };
    return {
      main: import.meta.url,
      build: workerBuild("mcp-server"),
      ...(yield* cloudObservability),
      workersDev: false,
      // The API Worker's flags, under which session objects ran before they moved here.
      compatibility: {
        date: "2026-09-08",
        flags: ["nodejs_compat", "global_fetch_strictly_public", "enable_request_signal"],
      },
      env: {
        ...(yield* postHogBindings).env,
        // Apps started from MCP tools run on the API-owned workflow.
        AppWorkflows: Cloudflare.Workflow("AppWorkflows", {
          className: "AppWorkflows",
          scriptName: (yield* Api).workerName,
        }),
        ...(yield* telemetryBindings),
        ...(yield* sentryBindings).env,
      },
    };
  }),
  Effect.succeed({}).pipe(
    Effect.provide(
      Layer.mergeAll(McpSession.make(mcpSession), cloudTelemetry).pipe(
        Layer.provide(cloudAuthDatabase),
      ),
    ),
  ),
);
