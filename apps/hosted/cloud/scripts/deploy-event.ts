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
