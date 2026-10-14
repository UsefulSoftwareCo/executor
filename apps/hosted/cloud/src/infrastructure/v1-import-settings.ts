/**
 * The v1 import's production switch (`notes/v1-import.md`), shared by the CI stack that stores it
 * for production and the Worker that reads it. `off`, the default, keeps every import request
 * answering `V1ImportUnavailable` on production even though the Worker can reach v1. `on` lets
 * production read v1's WorkOS, database, Autumn and blob bucket for the import. Only production
 * reaches v1, so any other deployed stage refuses `on`; emulated Cloud ignores the switch.
 */
import { Config, Schema } from "effect";

export const V1ImportSwitch = Schema.Literals(["off", "on"]);
export type V1ImportSwitch = typeof V1ImportSwitch.Type;

/** GitHub Actions passes an unset variable as an empty string; the deploy maps that to `off`. */
export const v1ImportSetting = Config.Literals(V1ImportSwitch.literals, "CLOUD_V1_IMPORT").pipe(
  Config.withDefault<V1ImportSwitch>("off"),
);

/**
 * v1's plugin blob bucket (v1's `apps/cloud/wrangler.jsonc`, binding `BLOBS`). v1 owns it in the
 * same Cloudflare account as v2; this stack only binds it, as `V1_BLOBS`, and never declares it.
 */
export const v1BlobBucket = "executor-cloud-blobs";

/**
 * v1's dashboard origin. v1 serves each organization's dashboard at `/<slug>` on it
 * (`apps/cloud/src/routes/{-$orgSlug}` in v1), which the v2 sidebar links back to after an import.
 */
export const v1DashboardOrigin = "https://executor.sh";

/** What to unset when a stage other than production turns the import on. */
export const v1ImportOnlyProduction =
  "CLOUD_V1_IMPORT=on reads v1's production data, which only the production stage (v2) " +
  "reaches; unset it on this stage";
