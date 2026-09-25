import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Schedule, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { Evidence } from "../support/evidence.ts";
import { scenarios } from "../test-plan.ts";

layer(TestLive, { excludeTestServices: true })("Testing CLI", (it) => {
  it.effect(scenarios.testingCli.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          fs = yield* FileSystem.FileSystem,
          evidence = yield* Evidence,
          processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const handle = `${target.directory}/cli.json`;
        const cli = (args: readonly string[]) =>
          evidence.step(
            `Testing CLI: ${args[0]}`,
            Effect.scoped(
              Effect.gen(function* () {
                const command = yield* processes.spawn(
                  ChildProcess.make("node", ["e2e/cli.ts", ...args, "--handle", handle], {
                    stdout: "pipe",
                    stderr: "inherit",
                  }),
                );
                const [text, code] = yield* Effect.all(
                  [
                    command.stdout.pipe(
                      Stream.decodeText(),
                      Stream.runFold(
                        () => "",
                        (text, chunk) => text + chunk,
                      ),
                    ),
                    command.exitCode,
                  ],
                  { concurrency: 2 },
                );
                expect(Number(code), `CLI ${args[0]} exit code`).toBe(0);
                return text;
              }),
            ),
          );
        const child = yield* processes.spawn(
          ChildProcess.make(
            "node",
            [
              "e2e/cli.ts",
              "start",
              "--headless",
              "--target",
              target.metadata.target,
              "--handle",
              handle,
            ],
            { stdout: "pipe", stderr: "pipe", forceKillAfter: "15 seconds" },
          ),
        );
        yield* Stream.merge(child.stdout, child.stderr).pipe(
          Stream.decodeText(),
          Stream.runForEach((text) =>
            fs.writeFileString(`${target.directory}/cli.log`, text, { flag: "a" }),
          ),
          Effect.forkScoped,
        );
        yield* fs
          .readFileString(handle)
          .pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }));
        const created = yield* cli(["create", "--label", "CLI scenario"]).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Struct({ id: Schema.String, origin: Schema.String })),
            ),
          ),
        );
        const response = yield* cli([
          "request",
          "--id",
          created.id,
          "--path",
          target.metadata.target === "local" ? "/dashboard/api/overview" : "/api/viewer",
          "--role",
          "member",
        ]).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Struct({ status: Schema.Number })),
            ),
          ),
        );
        expect(response.status).toBe(200);
        if (target.metadata.target === "self-host") {
          const receipt = yield* cli([
            "seed",
            "--id",
            created.id,
            "--shape",
            JSON.stringify({ seed: 7, apps: 2, accounts: 4, records: 20 }),
          ]).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.fromJsonString(Schema.Struct({ accounts: Schema.Array(Schema.String) })),
              ),
            ),
          );
          expect(receipt.accounts).toHaveLength(4);
        }
        const opened = yield* cli(["open", "--id", created.id, "--role", "member"]).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Struct({ opened: Schema.Boolean })),
            ),
          ),
        );
        expect(opened.opened).toBe(true);
        yield* cli(["remove", "--id", created.id]);
        expect(
          yield* cli(["list"]).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.Unknown))),
            ),
          ),
        ).toHaveLength(0);
        yield* cli(["stop"]);
        expect(Number(yield* child.exitCode)).toBe(0);
        expect(yield* fs.exists(handle)).toBe(false);
      }),
    ),
  );
});
