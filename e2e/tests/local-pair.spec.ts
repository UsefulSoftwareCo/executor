/** Run the real `executor pair` beside a server the scenario starts with its own data directory. */
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
/** What pair says about something on the port that is not a working Executor server. */
const notExecutor = (port: number) =>
  `Something is listening on 127.0.0.1:${port}, but it did not answer as an Executor server.`;

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
          // Startup deploys the bundled Executor app, which pins this checkout's apps release.
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
                // A working directory inside the scenario's folder could not be removed on Windows
                // while a stopped child finishes exiting.
                cwd: path.dirname(entry),
                extendEnv: false,
                env: {
                  PATH: process.env.PATH ?? "",
                  // Release scenarios never send product analytics, even from a build with a baked key.
                  DO_NOT_TRACK: "1",
                  EXECUTOR_ENVIRONMENT: "e2e",
                  // Keys stay in keys.json so no run touches the machine's OS credential store.
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
          /** Run one CLI command to exit and return its code and complete output. */
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
          ) => run(["pair"], directory, port, extra);
          /** Every file under a directory with its contents, to show a command changed nothing. */
          const snapshot = (directory: string) =>
            Effect.gen(function* () {
              const entries = (yield* fs.readDirectory(directory, { recursive: true })).toSorted();
              const files: Array<readonly [string, string]> = [];
              for (const name of entries) {
                const file = path.join(directory, name);
                if ((yield* fs.stat(file)).type === "File")
                  files.push([name, yield* fs.readFileString(file)]);
              }
              return files;
            });
          /** A running server writes its own databases; its key files are what pairing must keep. */
          const keyFiles = (directory: string) =>
            Effect.forEach(["installation.json", "keys.json"], (name) =>
              fs.readFileString(path.join(directory, name)),
            );

          const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-pair-" });
          const running = path.join(root, "running");
          const port = yield* freePort;
          const link = new RegExp(`^http://127\\.0\\.0\\.1:${port}/#pair=[a-f0-9]{64}$`, "u");
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
              Ref.get(log).pipe(Effect.flatMap((text) => evidence.json("serve.json", { text }))),
            ),
          );

          // The running server's own directory pairs, and pairing leaves that directory as it was.
          const before = yield* keyFiles(running);
          const paired = yield* pair(running, port);
          expect(paired.code, paired.stderr).toBe(0);
          expect(paired.stdout.trim()).toMatch(link);
          expect(yield* keyFiles(running)).toEqual(before);

          // Pairing reads only the port and the API key, so a setting only the server uses cannot
          // stop it.
          const serverOnly = yield* pair(running, port, {
            EXECUTOR_MCP_TIMEOUT_MS: "not-a-number",
          });
          expect(serverOnly.code, serverOnly.stderr).toBe(0);
          expect(serverOnly.stdout.trim()).toMatch(link);

          // An invalid port is named instead of the startup failure.
          const badPort = yield* pair(running, port, { EXECUTOR_PORT: "not-a-port" });
          yield* evidence.json("invalid-port.json", badPort);
          expect(badPort.code).toBe(1);
          expect(badPort.stderr).toContain("EXECUTOR_PORT must be a port number from 1 to 65535");
          expect(badPort.stderr).not.toContain("Executor could not start");

          // A directory without saved keys is refused, and not even the directory is created.
          const missing = path.join(root, "missing");
          const refused = yield* pair(missing, port);
          yield* evidence.json("no-saved-keys.json", refused);
          expect(refused.code).toBe(1);
          expect(refused.stderr).toContain(`${missing} has no saved keys`);
          expect(refused.stderr).toContain(
            "set EXECUTOR_DATA_DIR to the folder the running server uses",
          );
          expect(refused.stderr).toContain(desktopHint);
          expect(refused.stderr).toContain("No keys were created.");
          expect(refused.stderr).not.toContain("Executor could not start");
          expect(yield* fs.exists(missing)).toBe(false);

          // Another directory's keys, as when Executor desktop or another EXECUTOR_DATA_DIR owns the
          // port, are rejected by the server. The message names both causes and changes nothing.
          const other = path.join(root, "other");
          yield* fs.makeDirectory(other);
          yield* fs.writeFileString(
            path.join(other, "installation.json"),
            JSON.stringify({ version: 1, id: crypto.randomUUID(), state: "file" }),
          );
          yield* fs.writeFileString(
            path.join(other, "keys.json"),
            JSON.stringify({
              apiKey: randomBytes(32).toString("hex"),
              encryptionKey: randomBytes(32).toString("hex"),
            }),
          );
          const otherBefore = yield* snapshot(other);
          const rejected = yield* pair(other, port);
          yield* evidence.json("key-rejected.json", rejected);
          expect(rejected.code).toBe(1);
          expect(rejected.stderr).toContain(
            `The Executor server on 127.0.0.1:${port} did not accept the API key saved in ${other}.`,
          );
          expect(rejected.stderr).toContain("set EXECUTOR_DATA_DIR to the folder it uses");
          expect(rejected.stderr).toContain(desktopHint);
          expect(rejected.stderr).toContain("restart the server");
          expect(rejected.stderr).toContain(nothingChanged);
          expect(rejected.stderr).not.toContain("Executor could not start");
          expect(yield* snapshot(other)).toEqual(otherBefore);

          // Supplied keys the server did not start with are named as such.
          const supplied = yield* pair(missing, port, {
            EXECUTOR_API_KEY: randomBytes(32).toString("hex"),
            EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
          });
          expect(supplied.code).toBe(1);
          expect(supplied.stderr).toContain(
            `The Executor server on 127.0.0.1:${port} did not accept the supplied EXECUTOR_API_KEY.`,
          );
          expect(supplied.stderr).toContain(nothingChanged);
          expect(yield* fs.exists(missing)).toBe(false);

          // The server's own API key, supplied alone, pairs without a saved directory: a client
          // never needs the encryption key.
          const { apiKey } = yield* fs
            .readFileString(path.join(running, "keys.json"))
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(KeyFile)));
          const suppliedPaired = yield* pair(missing, port, { EXECUTOR_API_KEY: apiKey });
          expect(suppliedPaired.code, suppliedPaired.stderr).toBe(0);
          expect(suppliedPaired.stdout.trim()).toMatch(link);
          expect(yield* fs.exists(missing)).toBe(false);

          // A rotated key is used only after the server restarts, so pairing says to restart it.
          const rotated = yield* run(["rotate-key"], running, port);
          expect(rotated.code, rotated.stderr).toBe(0);
          const afterRotation = yield* keyFiles(running);
          expect(afterRotation).not.toEqual(before);
          const stale = yield* pair(running, port);
          yield* evidence.json("rotated-key.json", stale);
          expect(stale.code).toBe(1);
          expect(stale.stderr).toContain(
            `The Executor server on 127.0.0.1:${port} did not accept the API key saved in ${running}.`,
          );
          expect(stale.stderr).toContain(
            "If you ran `executor rotate-key`, restart the server to use the new key.",
          );
          expect(yield* keyFiles(running)).toEqual(afterRotation);

          // A port with no server says so instead of blaming the keys or the port being in use.
          const silentPort = yield* refusingPort;
          const silent = yield* pair(running, silentPort);
          yield* evidence.json("no-server.json", silent);
          expect(silent.code).toBe(1);
          expect(silent.stderr).toContain(`No server answered on 127.0.0.1:${silentPort}.`);
          expect(silent.stderr).toContain("set EXECUTOR_PORT to the port it listens on");
          expect(silent.stderr).toContain(desktopHint);
          expect(silent.stderr).not.toContain("already in use");

          // Another service on the port answers, but not with a connection link.
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
          if (!("port" in foreign.address)) return yield* Effect.die("Fixture must listen on TCP");
          const unexpected = yield* pair(running, foreign.address.port);
          yield* evidence.json("not-executor.json", unexpected);
          expect(unexpected.code).toBe(1);
          expect(unexpected.stderr).toContain(notExecutor(foreign.address.port));
          expect(unexpected.stderr).toContain(nothingChanged);

          // A service that is not HTTP is not "no server" either: one that resets each connection,
          // and one that reads each request and never answers.
          for (const [name, onConnection] of [
            ["resets-connection", (socket) => socket.resetAndDestroy()],
            // Reading each request lets the connection close when pair gives up. A client may
            // reset it rather than close it, as a Bun-compiled CLI does on exit.
            ["never-answers", (socket) => socket.on("error", () => {}).resume()],
          ] as const satisfies ReadonlyArray<readonly [string, Parameters<typeof holdPort>[1]]>) {
            const other = yield* Effect.scoped(
              Effect.gen(function* () {
                const otherPort = yield* holdPort(0, onConnection);
                return { port: otherPort, result: yield* pair(running, otherPort) };
              }),
            );
            yield* evidence.json(`${name}.json`, other.result);
            expect(other.result.code).toBe(1);
            expect(other.result.stderr).toContain(notExecutor(other.port));
            expect(other.result.stderr).not.toContain("No server answered");
          }
          expect(yield* keyFiles(running)).toEqual(afterRotation);
        }),
      ),
    // Readiness and every command have their own timeouts, which record evidence first.
    { timeout: 240_000 },
  );
});
