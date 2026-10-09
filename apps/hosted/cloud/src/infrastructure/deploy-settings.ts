/**
 * Deploy settings checked before anything deploys. A setting the running Worker would refuse at
 * startup fails here instead, with the variable, its value and the value it needs, so a stale
 * GitHub variable stops the deploy rather than the product.
 */
import { Config, Effect, Option, Schema } from "effect";
import { productionStage, productZone, stageName } from "./stage.ts";

/**
 * Where production's social sign-ins return: v1's edge on `executor.sh`, which forwards
 * `/api/auth/callback/<provider>` to v2 (`notes/cloud-domains.md`). It is the OAuth proxy's
 * production URL for production and the test stages that sign in through it, whichever host
 * serves sign-in (`CLOUD_BROWSER_ORIGIN`).
 */
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
