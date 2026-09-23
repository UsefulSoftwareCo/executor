/** Teardown does not evaluate application configuration or require build artifacts. */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Axiom from "alchemy/Axiom";
import * as Planetscale from "alchemy/Planetscale";
import * as Neon from "alchemy/Neon";
import { Effect, Layer, Schema } from "effect";
import { Stage } from "alchemy/Stage";
import { TestStageSlug } from "./src/infrastructure/stage.ts";
import { PreviousTestDatabaseCleanup } from "./src/infrastructure/previous-test-database-cleanup.ts";
import {
  TestStageBuildCleanup,
  TestStageBucketCleanup,
  TestStageDomainCleanup,
} from "./src/infrastructure/test-stage-cleanup-providers.ts";

const cleanupState = Layer.unwrap(
  Effect.gen(function* () {
    const stage = yield* Stage;
    if (!stage.startsWith("test-"))
      return yield* Effect.die(new Error("Cleanup is restricted to test stages."));
    yield* Schema.decodeUnknownEffect(TestStageSlug)(stage.slice(5)).pipe(Effect.orDie);
    return Cloudflare.state();
  }),
);
export default Alchemy.Stack(
  "executor-next-hosted",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Command.providers(),
      TestStageBuildCleanup(),
      TestStageBucketCleanup(),
      Axiom.providers(),
      Planetscale.providers(),
      Neon.providers(),
      TestStageDomainCleanup().pipe(Layer.provide(cleanupState)),
      PreviousTestDatabaseCleanup(),
    ),
    state: cleanupState,
  },
  Effect.succeed({}),
);
