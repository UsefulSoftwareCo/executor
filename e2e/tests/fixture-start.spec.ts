/**
 * A fixture process that does not come up says why (`startFixtureControl`, e2e/sdk/fixtures.ts):
 * whether it exited or was still running when the wait ran out, with the end of what it printed,
 * masked, and its whole output in `fixtures.log`. On a slow disk the real fixture once took 12 s
 * to write its address, past the 10 s wait, and the run said only that the file was not found.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, FileSystem, Path, Schema } from "effect";
import { startFixtureControl, FixtureFailed } from "../sdk/fixtures.ts";

const origin = "http://localhost:1";

/** A fixture stand-in written to its own directory, and a directory for the run's files. */
const setup = (source: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fixture-start-" });
    const script = path.join(directory, "fixture.mjs");
    yield* fs.writeFileString(script, source);
    return { directory, script, log: path.join(directory, "fixtures.log") };
  });

const failure = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) throw new Error("the fixture start succeeded");
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error;
  if (!Schema.is(FixtureFailed)(error)) throw new Error(`not a FixtureFailed: ${String(error)}`);
  return error;
};

// No test services: the wait and its retries run on the real clock, as in a run.
layer(NodeServices.layer, { excludeTestServices: true })("Fixture process start", (it) => {
  it.effect("a fixture that exits first says so, with its exit code and what it printed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { directory, script, log } = yield* setup(
        "console.error(\"Error: Cannot find module 'pg'\");\nprocess.exit(3);\n",
      );
      const error = failure(
        yield* Effect.exit(startFixtureControl(origin, directory, undefined, { script })),
      );
      expect(error.message).toContain(`Fixture start failed: ${script} exited with code 3`);
      expect(error.message).toContain("Error: Cannot find module 'pg'");
      expect(yield* fs.readFileString(log)).toContain("Cannot find module 'pg'");
    }).pipe(Effect.scoped),
  );

  it.effect("a fixture still starting when the wait runs out says so, with what it printed", () =>
    Effect.gen(function* () {
      const { directory, script } = yield* setup(
        'console.log("loading modules");\nsetInterval(() => {}, 1 << 30);\n',
      );
      const error = failure(
        yield* Effect.exit(
          startFixtureControl(origin, directory, undefined, { script, readyWithin: "1 second" }),
        ),
      );
      expect(error.message).toContain(`${script} was still running after 1s`);
      expect(error.message).toContain("loading modules");
    }).pipe(Effect.scoped),
  );

  it.effect("a silent fixture is named as silent, and its log is there, empty", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { directory, script, log } = yield* setup("setInterval(() => {}, 1 << 30);\n");
      const error = failure(
        yield* Effect.exit(
          startFixtureControl(origin, directory, undefined, { script, readyWithin: "1 second" }),
        ),
      );
      expect(error.message).toContain("it printed nothing");
      expect(yield* fs.readFileString(log)).toBe("");
    }).pipe(Effect.scoped),
  );

  it.effect("an earlier start's output in a reused directory is kept, never quoted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { directory, script, log } = yield* setup("process.exit(3);\n");
      yield* fs.writeFileString(log, "output of an earlier start\n");
      const error = failure(
        yield* Effect.exit(startFixtureControl(origin, directory, undefined, { script })),
      );
      expect(error.message).toContain(`${script} exited with code 3`);
      expect(error.message).toContain("it printed nothing");
      expect(error.message).not.toContain("earlier start");
      expect(yield* fs.readFileString(log)).toBe("output of an earlier start\n");
    }).pipe(Effect.scoped),
  );

  it.effect("the quoted output never holds the control token", () =>
    Effect.gen(function* () {
      const { directory, script } = yield* setup(
        "console.log(`token ${process.env.TEST_FIXTURE_TOKEN}`);\nprocess.exit(1);\n",
      );
      const error = failure(
        yield* Effect.exit(startFixtureControl(origin, directory, undefined, { script })),
      );
      expect(error.message).toContain("token <secret>");
      expect(error.message).not.toMatch(/[a-f0-9]{64}/u);
    }).pipe(Effect.scoped),
  );

  it.effect("no piece of the control token survives where the quote or a line is cut", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // The token at the start of a long last line, after a long prefix on a line cut at its
      // length limit, and on a line far above the quoted tail.
      for (const [label, print] of [
        ["before a long line", 'say(token + "\\n" + ".".repeat(3978))'],
        ["at a cut line", 'say("x".repeat(390) + token)'],
        ["above the tail", 'say(token + "\\n" + "line\\n".repeat(200))'],
      ] as const) {
        const { directory, script } = yield* setup(
          'import { writeFileSync } from "node:fs";\n' +
            'import { dirname, join } from "node:path";\n' +
            "const token = process.env.TEST_FIXTURE_TOKEN;\n" +
            'writeFileSync(join(dirname(process.env.TEST_FIXTURE_OUTPUT), "token.txt"), token);\n' +
            'const say = (text) => process.stdout.write(text + "\\n");\n' +
            `${print};\n` +
            "process.stdout.end(() => process.exit(1));\n",
        );
        const error = failure(
          yield* Effect.exit(startFixtureControl(origin, directory, undefined, { script })),
        );
        const token = yield* fs.readFileString(`${directory}/token.txt`);
        expect(token).toMatch(/^[a-f0-9]{64}$/u);
        for (let at = 0; at + 8 <= token.length; at++)
          expect(error.message, label).not.toContain(token.slice(at, at + 8));
        expect(error.message, label).toContain("exited with code 1");
      }
    }).pipe(Effect.scoped),
  );

  it.effect(
    "an exit is named as an exit even when its output is written slower than the wait",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { directory, script } = yield* setup(
          'console.error("startup failed");\nprocess.exit(3);\n',
        );
        // Every write of output to fixtures.log takes 1.5 s, longer than the 1 s wait.
        const slow: FileSystem.FileSystem = {
          ...fs,
          writeFileString: (file, data, options) =>
            data === ""
              ? fs.writeFileString(file, data, options)
              : fs.writeFileString(file, data, options).pipe(Effect.delay("1500 millis")),
        };
        const error = failure(
          yield* Effect.exit(
            startFixtureControl(origin, directory, undefined, {
              script,
              readyWithin: "1 second",
            }).pipe(Effect.provideService(FileSystem.FileSystem, slow)),
          ),
        );
        expect(error.message).toContain(`${script} exited with code 3`);
        expect(error.message).toContain("startup failed");
      }).pipe(Effect.scoped),
  );

  it.effect("a fixture that writes its address is ready", () =>
    Effect.gen(function* () {
      const { directory, script } = yield* setup(
        'import { writeFileSync } from "node:fs";\n' +
          'writeFileSync(process.env.TEST_FIXTURE_OUTPUT, JSON.stringify({ origin: "http://127.0.0.1:9" }));\n' +
          "setInterval(() => {}, 1 << 30);\n",
      );
      const control = yield* startFixtureControl(origin, directory, undefined, { script });
      expect(control.origin).toBe("http://127.0.0.1:9");
    }).pipe(Effect.scoped),
  );
});
