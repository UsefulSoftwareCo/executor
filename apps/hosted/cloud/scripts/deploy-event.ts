/**
 * Records one attempt of a Deploy run as one event in the deploys dataset
 * (`src/infrastructure/deploy-events.ts`). `.github/workflows/deploy-events.yml` runs it when a
 * Deploy run on `main` completes, apart from the deploy, so it can neither delay nor fail it.
 *
 * It builds the event from GitHub's API with `deployEventOf`, as the backfill does, so both give
 * the same event for the same run attempt. An attempt that never reached its deploy step, as when
 * a newer push cancelled the run before it started, records nothing.
 *
 * Reads:
 * - `DEPLOY_RUN_ID` and `DEPLOY_RUN_ATTEMPT`: the attempt to record.
 * - `GITHUB_REPOSITORY` and `GITHUB_TOKEN`, which needs Actions and Contents read.
 * - `AXIOM_TOKEN` and `AXIOM_DEPLOY_EVENTS_URL`: where the event goes.
 *
 * `--dry-run` prints the event and sends nothing:
 *
 *   GITHUB_REPOSITORY=UsefulSoftwareCo/executor-next GITHUB_TOKEN="$(gh auth token)" \
 *     DEPLOY_RUN_ID=<run id> DEPLOY_RUN_ATTEMPT=<attempt> \
 *     node apps/hosted/cloud/scripts/deploy-event.ts --dry-run
 */
import { parseArgs } from "node:util";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Config, Console, Effect, Option } from "effect";
import { FetchHttpClient } from "effect/http";
import { deployEventsDataset, ingestDeployEvents } from "../src/infrastructure/deploy-events.ts";
import { deployEventOf, makeDeployHistory } from "../src/infrastructure/deploy-history.ts";

const program = Effect.gen(function* () {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
  const repository = yield* Config.NonEmptyString("GITHUB_REPOSITORY");
  const runId = yield* Config.Int("DEPLOY_RUN_ID");
  const number = yield* Config.Int("DEPLOY_RUN_ATTEMPT");

  const history = yield* makeDeployHistory(repository);
  const event = yield* deployEventOf(history, yield* history.run(runId), number);
  if (Option.isNone(event))
    return yield* Console.log(
      `Run ${runId} attempt ${number} has no deploy step of its own; nothing to record.`,
    );
  if (values["dry-run"]) return yield* Console.log(JSON.stringify(event.value));
  yield* ingestDeployEvents([event.value]);
  yield* Console.log(
    `Recorded the ${event.value.outcome} deploy of ${event.value.sha} (run ${runId} attempt ${number}) with ${event.value.commits.length} commit(s) in ${deployEventsDataset}.`,
  );
});

NodeRuntime.runMain(program.pipe(Effect.provide(FetchHttpClient.layer)));
