/**
 * The site's browser telemetry paths on the edge (`contracts/edge-paths.ts`). Production's are
 * pinned in the contract v1 implements, so a `v2` deploy whose telemetry outputs name other paths
 * fails instead of leaving v1 forwarding the old ones.
 */
import * as Output from "alchemy/Output";
import { Effect } from "effect";
import { productionStage } from "./stage.ts";

/** Fail a production deploy whose telemetry output differs from the path v1's edge forwards. */
export const pinnedInProduction =
  (stage: string, output: string, pinned: string) => (value: string) =>
    stage === productionStage && value !== pinned
      ? Effect.die(
          new Error(
            `${output} is ${value}, but v1's edge forwards ${pinned} for production ` +
              "(productionSiteTelemetry in contracts/edge-paths.ts). Change both, and v1's " +
              "pinned contract, together.",
          ),
        )
      : Effect.succeed(value);

/** The JSON a test stage's edge reads to forward its telemetry paths, as v1 forwards production's. */
export const siteTelemetryBinding = (
  analyticsProxy: Output.Output<string | null>,
  errorTunnel: Output.Output<string | null>,
) => ({
  EXECUTOR_SITE_TELEMETRY: Output.all(analyticsProxy, errorTunnel).pipe(
    Output.map(([proxy, tunnel]) => JSON.stringify({ analyticsProxy: proxy, errorTunnel: tunnel })),
  ),
});
