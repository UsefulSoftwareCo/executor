/** Cloud deployment: native API runtime, dashboard, and static marketing assets. */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Axiom from "alchemy/Axiom";
import * as Planetscale from "alchemy/Planetscale";
import * as Docker from "alchemy/Docker";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { Effect, Layer } from "effect";
import AppPages from "./src/app-ui.ts";
import { cloudAppUiBase } from "./src/contracts/app-ui.ts";
import ApiLive, { Api } from "./src/main.ts";
import AppCompilerLive from "./src/compiler.ts";
import InvocationTelemetryLive from "./src/invocation-telemetry.ts";
import { DatabaseConnection } from "./src/infrastructure/database.ts";
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
            dev ? Layer.empty : Layer.mergeAll(Planetscale.providers(), Axiom.providers()),
          ),
        ),
      ),
    ),
    state: stackState,
  },
  Effect.gen(function* () {
    // Provisioning settings resolve outside Worker initialization and are not bound into it.
    yield* DatabaseConnection;
    yield* authEmailInfrastructure.pipe(Effect.orDie);
    const api = yield* Api;
    const appBase = yield* cloudAppUiBase.pipe(Effect.orDie);
    if (appBase !== undefined) {
      const pages = yield* AppPages;
      yield* uploadCloudSourceMaps("app-pages", pages.hash).pipe(Effect.orDie);
      if (!(yield* AlchemyContext).dev) {
        const lifecycle = yield* AppDomainLifecycle("AppDomains", {
          origin: yield* cloudOrigin.pipe(Effect.orDie),
          workerName: api.workerName,
          deployment: api.hash,
        });
        yield* ResumeAppDomains({
          origin: lifecycle.origin,
          secret: (yield* appDomainControlSecret).text,
          deployment: api.hash,
        });
      }
    }
    yield* uploadCloudSourceMaps("api", api.hash).pipe(Effect.orDie);
    return { url: (yield* AlchemyContext).dev ? yield* developmentWeb(api.url) : api.url };
  }).pipe(Effect.provide(Layer.mergeAll(ApiLive, AppCompilerLive, InvocationTelemetryLive))),
);
