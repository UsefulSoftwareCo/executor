/** Cloud deployment: native API runtime, dashboard, and static marketing assets. */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Axiom from "alchemy/Axiom";
import * as Planetscale from "alchemy/Planetscale";
import * as Neon from "alchemy/Neon";
import * as Docker from "alchemy/Docker";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { Effect, Layer, Option } from "effect";
import AppPages from "./src/app-ui.ts";
import { cloudAppUiBase } from "./src/contracts/app-ui.ts";
import ApiLive, { Api } from "./src/main.ts";
import AppCompilerLive from "./src/compiler.ts";
import DashboardLive from "./src/dashboard.ts";
import FormatterLive from "./src/formatter.ts";
import AppDataLive from "./src/app-data.ts";
import ArtifactsCredentialsLive from "./src/artifacts-credentials.ts";
import McpServerLive from "./src/mcp-server.ts";
import EdgeLive from "./src/edge.ts";
import MarketingLive from "./src/marketing.ts";
import { Marketing } from "./src/infrastructure/marketing-worker.ts";
import { Edge } from "./src/infrastructure/edge-worker.ts";
import { McpServer } from "./src/infrastructure/mcp-server-worker.ts";
import { mcpSessionRetirementGate } from "./src/infrastructure/mcp-session-release.ts";
import AppDomainControllerLive from "./src/app-domains.ts";
import { AppDomainController } from "./src/infrastructure/app-domain-controller-worker.ts";
import InvocationTelemetryLive from "./src/invocation-telemetry.ts";
import { databaseInfrastructure } from "./src/infrastructure/database.ts";
import { previewPoolSize } from "./src/infrastructure/preview-database.ts";
import { developmentWeb } from "./src/infrastructure/development.ts";
import { authEmailInfrastructure } from "./src/infrastructure/email.ts";
import { uploadCloudSourceMaps } from "./src/infrastructure/sentry.ts";
import { stackState } from "./src/infrastructure/state.ts";
import {
  AppDomainLifecycle,
  AppDomainLifecycleProvider,
  ResumeAppDomains,
} from "./src/infrastructure/app-domain-lifecycle.ts";
import { appDomainControlSecret } from "./src/infrastructure/app-domain-control.ts";
import { cloudOrigin } from "./src/infrastructure/stage.ts";
import { productionOAuthProxyCheck } from "./src/infrastructure/deploy-settings.ts";
import { testStageEdge, testStageRoleHostRecords } from "./src/infrastructure/role-hosts.ts";

/** Every Worker the stack deploys. `scripts/worker-sizes.ts` builds the same layers. */
export const cloudWorkers = Layer.mergeAll(
  ApiLive,
  AppCompilerLive,
  DashboardLive,
  FormatterLive,
  AppDataLive,
  ArtifactsCredentialsLive,
  McpServerLive,
  AppDomainControllerLive,
  InvocationTelemetryLive,
  EdgeLive,
  MarketingLive,
);

export default Alchemy.Stack(
  "executor-next-hosted",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Command.providers(),
      AppDomainLifecycleProvider(),
      // No PlanetScale resources or credentials are needed for local cloud development.
      Docker.providers(),
      Layer.unwrap(
        AlchemyContext.pipe(
          Effect.map(({ dev }) =>
            dev
              ? Layer.empty
              : Layer.mergeAll(Planetscale.providers(), Neon.providers(), Axiom.providers()),
          ),
        ),
      ),
    ),
    state: stackState,
  },
  Effect.gen(function* () {
    // Stops the deploy before anything changes when a setting would stop the Worker at startup.
    yield* productionOAuthProxyCheck.pipe(Effect.orDie);
    // Stops the deploy before anything changes when the release before this one is not live.
    yield* mcpSessionRetirementGate.pipe(Effect.orDie);
    // Provisioning settings resolve outside Worker initialization and are not bound into it.
    yield* databaseInfrastructure;
    if (!(yield* AlchemyContext).dev) yield* previewPoolSize;
    yield* authEmailInfrastructure.pipe(Effect.orDie);
    const api = yield* Api;
    if (!(yield* AlchemyContext).dev) {
      yield* Marketing;
      yield* testStageRoleHostRecords;
      // A test stage plays v1's edge itself; production's edge is v1's.
      if (Option.isSome(yield* testStageEdge)) yield* Edge;
    }
    const appBase = yield* cloudAppUiBase.pipe(Effect.orDie);
    if (appBase !== undefined) {
      const pages = yield* AppPages;
      yield* uploadCloudSourceMaps("app-pages", pages.hash).pipe(Effect.orDie);
      if (!(yield* AlchemyContext).dev) {
        const controller = yield* AppDomainController;
        const lifecycle = yield* AppDomainLifecycle("AppDomains", {
          origin: yield* cloudOrigin.pipe(Effect.orDie),
          workerName: api.workerName,
          deployment: api.hash,
          controller: controller.hash,
        });
        yield* ResumeAppDomains({
          origin: lifecycle.origin,
          secret: (yield* appDomainControlSecret).text,
          deployment: api.hash,
          controller: controller.hash,
        });
      }
    }
    yield* uploadCloudSourceMaps("api", api.hash).pipe(Effect.orDie);
    yield* uploadCloudSourceMaps("mcp-server", (yield* McpServer).hash).pipe(Effect.orDie);
    return { url: (yield* AlchemyContext).dev ? yield* developmentWeb(api.url) : api.url };
  }).pipe(Effect.provide(cloudWorkers)),
);
