/** Cloud app hostnames are operator-provisioned separately from the dashboard's CDN origin. */
import { AppUiBaseUrl } from "@executor-js/hosted-server/app-ui";
import { Config, Effect, Option, Schema } from "effect";
import { OrganizationSlug } from "@executor-js/hosted-server/organization";
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

/** A preview owns only its synthetic organization's app hosts, never the zone-wide production route. */
export const cloudAppUiRoute = Effect.gen(function* () {
  const base = yield* cloudAppUiBase;
  if (base === undefined) return yield* Effect.die(new Error("App UI base is required"));
  const preview = yield* testStage;
  if (Option.isNone(preview)) return `*.${new URL(base).hostname}/*`;
  const organization = yield* Config.String("TEST_STAGE_APP_ORGANIZATION").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(OrganizationSlug)),
  );
  return `*--${organization}.${new URL(base).hostname}/*`;
});
