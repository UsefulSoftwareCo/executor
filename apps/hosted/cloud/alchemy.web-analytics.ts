/**
 * Cloudflare turns on Web Analytics for new zones and injects its beacon into every proxied
 * HTML page. PostHog is the product's analytics, and ad blockers reject the beacon, so each
 * product zone keeps its Web Analytics site with edge injection off. Deploy manually with
 * `alchemy deploy alchemy.web-analytics.ts --stage shared` and the Agents vault's
 * "Cloudflare API Token"; the CI deploy token has no Web Analytics access.
 */
import * as Alchemy from "alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import { retain } from "alchemy/RemovalPolicy";
import { Stage } from "alchemy/Stage";
import { Effect } from "effect";

/** Production pages, then test-stage pages. */
const zones = [
  { id: "Product", name: "executor.sh" },
  { id: "TestStages", name: "executor.engineering" },
];

export default Alchemy.Stack(
  "executor-web-analytics",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    if ((yield* Stage) !== "shared") return yield* Effect.die(new Error("Use the shared stage."));
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    for (const { id, name } of zones) {
      // A concrete zone ID lets the plan find and adopt the site Cloudflare created.
      const zone = yield* Cloudflare.Zone.findZoneByName({ accountId, name }).pipe(Effect.orDie);
      if (!zone) return yield* Effect.die(new Error(`Cloudflare zone ${name} is missing`));
      // `enabled: false` is the switch that stops edge injection; `autoInstall` alone does not.
      yield* Cloudflare.Rum.Site(`${id}WebAnalytics`, {
        zoneTag: zone.id,
        autoInstall: false,
        enabled: false,
      }).pipe(adopt(), retain());
    }
  }),
);
