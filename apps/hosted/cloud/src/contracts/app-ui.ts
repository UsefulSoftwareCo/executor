/** Cloud app hostnames are operator-provisioned separately from the dashboard's CDN origin. */
import { AppUiBaseUrl } from "@executor-js/hosted-server/app-ui";
import { Config, Effect, Option, Schema } from "effect";
import { testStage } from "../infrastructure/stage.ts";

/** Disabled until the stage has an app-domain route and certificates; never fall back to another stage's domain. */
export const cloudAppUiBase = Config.String("EXECUTOR_APP_UI_BASE_URL").pipe(
  Config.option,
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.succeed(undefined),
      onSome: (base) => Schema.decodeUnknownEffect(AppUiBaseUrl)(base),
    }),
  ),
);

/** A task-local development port; production routing uses the configured app domain. */
export const cloudAppUiPort = Config.Number("CLOUD_DEV_APP_UI_PORT").pipe(
  Config.withDefault(4413),
  Effect.flatMap(
    Schema.decodeUnknownEffect(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  ),
);

/** A preview owns its dedicated suffix, so every team works without replacing the production route. */
export const cloudAppUiRoute = Effect.gen(function* () {
  const base = yield* cloudAppUiBase;
  if (base === undefined) return yield* Effect.die(new Error("App UI base is required"));
  const preview = yield* testStage;
  const hostname = new URL(base).hostname;
  if (Option.isSome(preview)) {
    const zone = yield* Config.NonEmptyString("EXECUTOR_APP_DOMAIN_ZONE");
    if (!hostname.endsWith(`.${zone}`))
      return yield* Effect.die(new Error("Test stages require a dedicated app-domain subdomain"));
  }
  return `*.${hostname}/*`;
});
