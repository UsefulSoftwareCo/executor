/** Fixture control is loopback-only. Test callers receive sessions, never database credentials. */
import { Config, Effect, FileSystem, Path, Redacted, Schedule, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { randomBytes } from "node:crypto";
import { FixtureControl } from "./contracts.ts";
export { FixtureControl, FixtureActor, FixtureActors } from "./contracts.ts";

/** Safe errors describe the control operation without the capability or response body. */
export class FixtureFailed extends Schema.TaggedError<FixtureFailed>()("FixtureFailed", {
  operation: Schema.String,
}) {}

/** Invoke an authenticated local control operation with bounded lifetime. */
export const fixtureRequest = (
  control: typeof FixtureControl.Type,
  path: string,
  payload?: unknown,
  timeout: "60 seconds" | "5 minutes" = "60 seconds",
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      let request = HttpClientRequest.make(payload === undefined ? "GET" : "POST")(
        `${control.origin}${path}`,
      ).pipe(HttpClientRequest.bearerToken(control.token));
      if (payload !== undefined) request = yield* HttpClientRequest.bodyJson(request, payload);
      const response = yield* http.execute(request);
      if (response.status !== 200) return yield* new FixtureFailed({ operation: path });
      return yield* response.json;
    }),
  ).pipe(
    Effect.timeout(timeout),
    Effect.mapError(() => new FixtureFailed({ operation: path })),
  );

/** Parse the private capability supplied by an environment owner to a test process. */
export const fixtureControlFromEnvironment = Config.String("E2E_FIXTURES").pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FixtureControl))),
);

/** Start a scoped fixture process before configuring its database through the one-use setup route. */
export const startFixtureControl = (origin: string, directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const output = path.resolve(directory, `fixture-${randomBytes(8).toString("hex")}.json`);
    const token = Redacted.make(randomBytes(32).toString("hex"));
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["apps/hosted/testing/scenario-server.ts"], {
        extendEnv: false,
        env: {
          PATH: process.env.PATH ?? "",
          TEST_FIXTURE_ORIGIN: origin,
          TEST_FIXTURE_OUTPUT: output,
          TEST_FIXTURE_TOKEN: Redacted.value(token),
        },
        stdout: "pipe",
        stderr: "pipe",
        forceKillAfter: "10 seconds",
      }),
    );
    yield* Stream.merge(child.stdout, child.stderr).pipe(
      Stream.decodeText(),
      Stream.runForEach((text) =>
        fs.writeFileString(`${directory}/fixtures.log`, text, { flag: "a", mode: 0o600 }),
      ),
      Effect.forkScoped,
    );
    const ready = fs
      .readFileString(output)
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Struct({ origin: FixtureControl.fields.origin })),
          ),
        ),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
      );
    const value = yield* Effect.raceFirst(
      ready,
      child.exitCode.pipe(
        Effect.flatMap(() =>
          Effect.fail(new FixtureFailed({ operation: "Fixture process stopped before readiness" })),
        ),
      ),
    );
    return { origin: value.origin, token };
  });

/** Encode only the generated local capability for a private process boundary. */
export const fixtureControlEnvironment = (control: typeof FixtureControl.Type) =>
  JSON.stringify({ origin: control.origin, token: Redacted.value(control.token) });
