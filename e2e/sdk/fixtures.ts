/** Fixture control is loopback-only. Test callers receive sessions, never database credentials. */
import {
  Cause,
  Config,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient, HttpClientRequest } from "effect/http";
import { randomBytes } from "node:crypto";
import { FixtureControl } from "./contracts.ts";
import { roleHost } from "../support/role-hosts.ts";
import { reveal, secret } from "../support/failure-text.ts";
export { FixtureControl, FixtureActor, FixtureActors } from "./contracts.ts";

/**
 * Safe errors describe the control operation without the capability or response body. A clean-up
 * step's 400 adds what failed and where (`detail`), which the fixture server builds only from its
 * own phrases, error class names and error codes; it is decoded against that shape here, so
 * nothing else in a body can reach the message.
 */
export class FixtureFailed extends Schema.TaggedError<FixtureFailed>()("FixtureFailed", {
  operation: Schema.String,
  status: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.Literals(["timeout", "transport"])),
  /** A transport failure's socket error code, such as `ECONNREFUSED`; never its message. */
  code: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
}) {
  override get message() {
    return `Fixture ${this.operation} failed${this.status === undefined ? (this.reason === undefined ? "" : ` (${this.reason})`) : ` (HTTP ${this.status})`}${this.detail === undefined ? "" : `: ${this.detail}`}`;
  }
}

/** Letters, digits, spaces and `.,'()_-`: never a URL, a connection string or a token. */
const SafeText = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9 .,'()_-]{1,200}$/u));
const CleanupFailure = Schema.fromJsonString(
  Schema.Struct({
    phase: Schema.Literals([
      "find-organization",
      "start-removal",
      "confirm-accepted",
      "confirm-unreachable",
    ]),
    cause: SafeText,
  }),
);

/** Invoke an authenticated local control operation with bounded lifetime. */
export const fixtureRequest = (
  control: typeof FixtureControl.Type,
  path: string,
  payload?: unknown,
  timeout: Duration.Input = "60 seconds",
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      let request = HttpClientRequest.make(payload === undefined ? "GET" : "POST")(
        `${control.origin}${path}`,
      ).pipe(HttpClientRequest.bearerToken(control.token));
      if (payload !== undefined) request = yield* HttpClientRequest.bodyJson(request, payload);
      const response = yield* http.execute(request);
      if (response.status !== 200) {
        const failure = Schema.decodeUnknownOption(CleanupFailure)(
          yield* response.text.pipe(Effect.orElseSucceed(() => "")),
        );
        return yield* new FixtureFailed({
          operation: path,
          status: response.status,
          ...(Option.isSome(failure)
            ? { detail: `${failure.value.cause} (${failure.value.phase})` }
            : {}),
        });
      }
      return yield* response.json;
    }),
  ).pipe(
    Effect.timeout(timeout),
    Effect.mapError((cause) =>
      Schema.is(FixtureFailed)(cause)
        ? cause
        : Cause.isTimeoutError(cause)
          ? new FixtureFailed({ operation: path, reason: "timeout" })
          : new FixtureFailed({
              operation: path,
              reason: "transport",
              ...(socketCode(cause) === undefined ? {} : { code: socketCode(cause) }),
            }),
    ),
  );

/** The first socket error code along a cause chain (`reason`, `cause`), such as `ECONNREFUSED`. */
const socketCode = (error: unknown, depth = 0): string | undefined => {
  if (depth > 6 || typeof error !== "object" || error === null) return undefined;
  const value = error as { code?: unknown; reason?: unknown; cause?: unknown };
  if (typeof value.code === "string" && /^E[A-Z0-9_]+$/u.test(value.code)) return value.code;
  return socketCode(value.reason, depth + 1) ?? socketCode(value.cause, depth + 1);
};

/** Parse the private capability supplied by an environment owner to a test process. */
export const fixtureControlFromEnvironment = Config.String("E2E_FIXTURES").pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FixtureControl))),
);

/**
 * Start a scoped fixture process before configuring its database through the one-use setup route.
 * `browserOrigin` is where Cloud serves its dashboard: `app.` of `origin` unless the run starts it
 * elsewhere, as under its rollback switch.
 */
export const startFixtureControl = (
  origin: string,
  directory: string,
  browserOrigin: string = roleHost(origin, "app"),
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const output = path.resolve(directory, `fixture-${randomBytes(8).toString("hex")}.json`);
    const token = secret(randomBytes(32).toString("hex"));
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["apps/hosted/testing/scenario-server.ts"], {
        extendEnv: false,
        env: {
          PATH: process.env.PATH ?? "",
          TEST_FIXTURE_ORIGIN: origin,
          // Cloud's dashboard API takes cookie writes only from its browser origin.
          TEST_FIXTURE_BROWSER_ORIGIN: browserOrigin,
          TEST_FIXTURE_OUTPUT: output,
          TEST_FIXTURE_TOKEN: reveal(token),
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
  JSON.stringify({ origin: control.origin, token: reveal(control.token) });
