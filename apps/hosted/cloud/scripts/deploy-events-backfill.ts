/**
 * One-off: builds the deploy events (`src/infrastructure/deploy-events.ts`) of the Deploy
 * workflow's past runs on `main`, one per run attempt whose deploy job reached its deploy step. It
 * builds each one with `deployEventOf`, as the recorder does, so an attempt the recorder also sent
 * gets the same event.
 *
 *   GITHUB_TOKEN="$(gh auth token)" node apps/hosted/cloud/scripts/deploy-events-backfill.ts --dry-run
 *
 * `--dry-run` prints the events as JSON lines and sends nothing. Without it the events go to
 * `AXIOM_DEPLOY_EVENTS_URL` with `AXIOM_TOKEN`, a short-lived API token (`notes/ci.md`).
 * `--days` sets how far back to read runs, by when they were created (90 by default).
 */
import { parseArgs } from "node:util";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Array as Arr, Console, DateTime, Effect, Option } from "effect";
import { FetchHttpClient } from "effect/http";
import {
  DeployOutcome,
  deployEventsDataset,
  ingestDeployEvents,
} from "../src/infrastructure/deploy-events.ts";
import {
  deployEventOf,
  listSpansBetween,
  makeDeployHistory,
} from "../src/infrastructure/deploy-history.ts";

const repository = "UsefulSoftwareCo/executor-next";
const concurrency = 8;

const program = Effect.gen(function* () {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      days: { type: "string", default: "90" },
    },
  });
  if (!/^[1-9]\d*$/u.test(values.days)) return yield* Effect.die("Pass --days <whole days>");
  const now = yield* DateTime.now;
  const since = DateTime.subtract(now, { days: Number(values.days) });

  const history = yield* makeDeployHistory(repository);
  const listed = yield* Effect.forEach(listSpansBetween(since, now), history.runsCreatedIn, {
    concurrency,
  });
  const runs = listed
    .flat()
    .filter((run) => DateTime.isGreaterThanOrEqualTo(run.created_at, since));
  const attempts = runs.flatMap((run) =>
    Arr.makeBy(run.run_attempt, (index) => ({ run, number: index + 1 })),
  );
  const events = (yield* Effect.forEach(
    attempts,
    ({ run, number }) => deployEventOf(history, run, number),
    { concurrency },
  ))
    .filter(Option.isSome)
    .map((event) => event.value)
    .toSorted((a, b) => a.finishedAt.localeCompare(b.finishedAt));

  const outcomes = DeployOutcome.literals
    .map((outcome) => `${events.filter((event) => event.outcome === outcome).length} ${outcome}`)
    .join(", ");
  yield* Console.error(
    `${events.length} deploy attempts (${outcomes}) from ${runs.length} runs created since ${DateTime.formatIsoDate(since)}.`,
  );
  if (values["dry-run"]) {
    for (const event of events) yield* Console.log(JSON.stringify(event));
    return;
  }
  for (const batch of Arr.chunksOf(events, 1000)) yield* ingestDeployEvents(batch);
  yield* Console.error(`Sent ${events.length} events to ${deployEventsDataset}.`);
});

NodeRuntime.runMain(program.pipe(Effect.provide(FetchHttpClient.layer)));
