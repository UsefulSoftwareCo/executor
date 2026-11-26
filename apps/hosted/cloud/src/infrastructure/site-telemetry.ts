import * as Output from "alchemy/Output";
import { Effect } from "effect";
import { productionStage } from "./stage.ts";

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

export const siteTelemetryBinding = (
  analyticsProxy: Output.Output<string | null>,
  errorTunnel: Output.Output<string | null>,
) => ({
  EXECUTOR_SITE_TELEMETRY: Output.all(analyticsProxy, errorTunnel).pipe(
    Output.map(([proxy, tunnel]) => JSON.stringify({ analyticsProxy: proxy, errorTunnel: tunnel })),
  ),
});
