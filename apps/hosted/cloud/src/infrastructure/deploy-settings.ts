import { Config, Effect, Option, Schema } from "effect";
import { productionStage, productZone, stageName } from "./stage.ts";

export const productionSocialCallbackOrigin = `https://${productZone}`;

export class DeploySettingRejected extends Schema.TaggedError<DeploySettingRejected>()(
  "DeploySettingRejected",
  { message: Schema.String },
) {}

/**
 * Production's `OAUTH_PROXY_PRODUCTION_URL` must be `https://executor.sh`. Before the move to
 * `app.executor.sh` it named `https://v2.executor.sh`; the Worker refuses that value at startup,
 * because production would proxy its own sign-ins to itself.
 */
export const productionOAuthProxyCheck = Effect.gen(function* () {
  if (Option.getOrUndefined(yield* stageName) !== productionStage) return;
  const configured = yield* Config.String("OAUTH_PROXY_PRODUCTION_URL").pipe(Config.option);
  const value = Option.getOrElse(configured, () => "");
  if (value === productionSocialCallbackOrigin) return;
  return yield* new DeploySettingRejected({
    message:
      `OAUTH_PROXY_PRODUCTION_URL is ${value === "" ? "unset" : `"${value}"`}; production needs ` +
      `"${productionSocialCallbackOrigin}", where its social sign-ins return. Apply ` +
      "apps/hosted/cloud/alchemy.github.ts, which sets the production GitHub variable, then " +
      "deploy again. Nothing was deployed.",
  });
});
