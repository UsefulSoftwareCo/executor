/**
 * The local CLI's command names: help lists the Executor 2 commands, `pair` and `rotate-key` live
 * under `executor service`, and Executor 1's commands, and the old top-level names, are unknown.
 */
import { expect, layer } from "@effect/vitest";
import { Config, Effect, FileSystem, Option, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { scenarios } from "../test-plan.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { localEntryCommand } from "../support/local-entry.ts";

/** The command names a help page lists. */
const listed = (help: string) =>
  help.split("\n").flatMap((line) => /^ {2}([a-z][a-z-]*)\s/u.exec(line)?.slice(1, 2) ?? []);

layer(TestLive, { excludeTestServices: true })("Local CLI commands", (it) => {
  it.effect(
    scenarios.localCliCommandNames.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem,
            path = yield* Path.Path,
            processes = yield* ChildProcessSpawner.ChildProcessSpawner,
            evidence = yield* Evidence;
          const packagedEntry = yield* Config.NonEmptyString("EXECUTOR_E2E_LOCAL_ENTRY").pipe(
            Config.option,
          );
          const entry = path.resolve(
            Option.isSome(packagedEntry) ? packagedEntry.value : "apps/local/server/src/bin.ts",
          );
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "executor-cli-commands-" });
          const data = path.join(home, "data");
          const run = (args: ReadonlyArray<string>) =>
            evidence.step(
              `executor ${args.join(" ")}`,
              Effect.scoped(
                Effect.gen(function* () {
                  const command = localEntryCommand(entry, args);
                  const child = yield* processes.spawn(
                    ChildProcess.make(command.command, command.args, {
                      extendEnv: false,
                      env: {
                        PATH: process.env.PATH ?? "",
                        HOME: home,
                        USERPROFILE: home,
                        DO_NOT_TRACK: "1",
                        EXECUTOR_DATA_DIR: data,
                      },
                      stdout: "pipe",
                      stderr: "pipe",
                      forceKillAfter: "3 seconds",
                    }),
                  );
                  const [code, stdout, stderr] = yield* Effect.all(
                    [
                      child.exitCode,
                      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
                      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
                    ],
                    { concurrency: 3 },
                  ).pipe(Effect.timeout("30 seconds"));
                  return { code: Number(code), stdout, stderr };
                }),
              ),
            );

          const help = yield* run(["--help"]);
          expect(help.code, help.stderr).toBe(0);
          const commands = listed(help.stdout);
          expect(commands).toEqual(
            expect.arrayContaining([
              "apps",
              "login",
              "logout",
              "whoami",
              "search",
              "describe",
              "call",
              "execute",
              "resume",
              "skills",
              "mcp",
              "serve",
              "service",
              "upgrade",
            ]),
          );
          for (const moved of ["pair", "rotate-key"]) expect(commands).not.toContain(moved);
          const service = yield* run(["service", "--help"]);
          expect(service.code, service.stderr).toBe(0);
          expect(listed(service.stdout)).toEqual(
            expect.arrayContaining(["start", "stop", "status", "pair", "rotate-key"]),
          );
          const apps = yield* run(["apps", "--help"]);
          expect(apps.code, apps.stderr).toBe(0);
          expect(listed(apps.stdout)).not.toContain("skills");

          // Executor 1's commands and the old names are plain unknown commands.
          for (const args of [["web"], ["daemon", "run"], ["tools"], ["pair"], ["rotate-key"]]) {
            const result = yield* run(args);
            expect(result.code, result.stderr).toBe(1);
            expect(result.stderr).toContain("Unknown subcommand");
            expect(result.stderr).not.toContain("Executor 1");
          }
          const removed = yield* run(["apps", "skills"]);
          expect(removed.code).toBe(1);
          expect(removed.stderr).toContain("Unknown subcommand");

          // None of these commands opened or created the data directory.
          expect(yield* fs.exists(data)).toBe(false);
        }),
      ),
    { timeout: 120_000 },
  );
});
