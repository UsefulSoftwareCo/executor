/**
 * Private entry point for MCP session objects. An object that wakes in a fresh isolate loads and
 * initializes only this Worker: the executor, the MCP grant checks and the protocol servers, not
 * the API with its routes, dashboard, sign-in, email, billing and schedules.
 */
import { AlchemyContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Layer } from "effect";
import { Api } from "./infrastructure/api-worker.ts";
import { appDataSupervisors } from "./infrastructure/app-data.ts";
import { cloudAuthDatabase } from "./infrastructure/auth-database.ts";
import { McpSession } from "./infrastructure/mcp.ts";
import { durableNamespace } from "./infrastructure/jurisdiction.ts";
import { cloudMcpIdentity } from "./infrastructure/mcp-auth.ts";
import { McpServer } from "./infrastructure/mcp-server-worker.ts";
import { makeMcpSession } from "./infrastructure/mcp-session.ts";
import { mcpSessionKeys } from "./infrastructure/mcp-session-keys.ts";
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
  // `McpSession.make` binds this Worker's own namespace; an object names itself through it.
  const sessions = yield* durableNamespace("McpSession");
  const idFromName = Effect.map(
    sessions,
    (namespace) => (name: string) => namespace.idFromName(name),
  );
  return yield* makeMcpSession({
    executor,
    identity: yield* cloudMcpIdentity,
    keys: yield* mcpSessionKeys,
    idFromName,
  });
}).pipe(Effect.orDie);

export default McpServer.make(
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url };
    return {
      main: import.meta.url,
      // Only `alchemy dev` bundles the local test hooks; deployed builds cannot contain them.
      build: workerBuild("mcp-server", { localTestHooks: (yield* AlchemyContext).dev }),
      ...(yield* cloudObservability),
      workersDev: false,
      // The API Worker's flags, under which session objects ran before they moved here.
      compatibility: {
        date: "2026-09-08",
        flags: [
          "nodejs_compat",
          "global_fetch_strictly_public",
          "enable_request_signal",
          "no_brotli_content_encoding",
        ],
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
