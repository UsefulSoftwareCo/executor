import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import {
  Config,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Stream,
} from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { scenarios } from "../test-plan.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { freePort, holdPort, refusingPort } from "../support/ports.ts";
import { localEntryCommand } from "../support/local-entry.ts";

const nothingChanged = "Nothing was changed.";
const desktopHint =
  "If Executor desktop is running, use its File > Open in browser menu item instead.";
const KeyFile = Schema.fromJsonString(Schema.Struct({ apiKey: Schema.String }));
const notExecutor = (port: number) =>
  `Something is listening on 127.0.0.1:${port}, but it did not answer as an Executor server. Run \`executor service status\` to see where the background Executor listens.`;
const noServer = (directory: string) =>
  `No background Executor is running for ${directory}. Start it with \`executor\` or \`executor service start\`.`;

layer(TestLive, { excludeTestServices: true })("Local pair", (it) => {
  it.effect(
    scenarios.localPair.title,
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
          const registry = yield* Config.NonEmptyString("E2E_NPM_REGISTRY").pipe(Config.option);
          const command = (
            args: ReadonlyArray<string>,
            directory: string,
            port: number,
            extra: Readonly<Record<string, string>> = {},
          ) =>
            ChildProcess.make(
              localEntryCommand(entry, args).command,
              localEntryCommand(entry, args).args,
              {
                cwd: path.dirname(entry),
                extendEnv: false,
                env: {
                  PATH: process.env.PATH ?? "",
                  DO_NOT_TRACK: "1",
                  EXECUTOR_ENVIRONMENT: "e2e",
                  EXECUTOR_KEY_STORAGE: "file",
                  EXECUTOR_WORKER_BUNDLE: path.resolve(".local/test-runtime/host.json"),
                  ...(Option.isSome(registry) ? { EXECUTOR_NPM_REGISTRY: registry.value } : {}),
                  EXECUTOR_DATA_DIR: directory,
                  EXECUTOR_PORT: String(port),
                  ...extra,
                },
                stdout: "pipe",
                stderr: "pipe",
                forceKillAfter: "3 seconds",
              },
            );
          const run = (
            args: ReadonlyArray<string>,
            directory: string,
            port: number,
            extra: Readonly<Record<string, string>> = {},
          ) =>
            evidence.step(
              `executor ${args.join(" ")} (${path.basename(directory)}, port ${port})`,
              Effect.scoped(
                Effect.gen(function* () {
                  const child = yield* processes.spawn(command(args, directory, port, extra));
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
          const pair = (
            directory: string,
            port: number,
            extra: Readonly<Record<string, string>> = {},
          ) => run(["service", "pair"], directory, port, extra);
          const keyFiles = (directory: string) =>
            Effect.forEach(["installation.json", "keys.json"], (name) =>
              fs.readFileString(path.join(directory, name)),
            );

          const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-pair-" });
          const running = path.join(root, "running");
          const missing = path.join(root, "missing");
          const port = yield* freePort;
          const link = new RegExp(`^http://127\\.0\\.0\\.1:${port}/#pair=[a-f0-9]{64}$`, "u");
          const afterRotation = yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* processes.spawn(command(["serve"], running, port));
              const ready = yield* Deferred.make<void>();
              const log = yield* Ref.make("");
              yield* Stream.merge(server.stdout, server.stderr).pipe(
                Stream.decodeText(),
                Stream.splitLines,
                Stream.runForEach((line) =>
                  Effect.gen(function* () {
                    yield* Ref.update(
                      log,
                      (before) =>
                        `${before}${line.replace(/#pair=[a-f0-9]{64}/gu, "#pair=<redacted>")}\n`,
                    );
                    if (line === `Executor: http://127.0.0.1:${port}`)
                      yield* Deferred.succeed(ready, undefined);
                  }),
                ),
                Effect.forkScoped,
              );
              yield* Effect.raceFirst(
                Deferred.await(ready),
                server.exitCode.pipe(
                  Effect.flatMap((code) =>
                    Effect.fail(new Error(`executor serve exited before readiness (${code})`)),
                  ),
                ),
              ).pipe(
                Effect.timeout("90 seconds"),
                Effect.tapError(() =>
                  Ref.get(log).pipe(
                    Effect.flatMap((text) => evidence.json("serve.json", { text })),
                  ),
                ),
              );

              const before = yield* keyFiles(running);
              const paired = yield* pair(running, port);
              expect(paired.code, paired.stderr).toBe(0);
              expect(paired.stdout.trim()).toMatch(link);
              expect(yield* keyFiles(running)).toEqual(before);

              const serverOnly = yield* pair(running, port, {
                EXECUTOR_MCP_TIMEOUT_MS: "not-a-number",
              });
              expect(serverOnly.code, serverOnly.stderr).toBe(0);
              expect(serverOnly.stdout.trim()).toMatch(link);
              for (const other of [String(yield* refusingPort), "not-a-port"]) {
                const elsewhere = yield* pair(running, port, { EXECUTOR_PORT: other });
                expect(elsewhere.code, elsewhere.stderr).toBe(0);
                expect(elsewhere.stdout.trim()).toMatch(link);
              }

              const refused = yield* pair(missing, port);
              yield* evidence.json("no-server.json", refused);
              expect(refused.code).toBe(1);
              expect(refused.stderr).toContain(noServer(missing));
              expect(refused.stderr).toContain(desktopHint);
              expect(refused.stderr).toContain(nothingChanged);
              expect(refused.stderr).not.toContain("Executor could not start");
              expect(yield* fs.exists(missing)).toBe(false);

              const supplied = yield* pair(running, port, {
                EXECUTOR_API_KEY: randomBytes(32).toString("hex"),
              });
              yield* evidence.json("key-rejected.json", supplied);
              expect(supplied.code).toBe(1);
              expect(supplied.stderr).toContain(
                `The Executor server on 127.0.0.1:${port} did not accept the supplied EXECUTOR_API_KEY.`,
              );
              expect(supplied.stderr).toContain(nothingChanged);
              expect(yield* keyFiles(running)).toEqual(before);

              const { apiKey } = yield* fs
                .readFileString(path.join(running, "keys.json"))
                .pipe(Effect.flatMap(Schema.decodeUnknownEffect(KeyFile)));
              const suppliedPaired = yield* pair(missing, port, { EXECUTOR_API_KEY: apiKey });
              expect(suppliedPaired.code, suppliedPaired.stderr).toBe(0);
              expect(suppliedPaired.stdout.trim()).toMatch(link);
              expect(yield* fs.exists(missing)).toBe(false);

              const badPort = yield* pair(missing, port, {
                EXECUTOR_API_KEY: apiKey,
                EXECUTOR_PORT: "not-a-port",
              });
              yield* evidence.json("invalid-port.json", badPort);
              expect(badPort.code).toBe(1);
              expect(badPort.stderr).toContain(
                "EXECUTOR_PORT must be a port number from 1 to 65535: the port the running server listens on. Nothing was changed.",
              );
              expect(badPort.stderr).not.toContain("Executor could not start");
              const silentPort = yield* refusingPort;
              const silent = yield* pair(missing, silentPort, { EXECUTOR_API_KEY: apiKey });
              yield* evidence.json("no-server-on-port.json", silent);
              expect(silent.code).toBe(1);
              expect(silent.stderr).toContain(noServer(missing));
              expect(silent.stderr).not.toContain("already in use");

              const rotated = yield* run(["service", "rotate-key"], running, port);
              expect(rotated.code, rotated.stderr).toBe(0);
              expect(rotated.stdout).toContain(
                "Rotated the local API key. Run `executor service restart` to use it, then update clients that used the previous key.",
              );
              const rotatedKeys = yield* keyFiles(running);
              expect(rotatedKeys).not.toEqual(before);
              const afterRotating = yield* pair(running, port);
              expect(afterRotating.code, afterRotating.stderr).toBe(0);
              expect(afterRotating.stdout.trim()).toMatch(link);
              expect(yield* keyFiles(running)).toEqual(rotatedKeys);

              const services = yield* Layer.build(
                HttpRouter.serve(
                  HttpRouter.add(
                    "*",
                    "/auth/pair",
                    HttpServerResponse.text("<h1>Not Executor</h1>", {
                      status: 404,
                      contentType: "text/html",
                    }),
                  ),
                  { disableLogger: true, disableListenLog: true },
                ).pipe(
                  Layer.provideMerge(
                    NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }),
                  ),
                ),
              );
              const foreign = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
              if (!("port" in foreign.address))
                return yield* Effect.die("Fixture must listen on TCP");
              const unexpected = yield* pair(missing, foreign.address.port, {
                EXECUTOR_API_KEY: apiKey,
              });
              yield* evidence.json("not-executor.json", unexpected);
              expect(unexpected.code).toBe(1);
              expect(unexpected.stderr).toContain(notExecutor(foreign.address.port));
              expect(unexpected.stderr).toContain(nothingChanged);

              for (const [name, onConnection] of [
                ["resets-connection", (socket) => socket.resetAndDestroy()],
                ["never-answers", (socket) => socket.on("error", () => {}).resume()],
              ] as const satisfies ReadonlyArray<
                readonly [string, Parameters<typeof holdPort>[1]]
              >) {
                const other = yield* Effect.scoped(
                  Effect.gen(function* () {
                    const otherPort = yield* holdPort(0, onConnection);
                    return {
                      port: otherPort,
                      result: yield* pair(missing, otherPort, { EXECUTOR_API_KEY: apiKey }),
                    };
                  }),
                );
                yield* evidence.json(`${name}.json`, other.result);
                expect(other.result.code).toBe(1);
                expect(other.result.stderr).toContain(notExecutor(other.port));
                expect(other.result.stderr).not.toContain("No background Executor is running");
              }
              return rotatedKeys;
            }),
          );

          expect(yield* fs.exists(path.join(running, "server.json"))).toBe(
            process.platform === "win32",
          );
          const stopped = yield* pair(running, port);
          yield* evidence.json("stopped.json", stopped);
          expect(stopped.code).toBe(1);
          expect(stopped.stderr).toContain(noServer(running));
          expect(yield* keyFiles(running)).toEqual(afterRotation);
        }),
      ),
    { timeout: 240_000 },
  );
});
