import { Effect } from "effect";
import { startDeployment } from "./deployment.ts";
import { runSuite } from "./suite.ts";

/** Deploy once, run the selected committed cases in parallel, and await owned environment cleanup. */
export const runDeployedSuite = (input: {
  readonly database: "neon" | "planetscale";
  readonly name: string;
  readonly workers: number;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const environment = yield* startDeployment({ database: input.database });
      return yield* runSuite({
        target: "cloud",
        name: input.name,
        workers: input.workers,
        attachment: environment,
      });
    }),
  );
