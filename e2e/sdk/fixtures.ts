import {
  Cause,
  Config,
  Duration,
  Effect,
  Fiber,
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
import { mask, reveal, safeText, secret } from "../support/failure-text.ts";
export { FixtureControl, FixtureActor, FixtureActors } from "./contracts.ts";

export class FixtureFailed extends Schema.TaggedError<FixtureFailed>()("FixtureFailed", {
  operation: Schema.String,
  status: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.Literals(["timeout", "transport"])),
  code: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
}) {
  override get message() {
    return `Fixture ${this.operation} failed${this.status === undefined ? (this.reason === undefined ? "" : ` (${this.reason})`) : ` (HTTP ${this.status})`}${this.detail === undefined ? "" : `: ${this.detail}`}`;
  }
}

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

const socketCode = (error: unknown, depth = 0): string | undefined => {
  if (depth > 6 || typeof error !== "object" || error === null) return undefined;
  const value = error as { code?: unknown; reason?: unknown; cause?: unknown };
  if (typeof value.code === "string" && /^E[A-Z0-9_]+$/u.test(value.code)) return value.code;
  return socketCode(value.reason, depth + 1) ?? socketCode(value.cause, depth + 1);
};

export const fixtureControlFromEnvironment = Config.String("E2E_FIXTURES").pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FixtureControl))),
);

const quotedLines = 30;

export const startFixtureControl = (
  origin: string,
  directory: string,
  browserOrigin: string = roleHost(origin, "app"),
  {
    script = "apps/hosted/testing/scenario-server.ts",
    readyWithin = "10 seconds",
  }: { readonly script?: string; readonly readyWithin?: Duration.Input } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const output = path.resolve(directory, `fixture-${randomBytes(8).toString("hex")}.json`);
    const token = secret(randomBytes(32).toString("hex"));
    const log = path.resolve(directory, "fixtures.log");
    yield* fs.writeFileString(log, "", { flag: "a", mode: 0o600 });
    const before = Number((yield* fs.stat(log)).size);
    const child = yield* processes.spawn(
      ChildProcess.make("node", [script], {
        extendEnv: false,
        env: {
          PATH: process.env.PATH ?? "",
          TEST_FIXTURE_ORIGIN: origin,
          TEST_FIXTURE_BROWSER_ORIGIN: browserOrigin,
          TEST_FIXTURE_OUTPUT: output,
          TEST_FIXTURE_TOKEN: reveal(token),
        },
        stdout: "pipe",
        stderr: "pipe",
        forceKillAfter: "10 seconds",
      }),
    );
    const drain = yield* Stream.merge(child.stdout, child.stderr).pipe(
      Stream.decodeText(),
      Stream.runForEach((text) => fs.writeFileString(log, text, { flag: "a", mode: 0o600 })),
      Effect.forkScoped,
    );
    const quoted = fs.readFile(log).pipe(
      Effect.map((bytes) => {
        const masked = mask(new TextDecoder().decode(bytes.subarray(before))).trimEnd();
        return masked.trim() === ""
          ? "it printed nothing"
          : `the end of what it printed (${log}):\n${safeText(masked.split("\n").slice(-quotedLines).join("\n"))}`;
      }),
      Effect.orElseSucceed(() => `its output could not be read (${log})`),
    );
    const ready = fs.readFileString(output).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Struct({ origin: FixtureControl.fields.origin })),
        ),
      ),
      Effect.retry({ schedule: Schedule.spaced("100 millis") }),
      Effect.map((value) => ({ ready: true as const, origin: value.origin })),
      Effect.timeout(readyWithin),
    );
    const exited = child.exitCode.pipe(Effect.map((code) => ({ ready: false as const, code })));
    const first = yield* Effect.raceFirst(ready, exited).pipe(
      Effect.catchIf(Cause.isTimeoutError, () => Effect.succeed(undefined)),
    );
    if (first?.ready === true) return { origin: first.origin, token };
    if (first === undefined)
      return yield* new FixtureFailed({
        operation: "start",
        detail: `${script} was still running after ${Duration.format(Duration.fromInputUnsafe(readyWithin))} and had not written its address to ${output}; ${yield* quoted}`,
      });
    yield* Fiber.join(drain).pipe(Effect.timeout("2 seconds"), Effect.ignore);
    return yield* new FixtureFailed({
      operation: "start",
      detail: `${script} exited with code ${Number(first.code)} before it wrote its address; ${yield* quoted}`,
    });
  });

export const fixtureControlEnvironment = (control: typeof FixtureControl.Type) =>
  JSON.stringify({ origin: control.origin, token: reveal(control.token) });
