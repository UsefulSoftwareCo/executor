/**
 * The CLI's background service: one Executor per data directory on a fixed port, started or
 * joined by local commands, managed with `executor service`, and stopped only when asked. Every
 * scenario runs the real CLI against its own HOME, data directory and port; see
 * `support/background-service.ts`.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createServer } from "node:http";
import { Clock, Context, Effect, Fiber, FileSystem, Layer, Option, Path, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { scenarios } from "../test-plan.ts";
import { Api, SessionClients } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { freePort } from "../support/ports.ts";
import {
  backgroundServiceCli,
  crashServer,
  eventually,
  starting,
  stoppingServer,
} from "../support/background-service.ts";

const keysSaved = "keys saved to ";
/** An apps command's failure as it prints it on stdout for programs. */
const AppsFailure = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ code: Schema.String, message: Schema.String }) }),
);
const escaped = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Requests to another local origin, such as the background server's, with their own cookies. */
const apiAt = (origin: string) =>
  Effect.gen(function* () {
    const target = yield* Target;
    const services = yield* Layer.build(
      Api.layer.pipe(
        Layer.provide(SessionClients.layer),
        Layer.provide(
          Layer.succeed(Target, Target.of({ ...target, metadata: { ...target.metadata, origin } })),
        ),
      ),
    );
    return Context.get(services, Api);
  });

layer(TestLive, { excludeTestServices: true })("Local background service", (it) => {
  it.effect(
    scenarios.localServiceSharedStart.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cli = yield* backgroundServiceCli();

          // Both commands race to start a server; the fixed port and the data directory's lock
          // leave one, and both print its URL.
          const [first, second] = yield* Effect.all(
            [cli.run(["service", "start"]), cli.run(["service", "start"])],
            { concurrency: 2 },
          );
          expect(first.code, first.stderr).toBe(0);
          expect(second.code, second.stderr).toBe(0);
          expect(first.stdout.trim()).toBe(cli.url);
          expect(second.stdout.trim()).toBe(cli.url);

          const registration = yield* cli.registered;
          expect(registration.url).toBe(cli.url);
          expect(yield* cli.info(cli.url)).toEqual({
            status: 200,
            body: {
              id: registration.id,
              version: registration.version,
              pid: registration.pid,
              status: "ready",
            },
          });
          // The registration carries the server's password, so only its owner may read it.
          if (process.platform !== "win32")
            expect((yield* fs.stat(cli.registrationFile)).mode & 0o777).toBe(0o600);

          // No contender that lost the race took over afterwards: a later start finds the same one.
          const third = yield* cli.run(["service", "start"]);
          expect(third.code, third.stderr).toBe(0);
          expect(third.stdout.trim()).toBe(cli.url);
          expect(third.stderr).not.toContain(starting);
          const after = yield* cli.registered;
          expect([after.id, after.pid]).toEqual([registration.id, registration.pid]);
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceJoin.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const cli = yield* backgroundServiceCli();
          const started = yield* cli.run(["service", "start"]);
          expect(started.code, started.stderr).toBe(0);
          // The background server's own stderr has no reader, so the start names the key file.
          expect(started.stderr).toContain(
            `EXECUTOR_KEY_STORAGE=file; ${keysSaved}${path.join(cli.data, "keys.json")}`,
          );
          const before = yield* cli.registered;

          // `executor` uses the running server: it prints where it runs and the link, opens the
          // link and exits, leaving the same server running.
          const joined = yield* cli.run([]);
          expect(joined.code, joined.stderr).toBe(0);
          expect(joined.stderr).not.toContain(starting);
          expect(joined.stderr).not.toContain(keysSaved);
          const lines = joined.stdout.trim().split("\n");
          expect(lines.slice(0, 3)).toEqual([
            `Executor: ${cli.url}`,
            `MCP: ${cli.url}/mcp`,
            "Connect (one use, expires in 5 minutes):",
          ]);
          // A fifth line would say the browser could not be opened.
          expect(lines).toHaveLength(4);
          const link = lines[3] ?? "";
          expect(link).toMatch(new RegExp(`^${escaped(cli.url)}/#pair=[a-f0-9]{64}$`, "u"));
          expect(yield* cli.opened).toEqual([link]);
          const after = yield* cli.registered;
          expect([after.id, after.pid]).toEqual([before.id, before.pid]);

          // The opened link pairs a browser with that server, once.
          const api = yield* apiAt(cli.url);
          const browser = yield* api.session();
          const token = new URL(link).hash.slice("#pair=".length);
          const exchanged = yield* api.request(browser, "POST", "/auth/exchange", { token });
          expect(exchanged).toEqual({ status: 200, body: { authenticated: true } });
          const session = yield* api.request(browser, "GET", "/auth/session");
          expect(session).toEqual({ status: 200, body: { authenticated: true } });
          const replay = yield* api.request(yield* api.session(), "POST", "/auth/exchange", {
            token,
          });
          expect(replay.status).toBe(401);
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceVersion.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const cli = yield* backgroundServiceCli();
          // The other releases are the checkout's CLI, which reports EXECUTOR_BUILD_VERSION. The
          // CLI under test reports its own release version when it is a release executable.
          const [older, other] = ["2.0.0-e2e.1", "2.0.0-e2e.3"];
          const current = { EXECUTOR_BUILD_VERSION: "2.0.0-e2e.2" };
          const printed = yield* cli.run(["--version"], current);
          expect(printed.code, printed.stderr).toBe(0);
          const newer = printed.stdout.trim().replace(/^executor v/u, "");
          expect([older, other]).not.toContain(newer);
          const started = yield* cli.run(
            ["service", "start"],
            { EXECUTOR_BUILD_VERSION: older },
            { source: true },
          );
          expect(started.code, started.stderr).toBe(0);
          const first = yield* cli.registered;
          expect(first.version).toBe(older);

          // The interactive command replaces a server of another version with its own.
          const replaced = yield* cli.run([], current);
          expect(replaced.code, replaced.stderr).toBe(0);
          expect(replaced.stderr).toContain(
            `Restarting background Executor (running ${older}, this is ${newer})...`,
          );
          expect(replaced.stdout).toContain(`Executor: ${cli.url}\n`);
          const second = yield* cli.registered;
          expect(second.version).toBe(newer);
          expect(second.pid).not.toBe(first.pid);
          expect(yield* cli.alive(first.pid)).toBe(false);
          expect(yield* cli.info(cli.url)).toEqual({
            status: 200,
            body: { id: second.id, version: newer, pid: second.pid, status: "ready" },
          });

          // Other commands use whichever version runs.
          const kept = yield* cli.run(
            ["service", "start"],
            { EXECUTOR_BUILD_VERSION: other },
            { source: true },
          );
          expect(kept.code, kept.stderr).toBe(0);
          expect(kept.stdout.trim()).toBe(cli.url);
          expect(kept.stderr).not.toContain("background Executor");
          const third = yield* cli.registered;
          expect([third.id, third.pid, third.version]).toEqual([second.id, second.pid, newer]);
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceStandalone.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cli = yield* backgroundServiceCli();
          const standalone = yield* cli.start(["--standalone"], (line) =>
            line.startsWith("Executor: "),
          );
          const origin = standalone.line.slice("Executor: ".length);
          expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
          expect(origin).not.toBe(cli.url);
          const port = Number(new URL(origin).port);

          // The private server answers, while nothing registers or listens on the service port.
          expect((yield* cli.info(origin)).body.status).toBe("ready");
          expect(yield* fs.exists(cli.registrationFile)).toBe(false);
          expect(yield* cli.refused(cli.port)).toBe(true);

          // A background server cannot start meanwhile, and since the private server is not
          // registered, the message does not offer `executor service stop`, which cannot stop it.
          const blocked = yield* cli.run(["service", "start"]);
          expect(blocked.code).toBe(1);
          expect(blocked.stderr).toContain(
            `The background Executor could not start.\nAnother Executor is using the data directory ${cli.data}, and it is not the background Executor, so \`executor service stop\` cannot stop it.`,
          );
          expect(yield* fs.exists(cli.registrationFile)).toBe(false);

          // Interrupting the command, as Ctrl-C does, stops its server. The private server leads a
          // process group of its own, so on POSIX only the command gets SIGINT, and it exits as an
          // interrupted program does. Windows has no SIGINT for another process, and ending the
          // command's process tree would end the private server directly, so only the command is
          // ended there: the private server then stops because its standard input closed.
          if (process.platform === "win32")
            yield* Effect.try(() => process.kill(standalone.child.pid, "SIGTERM"));
          else yield* standalone.child.kill({ killSignal: "SIGINT" });
          const interrupted = yield* standalone.child.exitCode.pipe(Effect.timeout("30 seconds"));
          if (process.platform !== "win32") expect(Number(interrupted)).toBe(130);
          expect(yield* eventually(cli.refused(port), (refused) => refused, "15 seconds")).toBe(
            true,
          );
          expect(yield* fs.exists(cli.registrationFile)).toBe(false);

          // When the private server stops on its own, the command says so and fails instead of
          // waiting with a dead link.
          const crashed = yield* cli.start(["--standalone"], (line) =>
            line.startsWith("Executor: "),
          );
          const own = new URL(crashed.line.slice("Executor: ".length));
          yield* crashServer((yield* cli.info(own.origin)).body.pid);
          const code = yield* crashed.child.exitCode.pipe(Effect.timeout("30 seconds"));
          expect(Number(code)).toBe(1);
          expect(yield* crashed.output).toContain(
            "This command's private Executor server stopped (",
          );

          // While the background server holds the data directory, the private server says so,
          // and the command does not claim the background server failed.
          const started = yield* cli.run(["service", "start"]);
          expect(started.code, started.stderr).toBe(0);
          const held = yield* cli.run(["--standalone"]);
          expect(held.code).toBe(1);
          expect(held.stderr).toContain(
            `This command's private Executor server could not start.\nThe background Executor already serves the data directory ${cli.data} at ${cli.url}.`,
          );
          expect(held.stderr).not.toContain("background Executor could not start");
          expect(held.stderr).not.toContain("executorService");
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServicePortInUse.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          // Another program answers HTTP on the configured port, and not as Executor.
          const services = yield* Layer.build(
            HttpRouter.serve(
              HttpRouter.add(
                "*",
                "/*",
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
          const cli = yield* backgroundServiceCli({ port: foreign.address.port });

          // EXECUTOR_PORT chose the port, so changing the saved port would not help.
          const refused = yield* cli.run(["service", "start"]);
          expect(refused.code).toBe(1);
          expect(refused.stderr).toContain("The background Executor could not start.");
          expect(refused.stderr).toContain(
            `Port ${cli.port} is already in use by another program. EXECUTOR_PORT is set to ${cli.port} and wins over the \`port\` setting: set EXECUTOR_PORT to another port, or unset it, then try again.`,
          );
          expect(yield* fs.exists(cli.registrationFile)).toBe(false);

          // The saved port chose it, so the message names the setting.
          const saved = { EXECUTOR_PORT: undefined };
          const set = yield* cli.run(["service", "set", "port", String(cli.port)], saved);
          expect(set.code, set.stderr).toBe(0);
          const setting = yield* cli.run(["service", "start"], saved);
          expect(setting.code).toBe(1);
          expect(setting.stderr).toContain(
            `Port ${cli.port} is already in use by another program. Choose another port with \`executor service set port <port>\`, then run \`executor\` again.`,
          );

          // An apps command reports the same failure in its own contract, with JSON on stdout.
          const apps = yield* cli.run(["apps", "list"]);
          expect(apps.code).toBe(1);
          expect(apps.stderr).toContain("Code: LocalServerUnavailable");
          const failure = yield* Schema.decodeUnknownEffect(AppsFailure)(apps.stdout);
          expect(failure.error.code).toBe("LocalServerUnavailable");
          expect(failure.error.message).toContain(`Port ${cli.port} is already in use`);
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceLifecycle.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cli = yield* backgroundServiceCli();
          // A client's own credential, without an encryption key, is only what it would send; the
          // server it starts still uses the data directory's keys.
          const started = yield* cli.run(["service", "start"], {
            EXECUTOR_API_KEY: "a".repeat(64),
          });
          expect(started.code, started.stderr).toBe(0);
          expect(started.stdout.trim()).toBe(cli.url);
          const first = yield* cli.registered;

          const status = yield* cli.run(["service", "status"]);
          expect(status.code, status.stderr).toBe(0);
          expect(status.stdout.trim()).toBe(
            `${cli.url} (version ${first.version}, process ${first.pid})`,
          );

          // Restart stops the server and starts another in its place.
          const restarted = yield* cli.run(["service", "restart"]);
          expect(restarted.code, restarted.stderr).toBe(0);
          expect(restarted.stdout.trim()).toBe(cli.url);
          const second = yield* cli.registered;
          expect(second.pid).not.toBe(first.pid);
          expect(yield* cli.alive(first.pid)).toBe(false);
          expect((yield* cli.info(cli.url)).body).toEqual({
            id: second.id,
            version: second.version,
            pid: second.pid,
            status: "ready",
          });

          // Stop ends the process, frees its port and removes its registration.
          const stopped = yield* cli.run(["service", "stop"]);
          expect(stopped.code, stopped.stderr).toBe(0);
          expect(yield* fs.exists(cli.registrationFile)).toBe(false);
          expect(yield* cli.alive(second.pid)).toBe(false);
          expect(yield* cli.refused(cli.port)).toBe(true);
          const after = yield* cli.run(["service", "status"]);
          expect(after.code, after.stderr).toBe(0);
          expect(after.stdout.trim()).toBe("stopped");
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceRegistration.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem,
            evidence = yield* Evidence;
          const cli = yield* backgroundServiceCli();
          const started = yield* cli.run(["service", "start"]);
          expect(started.code, started.stderr).toBe(0);
          const registration = yield* cli.registered;

          // A server no client can find any more stops on its own, and nothing serves its port.
          const removedAt = yield* Clock.currentTimeMillis;
          yield* fs.remove(cli.registrationFile);
          const exited = yield* eventually(
            cli.alive(registration.pid),
            (alive) => !alive,
            "10 seconds",
          ).pipe(Effect.option);
          const stoppedAt = yield* Clock.currentTimeMillis;
          const answering = yield* cli.info(cli.url).pipe(Effect.option);
          yield* evidence.json("watchdog.json", {
            stoppedAfterMs: stoppedAt - removedAt,
            exited: Option.isSome(exited),
            answering: Option.getOrUndefined(answering),
          });
          expect(
            Option.isSome(exited),
            "the unregistered server was still running after 10 s",
          ).toBe(true);
          expect(
            Option.getOrUndefined(answering),
            "another server answered on the port after the unregistered one stopped",
          ).toBeUndefined();
          expect(yield* cli.refused(cli.port)).toBe(true);
          const status = yield* cli.run(["service", "status"]);
          expect(status.stdout.trim()).toBe("stopped");
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServicePortSetting.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cli = yield* backgroundServiceCli();
          // The saved port applies only without EXECUTOR_PORT, which wins over it.
          const saved = { EXECUTOR_PORT: undefined };
          const next = yield* freePort.pipe(
            Effect.repeat({ until: (port) => port !== cli.port, times: 5 }),
          );
          expect(next).not.toBe(cli.port);

          const set = yield* cli.run(["service", "set", "port", String(cli.port)], saved);
          expect(set.code, set.stderr).toBe(0);
          const started = yield* cli.run(["service", "start"], saved);
          expect(started.code, started.stderr).toBe(0);
          expect(started.stdout.trim()).toBe(cli.url);
          const first = yield* cli.registered;

          // Changing the port stops the running server, so the next start uses the new one.
          const changed = yield* cli.run(["service", "set", "port", String(next)], saved);
          expect(changed.code, changed.stderr).toBe(0);
          expect(yield* fs.exists(cli.registrationFile)).toBe(false);
          expect(yield* cli.alive(first.pid)).toBe(false);
          expect(yield* cli.refused(cli.port)).toBe(true);
          const read = yield* cli.run(["service", "get", "port"], saved);
          expect(read.code, read.stderr).toBe(0);
          expect(read.stdout.trim()).toBe(String(next));

          const restarted = yield* cli.run(["service", "start"], saved);
          expect(restarted.code, restarted.stderr).toBe(0);
          const url = `http://127.0.0.1:${next}`;
          expect(restarted.stdout.trim()).toBe(url);
          const second = yield* cli.registered;
          expect(second.url).toBe(url);
          expect((yield* cli.info(url)).body).toEqual({
            id: second.id,
            version: second.version,
            pid: second.pid,
            status: "ready",
          });
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceDirectoryLock.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const cli = yield* backgroundServiceCli();
          const foreground = yield* cli.start(["serve"], (line) => line === `Executor: ${cli.url}`);
          const other = yield* freePort;

          // A second server for the same data directory on another port stops before storage, and
          // names the registered server that holds it.
          const second = yield* cli.run(["serve"], { EXECUTOR_PORT: String(other) });
          expect(second.code).toBe(1);
          expect(second.stderr).toContain(
            `The background Executor already serves the data directory ${cli.data} at ${cli.url}. Stop it with \`executor service stop\`, or set EXECUTOR_DATA_DIR to another folder.`,
          );

          // On the registered server's own port, it is that server that holds the directory.
          const same = yield* cli.run(["serve"]);
          expect(same.code).toBe(1);
          expect(same.stderr).toContain(
            `The background Executor already serves the data directory ${cli.data} at ${cli.url}. Stop it with \`executor service stop\``,
          );
          expect(same.stderr).not.toContain("in use by another program");

          // The first one keeps serving the directory, registered as the one the CLI shares.
          const registration = yield* cli.registered;
          expect(registration.pid).toBe(foreground.child.pid);
          expect((yield* cli.info(cli.url)).body).toEqual({
            id: registration.id,
            version: registration.version,
            pid: registration.pid,
            status: "ready",
          });
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceStopping.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const cli = yield* backgroundServiceCli();
          const started = yield* cli.run(["service", "start"]);
          expect(started.code, started.stderr).toBe(0);
          const server = yield* cli.registered;

          // The server is asked to stop and takes seconds to exit, answering meanwhile that it is
          // stopping; a stand-in answers in its place for those seconds.
          yield* crashServer(server.pid);
          yield* eventually(cli.refused(cli.port), (refused) => refused, "15 seconds");
          const scope = yield* Effect.scope;
          const restarted = yield* Effect.scoped(
            Effect.gen(function* () {
              const stopping = yield* stoppingServer(server);
              const status = yield* cli.run(["service", "status"]);
              expect(status.code, status.stderr).toBe(0);
              expect(status.stdout.trim()).toBe(
                `stopping ${cli.url} (version ${server.version}, process ${server.pid})`,
              );

              // A start waits for it to exit, asking it again and again, and neither joins it nor
              // asks it to stop.
              const seen = yield* stopping.answered;
              const start = yield* Effect.forkIn(cli.run(["service", "start"]), scope);
              yield* eventually(
                stopping.answered,
                (answered) => answered >= seen + 20,
                "30 seconds",
              );
              expect(start.pollUnsafe()).toBeUndefined();
              expect(
                (yield* stopping.requests).filter((request) => request !== "GET /api/service"),
              ).toEqual([]);
              return start;
            }),
          );

          // Once it has gone, the start starts a server in its place.
          const result = yield* Fiber.join(restarted);
          expect(result.code, result.stderr).toBe(0);
          expect(result.stdout.trim()).toBe(cli.url);
          const next = yield* cli.registered;
          expect(next.pid).not.toBe(server.pid);
          expect((yield* cli.info(cli.url)).body).toEqual({
            id: next.id,
            version: next.version,
            pid: next.pid,
            status: "ready",
          });
        }),
      ),
    { timeout: 300_000 },
  );
});
