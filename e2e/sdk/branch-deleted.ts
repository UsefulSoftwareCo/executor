/**
 * Prove that a deployed run's teardown deleted its PlanetScale branch. A teardown that could not
 * delete it (a branch PlanetScale refuses to delete, an expired credential) otherwise leaves a
 * branch that keeps billing while the run looks finished. This fails loudly and names the branch,
 * with a GitHub Actions error annotation when the run is in CI.
 */
import { Config, Console, Duration, Effect, Option, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { reveal, secretConfig } from "../support/failure-text.ts";

export class BranchNotDeleted extends Schema.TaggedError<BranchNotDeleted>()("BranchNotDeleted", {
  message: Schema.String,
}) {}

/** Why the branch's deletion is not confirmed yet. Fixed text only. */
class Unconfirmed extends Schema.TaggedError<Unconfirmed>()("Unconfirmed", {
  reason: Schema.String,
}) {}

/**
 * Waits for PlanetScale to answer 404 for the stage's branch: by default up to two minutes, every
 * 10 seconds. A branch PlanetScale still lists, a request that keeps failing and missing
 * credentials all end in the same `BranchNotDeleted`, which names the branch. Only the spec
 * passes another API or spacing, for its local stand-in.
 */
export const confirmBranchDeleted = (
  slug: string,
  options: {
    readonly api?: string;
    readonly spacing?: Duration.Input;
    readonly attempts?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const branch = `test-${slug}`;
    const api = options.api ?? "https://api.planetscale.com/v1";
    const status = yield* Effect.gen(function* () {
      const organization = yield* Config.NonEmptyString("PLANETSCALE_ORGANIZATION");
      const database = yield* Config.NonEmptyString("TEST_STAGE_DATABASE");
      const id = yield* secretConfig("PLANETSCALE_API_TOKEN_ID");
      const token = yield* secretConfig("PLANETSCALE_API_TOKEN");
      return { organization, database, authorization: `${reveal(id)}:${reveal(token)}` };
    }).pipe(
      Effect.mapError(
        () => new Unconfirmed({ reason: "the run has no PlanetScale credentials to check it" }),
      ),
      Effect.flatMap(({ organization, database, authorization }) =>
        Effect.gen(function* () {
          const http = yield* HttpClient.HttpClient;
          const response = yield* http
            .execute(
              HttpClientRequest.get(
                `${api}/organizations/${organization}/databases/${database}/branches/${branch}`,
              ).pipe(HttpClientRequest.setHeader("authorization", authorization)),
            )
            .pipe(
              Effect.mapError(
                () => new Unconfirmed({ reason: "PlanetScale could not be reached" }),
              ),
            );
          if (response.status !== 404)
            return yield* new Unconfirmed({
              reason: `PlanetScale still answers ${response.status}`,
            });
          return response.status;
        }).pipe(
          Effect.retry({
            schedule: Schedule.spaced(options.spacing ?? "10 seconds"),
            times: options.attempts ?? 12,
          }),
        ),
      ),
      Effect.catchTag("Unconfirmed", ({ reason }) =>
        Effect.gen(function* () {
          const message = `PlanetScale branch ${branch} was not confirmed deleted after its teardown (${reason}). If it is still there, it keeps billing until someone with permission deletes it.`;
          const ci = yield* Config.String("GITHUB_ACTIONS").pipe(Config.option);
          if (Option.isSome(ci))
            yield* Console.error(`::error title=Leftover PlanetScale branch::${message}`);
          return yield* new BranchNotDeleted({ message });
        }),
      ),
    );
    yield* Console.log(`PlanetScale branch ${branch} is deleted (PlanetScale answers ${status}).`);
  });
