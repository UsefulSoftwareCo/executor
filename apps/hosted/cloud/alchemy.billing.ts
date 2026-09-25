/** Persistent V2 billing catalog. Autumn creates and owns the matching Stripe prices. */
import * as Alchemy from "alchemy";
import { stackState } from "./src/infrastructure/state.ts";
import { retain } from "alchemy/RemovalPolicy";
import { Stage } from "alchemy/Stage";
import { Config, Effect } from "effect";
import {
  billingCatalogDeclaration,
  type BillingPlanDeclaration,
} from "./src/contracts/billing-catalog.ts";
import {
  AutumnFeature,
  AutumnPlan,
  autumnProviders,
} from "./src/infrastructure/autumn-provider.ts";

export default Alchemy.Stack(
  "executor-next-billing",
  {
    providers: autumnProviders(),
    state: stackState,
  },
  Effect.gen(function* () {
    const stage = yield* Stage;
    if (!/^[a-z0-9-]+$/.test(stage))
      return yield* Effect.die("Billing stage must be a lowercase slug");
    const environment = yield* Config.Literals(["sandbox", "live"], "AUTUMN_ENVIRONMENT");
    // The same declaration a private Autumn instance is seeded with; only the transport differs.
    const { catalog, features, plans } = billingCatalogDeclaration(stage, environment);
    // Features are created first so a plan never references an identity Autumn has not seen.
    const members = yield* AutumnFeature("Members", features.members).pipe(retain());
    const domainVerification = yield* AutumnFeature(
      "DomainVerification",
      features.domainVerification,
    ).pipe(retain());
    const resources = new Map([
      [catalog.members, members],
      [catalog.domainVerification, domainVerification],
    ]);
    const items = (plan: BillingPlanDeclaration) =>
      plan.items.map((item) => {
        const feature = resources.get(item.featureId);
        if (feature === undefined) throw new Error("Plan references an undeclared feature");
        // Output references establish the provisioning dependency in Alchemy's graph.
        return { ...item, featureId: feature.featureId };
      });
    yield* AutumnPlan("Free", { ...plans.free, items: items(plans.free) }).pipe(retain());
    yield* AutumnPlan("Team", { ...plans.team, items: items(plans.team) }).pipe(retain());
    yield* AutumnPlan("Enterprise", {
      ...plans.enterprise,
      items: items(plans.enterprise),
    }).pipe(retain());
    return catalog;
  }),
);
