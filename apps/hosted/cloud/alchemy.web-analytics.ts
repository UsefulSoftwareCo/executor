import * as Alchemy from "alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import { retain } from "alchemy/RemovalPolicy";
import { Stage } from "alchemy/Stage";
import { Effect } from "effect";

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
      const zone = yield* Cloudflare.Zone.findZoneByName({ accountId, name }).pipe(Effect.orDie);
      if (!zone) return yield* Effect.die(new Error(`Cloudflare zone ${name} is missing`));
      yield* Cloudflare.Rum.Site(`${id}WebAnalytics`, {
        zoneTag: zone.id,
        autoInstall: false,
        enabled: false,
      }).pipe(adopt(), retain());
    }
  }),
);
