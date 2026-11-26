import { AppUiBaseUrl } from "@executor-js/hosted-server/app-ui";
import { Config, Effect, Option, Schema } from "effect";
import { testStage } from "../infrastructure/stage.ts";

export const cloudAppUiBase = Config.String("EXECUTOR_APP_UI_BASE_URL").pipe(
  Config.option,
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.succeed(undefined),
      onSome: (base) => Schema.decodeUnknownEffect(AppUiBaseUrl)(base),
    }),
  ),
);

export const cloudAppUiPort = Config.Number("CLOUD_DEV_APP_UI_PORT").pipe(
  Config.withDefault(4413),
  Effect.flatMap(
    Schema.decodeUnknownEffect(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  ),
);

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
