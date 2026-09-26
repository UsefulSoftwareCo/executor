/**
 * Own a retained perf stage's fixture authority for the lifetime of this process.
 *
 * The stage deploy transfers its database and signing settings to a loopback fixture process that
 * this command starts first. The command stays in the foreground afterwards so benchmark runs can
 * mint synthetic sessions through the private control file. Stopping it only closes the fixture
 * process; the retained stage keeps running until it is explicitly destroyed.
 */
import { Clock, Console, Effect, FileSystem, Path, Redacted, Schedule, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient } from "effect/unstable/http";
import { startFixtureControl, fixtureControlEnvironment } from "../../sdk/fixtures.ts";

export class StageFailed extends Schema.TaggedError<StageFailed>()("StageFailed", {
  message: Schema.String,
}) {}

/** Private control file shared by the benchmark commands; mode 0600, never committed. */
export const StageControl = Schema.Struct({
  slug: Schema.String,
  origin: Schema.String,
  fixture: Schema.Struct({ origin: Schema.String, token: Schema.String }),
  commit: Schema.String,
  deployedAt: Schema.String,
});
export type StageControl = typeof StageControl.Type;

export const perfSlug = Schema.String.check(
  Schema.isPattern(/^perf-[a-z0-9-]+-0925$/, {
    message: "Perf stages for this run are named perf-<key>-0925",
  }),
);

export const readStageControl = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs
      .readFileString(file)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(StageControl))));
  });

export const serveStage = (input: {
  readonly slug: string;
  readonly control: string;
  readonly database: "neon" | "planetscale";
  readonly deploy: boolean;
}) =>
  Effect.gen(function* () {
    const slug = yield* Schema.decodeUnknownEffect(perfSlug)(input.slug);
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const origin = `https://${slug}.executor.engineering`;
    const directory = path.dirname(path.resolve(input.control));
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const commit = (yield* spawner.string(ChildProcess.make("git", ["rev-parse", "HEAD"]))).trim();
    const fixtures = yield* startFixtureControl(origin, directory);
    if (!input.deploy)
      return yield* new StageFailed({
        message: "A fresh fixture process needs a deploy to receive the stage's settings",
      });
    const started = yield* Clock.currentTimeMillis;
    yield* Console.log(`Deploying ${origin} from ${commit} (${input.database}).`);
    const code = Number(
      yield* spawner.exitCode(
        ChildProcess.make(
          "bun",
          [
            "run",
            "test-stage",
            "deploy",
            slug,
            "--database",
            input.database,
            "--retention",
            "retained",
            "--background",
            "active",
            "--owner",
            "Perf harness 0925",
            "--no-input",
            "--yes",
          ],
          {
            cwd: path.resolve("apps/hosted/cloud"),
            env: {
              CI: "true",
              TEST_STAGE_DOMAIN: "executor.engineering",
              TEST_STAGE_FIXTURE_CONTROL: fixtureControlEnvironment(fixtures),
            },
            extendEnv: true,
            stdout: "inherit",
            stderr: "inherit",
          },
        ),
      ),
    );
    yield* Console.log(
      `Deploy finished in ${Math.round(((yield* Clock.currentTimeMillis) - started) / 1000)} s (exit ${code}).`,
    );
    if (code !== 0) return yield* new StageFailed({ message: `Deploy failed with exit ${code}` });
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    yield* http.get(`${origin}/health`).pipe(
      Effect.retry(Schedule.spaced("2 seconds")),
      Effect.timeout("3 minutes"),
      Effect.mapError(() => new StageFailed({ message: "Stage health did not become ready" })),
    );
    yield* fs.writeFileString(
      input.control,
      JSON.stringify({
        slug,
        origin,
        fixture: { origin: fixtures.origin, token: Redacted.value(fixtures.token) },
        commit,
        deployedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      } satisfies StageControl),
      { mode: 0o600 },
    );
    yield* Effect.addFinalizer(() => fs.remove(input.control, { force: true }).pipe(Effect.orDie));
    yield* Console.log(`Ready: ${origin}. Fixture control: ${input.control}. Ctrl-C to release.`);
    return yield* Effect.never;
  });
