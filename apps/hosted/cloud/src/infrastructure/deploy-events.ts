/**
 * Production deploy events: one Axiom event per attempt of the Deploy workflow, so charts can
 * overlay each deploy's window and the commits it shipped (`notes/ci.md`, "Deploy events").
 *
 * The deploy events stack (`alchemy.deploy-events.ts`) creates the dataset and an ingest-only token
 * for it, and stores both where the recorder reads them. `deploy-history.ts` builds an attempt's
 * event from GitHub. `scripts/deploy-event.ts` records one attempt after its Deploy run completes
 * (`.github/workflows/deploy-events.yml`); `scripts/deploy-events-backfill.ts` builds the same
 * events for past runs.
 */
import { Config, Duration, Effect, Option, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientError } from "effect/http";
import { productionStage } from "./stage.ts";

/** The dataset the deploy events go to. Its name follows the stage's telemetry datasets. */
export const deployEventsDataset = `executor-next-${productionStage}-deploys`;
/** The repository secret holding the dataset's ingest-only token. */
export const deployEventsTokenSecret = "AXIOM_DEPLOY_EVENTS_TOKEN";
/** The repository variable holding the dataset's ingest URL on its Axiom edge deployment. */
export const deployEventsUrlVariable = "AXIOM_DEPLOY_EVENTS_URL";

export const DeployOutcome = Schema.Literals(["success", "failure", "cancelled"]);
export type DeployOutcome = typeof DeployOutcome.Type;
export const DeployTrigger = Schema.Literals(["push", "workflow_dispatch"]);
export type DeployTrigger = typeof DeployTrigger.Type;

export const DeployCommit = Schema.Struct({
  sha: Schema.String,
  /** The first line of the message, at most 200 characters. */
  title: Schema.String,
  /** The pull request a trailing `(#1234)` in the title names. */
  pr: Schema.NullOr(Schema.Number),
  /** The GitHub login of the commit's author, when GitHub matched one. */
  author: Schema.NullOr(Schema.String),
});
export type DeployCommit = typeof DeployCommit.Type;

export const DeployEvent = Schema.Struct({
  /** When the deploy step finished. */
  _time: Schema.String,
  kind: Schema.Literal("deploy"),
  stage: Schema.Literal(productionStage),
  sha: Schema.String,
  startedAt: Schema.String,
  finishedAt: Schema.String,
  outcome: DeployOutcome,
  runId: Schema.Number,
  runAttempt: Schema.Number,
  runUrl: Schema.String,
  trigger: DeployTrigger,
  /** Oldest first; the deployed commit is last. */
  commits: Schema.Array(DeployCommit),
});
export type DeployEvent = typeof DeployEvent.Type;

const titleLength = 200;
const pullRequestSuffix = /\(#(\d+)\)\s*$/u;

/** A commit as the event records it: its title, the pull request it names and its author. */
export const deployCommit = (sha: string, message: string, author: string | null): DeployCommit => {
  const line = message.split(/\r?\n/u, 1)[0] ?? "";
  const pr = pullRequestSuffix.exec(line)?.[1];
  return {
    sha,
    title: Array.from(line).slice(0, titleLength).join(""),
    pr: pr === undefined ? null : Number(pr),
    author,
  };
};

export const deployEvent = (
  fields: Omit<DeployEvent, "_time" | "kind" | "stage">,
): DeployEvent => ({
  _time: fields.finishedAt,
  kind: "deploy",
  stage: productionStage,
  sha: fields.sha,
  startedAt: fields.startedAt,
  finishedAt: fields.finishedAt,
  outcome: fields.outcome,
  runId: fields.runId,
  runAttempt: fields.runAttempt,
  runUrl: fields.runUrl,
  trigger: fields.trigger,
  commits: fields.commits,
});

/** The page of one run attempt, which GitHub keeps after a rerun. */
export const runAttemptUrl = (repository: string, runId: number, attempt: number) =>
  `https://github.com/${repository}/actions/runs/${runId}/attempts/${attempt}`;

export class DeployEventsFailed extends Schema.TaggedError<DeployEventsFailed>()(
  "DeployEventsFailed",
  { message: Schema.String, retryable: Schema.Boolean },
) {}

const exchangeTimeout = Duration.seconds(15);

/**
 * One request to GitHub or Axiom, given as sending it, checking its status and reading and decoding
 * its body. All of that runs inside one 15-second timeout, so a response that sends its headers and
 * then stalls times out as well. A timeout, a failure in transit or a `retryable` failure is retried
 * twice. The recorder runs apart from the deploy, but this still bounds how long it waits.
 */
export const exchange = <A, R>(
  service: string,
  attempt: Effect.Effect<
    A,
    DeployEventsFailed | HttpClientError.HttpClientError | Schema.SchemaError,
    R
  >,
) =>
  attempt.pipe(
    Effect.timeout(exchangeTimeout),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new DeployEventsFailed({ message: `${service} did not answer in time`, retryable: true }),
      ),
    ),
    Effect.catchTag("HttpClientError", () =>
      Effect.fail(
        new DeployEventsFailed({ message: `${service} request failed`, retryable: true }),
      ),
    ),
    Effect.retry({
      times: 2,
      schedule: Schedule.exponential("1 second"),
      while: (error) => error instanceof DeployEventsFailed && error.retryable,
    }),
  );

const IngestStatus = Schema.Struct({ ingested: Schema.Number, failed: Schema.Number });

/**
 * Sends events to `AXIOM_DEPLOY_EVENTS_URL` with `AXIOM_TOKEN`: the dataset's ingest-only token in
 * the recorder, or a short-lived API token for a backfill (`notes/ci.md`). Retries a request that
 * failed in transit, timed out or that Axiom answered with 429 or 5xx. A retried request may have
 * been stored, so readers deduplicate on `runId` and `runAttempt`.
 */
export const ingestDeployEvents = (events: ReadonlyArray<DeployEvent>) =>
  Effect.gen(function* () {
    // Actions passes an unset secret or variable as an empty value, which Config reads as absent.
    const url = yield* Config.NonEmptyString(deployEventsUrlVariable).pipe(Config.option);
    const token = yield* Config.Redacted("AXIOM_TOKEN").pipe(Config.option);
    if (Option.isNone(url) || Option.isNone(token))
      return yield* new DeployEventsFailed({
        message: `${deployEventsUrlVariable} and AXIOM_TOKEN are required. The recorder reads them from the ${deployEventsUrlVariable} variable and the ${deployEventsTokenSecret} secret, which the deploy events stack stores (bun run deploy-events:deploy).`,
        retryable: false,
      });
    const organization = yield* Config.String("AXIOM_ORG_ID").pipe(Config.withDefault(""));
    const client = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.post(url.value).pipe(
      HttpClientRequest.bearerToken(token.value),
      HttpClientRequest.setHeaders(organization === "" ? {} : { "x-axiom-org-id": organization }),
      HttpClientRequest.bodyJson(events),
    );
    const status = yield* exchange(
      "Axiom",
      Effect.gen(function* () {
        const response = yield* client.execute(request);
        if (response.status !== 200)
          return yield* new DeployEventsFailed({
            message: `Axiom answered ${response.status}`,
            retryable: response.status === 429 || response.status >= 500,
          });
        return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(IngestStatus)));
      }),
    );
    if (status.failed > 0 || status.ingested !== events.length)
      return yield* new DeployEventsFailed({
        message: `Axiom stored ${status.ingested} of ${events.length} events`,
        retryable: false,
      });
    return status.ingested;
  });
