/** Run Executor 1 commands through the real Executor 2 CLI and check each names its replacement. */
import { expect, layer } from "@effect/vitest";
import { Config, Effect, FileSystem, Option, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { scenarios } from "../test-plan.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { localEntryCommand } from "../support/local-entry.ts";

const dashboard =
  "In Executor 2, run `executor` to start the local server and open its dashboard. If the server is already running, run `executor pair` and open the link it prints.";
const headless = "Run `executor serve` to start the local server without opening a browser";
const service = "Executor 2 cannot run as a background service yet. Keep `executor serve` running";
const mcp = "Executor 2 serves MCP over HTTP from the running server.";
const tools = "Executor 2 runs tools through MCP.";
const endpoint = "http://127.0.0.1:4312/mcp";
const pairing = "run `executor pair` while the server is running";
const profiles = "Executor 2 has no server profiles.";
const login = "run `executor apps login --host https://api.executor.sh`";

/** Executor 1 invocations, the command each must name, and the replacement it must show. */
const cases = [
  { args: ["web"], command: "web", replacement: dashboard },
  { args: ["daemon", "run"], command: "daemon", replacement: headless },
  { args: ["service", "start"], command: "service", replacement: service },
  { args: ["service", "install"], command: "service", replacement: service },
  { args: ["install"], command: "install", replacement: service },
  { args: ["mcp"], command: "mcp", replacement: `${mcp} Start the server` },
  { args: ["open"], command: "open", replacement: pairing },
  { args: ["call", "return 1"], command: "call", replacement: tools },
  { args: ["tools", "search", "github"], command: "tools", replacement: tools },
  { args: ["resume"], command: "resume", replacement: tools },
  // Effect's typo suggestion pointed `executor server` at `serve` too.
  { args: ["server", "list"], command: "server", replacement: profiles },
  { args: ["server", "rotate-token"], command: "server", replacement: "`executor rotate-key`" },
  { args: ["login"], command: "login", replacement: login },
  { args: ["docs"], command: "docs", replacement: "https://executor.sh/docs" },
  // Executor 1's own flags, such as the README's `executor web --foreground`, reach the hint.
  { args: ["web", "--foreground"], command: "web", replacement: dashboard },
  {
    args: ["web", "--port=4788", "--allowed-host", "a", "--allowed-host", "b"],
    command: "web",
    replacement: dashboard,
  },
  { args: ["install", "--port", "4788", "--boot"], command: "install", replacement: service },
  {
    args: ["daemon", "run", "--port", "4788", "--foreground"],
    command: "daemon",
    replacement: headless,
  },
  { args: ["mcp", "--scope", "x", "--no-artifacts"], command: "mcp", replacement: mcp },
  {
    args: ["server", "add", "prod", "https://example.test", "--default"],
    command: "server",
    replacement: profiles,
  },
] as const;

layer(TestLive, { excludeTestServices: true })("Local CLI legacy commands", (it) => {
  it.effect(
    scenarios.localCliLegacyCommands.title,
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
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "executor-legacy-cli-" });
          const data = path.join(home, "data");
          const run = (args: ReadonlyArray<string>) =>
            evidence.step(
              `executor ${args.join(" ")}`,
              Effect.scoped(
                Effect.gen(function* () {
                  const child = yield* processes.spawn(
                    ChildProcess.make(
                      localEntryCommand(entry, args).command,
                      localEntryCommand(entry, args).args,
                      {
                        extendEnv: false,
                        env: {
                          PATH: process.env.PATH ?? "",
                          HOME: home,
                          USERPROFILE: home,
                          // Release scenarios never send product analytics, even from a build with a baked key.
                          DO_NOT_TRACK: "1",
                          EXECUTOR_DATA_DIR: data,
                        },
                        stdout: "pipe",
                        stderr: "pipe",
                        forceKillAfter: "3 seconds",
                      },
                    ),
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

          for (const { args, command, replacement } of cases) {
            const result = yield* run(args);
            yield* evidence.json(`${args.join(" ").replaceAll(/[^a-z0-9]+/gu, "-")}.json`, result);
            expect(result.code, result.stderr).toBe(1);
            expect(result.stderr).toContain(`\`executor ${command}\` is an Executor 1 command.`);
            expect(result.stderr).toContain(replacement);
            // Effect's typo suggestion pointed `executor service` at `serve`, the wrong command.
            expect(result.stderr).not.toContain("Did you mean");
            expect(result.stderr).not.toContain("Unknown subcommand");
            expect(result.stderr).not.toContain("Executor could not start");
            expect(result.stdout).toBe("");
            if (command === "mcp" || replacement === tools)
              expect(result.stderr).toContain(endpoint);
          }

          // None of these commands opened or created the data directory.
          expect(yield* fs.exists(data)).toBe(false);

          // Help lists only Executor 2 commands, and typos still suggest them.
          const help = yield* run(["--help"]);
          expect(help.code, help.stderr).toBe(0);
          const listed = help.stdout
            .split("\n")
            .flatMap((line) => /^ {2}([a-z][a-z-]*)\s/u.exec(line)?.slice(1, 2) ?? []);
          expect(listed).toEqual(expect.arrayContaining(["apps", "serve", "pair", "rotate-key"]));
          for (const { command } of cases) expect(listed).not.toContain(command);
          const typo = yield* run(["sevre"]);
          expect(typo.code).toBe(1);
          expect(typo.stderr).toContain("serve");
          expect(typo.stderr).not.toContain("Executor 1");
        }),
      ),
    // Each of these commands starts the CLI once; every one has its own timeout.
    { timeout: 180_000 },
  );
});
