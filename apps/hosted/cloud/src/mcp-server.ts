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
      build: workerBuild("mcp-server", { localTestHooks: (yield* AlchemyContext).dev }),
      ...(yield* cloudObservability),
      workersDev: false,
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
