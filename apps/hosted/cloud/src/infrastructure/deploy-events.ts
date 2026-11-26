import { Config, Duration, Effect, Option, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientError } from "effect/http";
import { productionStage } from "./stage.ts";

export const deployEventsDataset = `executor-next-${productionStage}-deploys`;
export const deployEventsTokenSecret = "AXIOM_DEPLOY_EVENTS_TOKEN";
export const deployEventsUrlVariable = "AXIOM_DEPLOY_EVENTS_URL";

export const DeployOutcome = Schema.Literals(["success", "failure", "cancelled"]);
export type DeployOutcome = typeof DeployOutcome.Type;
export const DeployTrigger = Schema.Literals(["push", "workflow_dispatch"]);
export type DeployTrigger = typeof DeployTrigger.Type;

export const DeployCommit = Schema.Struct({
  sha: Schema.String,
  title: Schema.String,
  pr: Schema.NullOr(Schema.Number),
  author: Schema.NullOr(Schema.String),
});
export type DeployCommit = typeof DeployCommit.Type;

export const DeployEvent = Schema.Struct({
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
  commits: Schema.Array(DeployCommit),
});
export type DeployEvent = typeof DeployEvent.Type;

const titleLength = 200;
const pullRequestSuffix = /\(#(\d+)\)\s*$/u;

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

export const runAttemptUrl = (repository: string, runId: number, attempt: number) =>
  `https://github.com/${repository}/actions/runs/${runId}/attempts/${attempt}`;

export class DeployEventsFailed extends Schema.TaggedError<DeployEventsFailed>()(
  "DeployEventsFailed",
  { message: Schema.String, retryable: Schema.Boolean },
) {}

const exchangeTimeout = Duration.seconds(15);

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

export const ingestDeployEvents = (events: ReadonlyArray<DeployEvent>) =>
  Effect.gen(function* () {
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
