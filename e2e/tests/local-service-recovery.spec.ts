/**
 * The CLI's background service when what it finds is not a healthy server of its own: a suspended
 * or killed server's data directory lock, a reused process ID, an earlier server or an impostor
 * on the port, and an invalid key storage setting; and apps commands that start the service.
 * Every scenario runs the real CLI against its own HOME, data directory and port; see
 * `support/background-service.ts`. Starting, joining and managing the service are in
 * `local-service.spec.ts`.
 */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Fiber, FileSystem, Option, Path, Redacted, Ref, Schema } from "effect";
import { HttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { scenarios } from "../test-plan.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { freePort } from "../support/ports.ts";
import {
  backgroundServiceCli,
  crashServer,
  eventually,
  serving,
  starting,
} from "../support/background-service.ts";
import { suspendProcess } from "../support/desktop.ts";

const Apps = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String })),
);
/** A JSON record whose fields this test keeps as they are when it rewrites one of them. */
const RecordJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));

const LockOwner = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Number,
    started: Schema.optional(Schema.String),
    boot: Schema.optional(Schema.String),
    pipe: Schema.optional(Schema.String),
    host: Schema.String,
    port: Schema.Number,
  }),
);

/** One lock owner's process, whichever fields name it on this platform. */
const ownerKey = (owner: typeof LockOwner.Type) =>
  JSON.stringify([owner.pid, owner.started, owner.boot, owner.pipe]);

/** On Windows, what names a lock's owner: the pipe it listens on while it holds the lock. */
const lockPipe = /^\\\\\.\\pipe\\executor-lock-[\w-]+$/u;

/**
 * A data directory's `.server.lock`: when its holder last refreshed it, and the owner a server
 * records in it, `{ pid, started, boot, host, port }` on Linux and macOS and
 * `{ pid, pipe, host, port }` on Windows, if readable.
 */
const lockOf = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(directory, ".server.lock");
    const ownerFile = path.join(file, "owner.json");
    const owner = fs
      .readFileString(ownerFile)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(LockOwner)), Effect.option);
    return {
      file,
      ownerFile,
      refreshed: fs
        .stat(file)
        .pipe(Effect.map(({ mtime }) => Option.getOrUndefined(mtime)?.getTime() ?? 0)),
      owner,
      /** The owner's process and port. */
      holder: owner.pipe(Effect.map(Option.map(({ pid, port }) => ({ pid, port })))),
    };
  });

layer(TestLive, { excludeTestServices: true })("Local background service recovery", (it) => {
  it.effect(
    scenarios.localServiceSuspendedLock.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const evidence = yield* Evidence;
          const cli = yield* backgroundServiceCli();
          const started = yield* cli.run(["service", "start"]);
          expect(started.code, started.stderr).toBe(0);
          const server = yield* cli.registered;
          const lock = yield* lockOf(cli.data);
          expect(yield* lock.holder).toEqual(Option.some({ pid: server.pid, port: cli.port }));

          // The server stops running without exiting, as after Ctrl+Z, `kill -STOP` or a paused
          // debugger, so it stops refreshing its lock too.
          const suspendedAt = yield* Effect.scoped(
            Effect.gen(function* () {
              const held = yield* suspendProcess(server.pid);
              const last = yield* lock.refreshed;
              // A minute later its lock is twice as stale as one without an owner may get.
              const waited = yield* eventually(
                Clock.currentTimeMillis,
                (now) => now - last > 61_000,
                "90 seconds",
              ).pipe(Effect.map((now) => now - last));
              expect(yield* lock.refreshed).toBe(last);

              // A private server and a foreground one on another port each listen, find the
              // directory held by a process that still runs and still has its port open, and stop
              // before storage, naming the registered server.
              const standalone = Option.getOrUndefined(
                yield* cli.run(["--standalone"]).pipe(Effect.timeoutOption("60 seconds")),
              );
              expect(standalone?.code, "`executor --standalone` still ran after 60 s").toBe(1);
              expect(standalone?.stderr).toContain(
                `This command's private Executor server could not start.\nThe background Executor already serves the data directory ${cli.data} at ${cli.url}.`,
              );
              const other = yield* freePort;
              const foreground = Option.getOrUndefined(
                yield* cli
                  .run(["serve"], { EXECUTOR_PORT: String(other) })
                  .pipe(Effect.timeoutOption("60 seconds")),
              );
              expect(foreground?.code, "`executor serve` still ran after 60 s").toBe(1);
              expect(foreground?.stderr).toContain(
                `The background Executor already serves the data directory ${cli.data} at ${cli.url}. Stop it with \`executor service stop\``,
              );
              expect(yield* lock.holder).toEqual(Option.some({ pid: server.pid, port: cli.port }));
              expect(yield* lock.refreshed).toBe(last);

              // `executor service status` says why no command could use it.
              const status = yield* cli.run(["service", "status"]);
              expect(status.code, status.stderr).toBe(0);
              expect(status.stdout.trim()).toBe(
                `not responding ${cli.url} (version ${server.version}, process ${server.pid})`,
              );
              yield* evidence.json("suspended.json", {
                lockAgeAtRefusalsMs: (yield* Clock.currentTimeMillis) - last,
                waitedMs: waited,
              });
              yield* held.resume;
              return last;
            }),
          );

          // Resumed, the same process serves and keeps its lock: it refreshes it again, which a
          // server whose lock was taken would not.
          yield* eventually(lock.refreshed, (time) => time > suspendedAt, "20 seconds");
          expect((yield* cli.info(cli.url)).body).toEqual({
            id: server.id,
            version: server.version,
            pid: server.pid,
            status: "ready",
          });
          const after = yield* cli.registered;
          expect([after.id, after.pid]).toEqual([server.id, server.pid]);
          expect(yield* lock.holder).toEqual(Option.some({ pid: server.pid, port: cli.port }));
          const resumed = yield* cli.run(["service", "status"]);
          expect(resumed.stdout.trim()).toBe(
            `${cli.url} (version ${server.version}, process ${server.pid})`,
          );
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceCrashedLock.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem,
            evidence = yield* Evidence;
          const cli = yield* backgroundServiceCli();
          const lock = yield* lockOf(cli.data);
          const started = yield* cli.run(["service", "start"]);
          expect(started.code, started.stderr).toBe(0);
          const first = yield* cli.registered;

          // The server is killed, as by SIGKILL or a crash, so its lock and registration stay.
          yield* crashServer(first.pid);
          yield* eventually(cli.alive(first.pid), (alive) => !alive, "15 seconds");
          expect(yield* lock.holder).toEqual(Option.some({ pid: first.pid, port: cli.port }));
          expect((yield* cli.registered).id).toBe(first.id);
          const killed = yield* lock.owner;
          if (Option.isNone(killed)) return yield* Effect.die("The killed server left no owner");

          // The next start takes the lock over as soon as it tries, long before the 30 seconds
          // after which a lock without an owner counts as abandoned. Windows may give the next
          // server the killed one's process ID, so an owner is told apart by its start time, or on
          // Windows by its pipe.
          const begun = yield* Clock.currentTimeMillis;
          const takenOver = yield* eventually(
            lock.owner,
            (owner) => Option.isSome(owner) && ownerKey(owner.value) !== ownerKey(killed.value),
            "60 seconds",
          ).pipe(
            Effect.andThen(Clock.currentTimeMillis),
            Effect.map((now) => now - begun),
            Effect.forkScoped({ startImmediately: true }),
          );
          const restarted = yield* cli.run(["service", "start"]);
          expect(restarted.code, restarted.stderr).toBe(0);
          const second = yield* cli.registered;
          expect(second.id).not.toBe(first.id);
          const tookMs = yield* Fiber.join(takenOver);
          expect(yield* lock.holder).toEqual(Option.some({ pid: second.pid, port: cli.port }));
          expect(tookMs).toBeLessThan(20_000);

          // A killed server's lock as the OS would leave it once it gave the server's process ID to
          // another running program: this test's own process, which started at another time. The
          // lock is made to look just refreshed, as a running owner's would, so it would stay held
          // for 30 seconds if anything but the owner's start time, or on Windows its pipe, decided.
          const reusedBy = (server: number) =>
            Effect.gen(function* () {
              yield* crashServer(server);
              yield* eventually(cli.alive(server), (alive) => !alive, "15 seconds");
              const recorded = yield* lock.owner;
              if (Option.isNone(recorded))
                return yield* Effect.die("The killed server left no owner");
              // The server recorded when it started and on which boot, which tell it apart, or on
              // Windows the pipe it listened on, which Windows removed when it was killed.
              expect(recorded.value).toMatchObject(
                process.platform === "win32"
                  ? { pid: server, pipe: expect.stringMatching(lockPipe) }
                  : { pid: server, started: expect.any(String), boot: expect.any(String) },
              );
              yield* fs.writeFileString(
                lock.ownerFile,
                JSON.stringify({ ...recorded.value, pid: process.pid }),
              );
              // A number is a time in seconds, as for Node's utimes.
              const now = (yield* Clock.currentTimeMillis) / 1_000;
              yield* fs.utimes(lock.file, now, now);
              expect(Math.abs(now * 1_000 - (yield* lock.refreshed))).toBeLessThan(2_000);
            });
          /** Start a foreground server on a free port: how long it took to take the lock. */
          const takeOver = Effect.gen(function* () {
            const port = yield* freePort;
            const begun = yield* Clock.currentTimeMillis;
            const taken = yield* eventually(
              lock.owner,
              (owner) => Option.isSome(owner) && owner.value.pid !== process.pid,
              "60 seconds",
            ).pipe(
              Effect.andThen(Clock.currentTimeMillis),
              Effect.map((now) => now - begun),
              Effect.forkScoped({ startImmediately: true }),
            );
            const server = yield* cli.start(
              ["serve"],
              (line) => line === `Executor: http://127.0.0.1:${port}`,
              { EXECUTOR_PORT: String(port) },
            );
            const ms = yield* Fiber.join(taken);
            expect(yield* lock.holder).toEqual(Option.some({ pid: server.child.pid, port }));
            return { server, port, ms };
          });

          // Killed again, its process ID now names this test's process, and its port is closed. A
          // server on another port takes the lock over at once.
          yield* reusedBy(second.pid);
          const third = yield* takeOver;
          expect(third.ms).toBeLessThan(20_000);

          // Killed once more, and both its process ID and its port are now another program's: the
          // port accepts connections and answers, as no Executor does. The lock is still
          // abandoned, and the next server takes it over at once.
          yield* reusedBy(third.server.child.pid);
          yield* eventually(cli.refused(third.port), (refused) => refused, "15 seconds");
          yield* serving(
            HttpRouter.add("*", "/*", Effect.succeed(HttpServerResponse.empty({ status: 404 }))),
            third.port,
          );
          const fourth = yield* takeOver;
          expect(fourth.ms).toBeLessThan(20_000);
          yield* evidence.json("takeovers.json", {
            tookMs,
            reusedPidMs: third.ms,
            reusedPidAndPortMs: fourth.ms,
          });
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceReusedPid.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem,
            processes = yield* ChildProcessSpawner.ChildProcessSpawner,
            evidence = yield* Evidence;
          const cli = yield* backgroundServiceCli();
          const started = yield* cli.run(["service", "start"]);
          expect(started.code, started.stderr).toBe(0);
          const server = yield* cli.registered;
          const registration = yield* fs
            .readFileString(cli.registrationFile)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(RecordJson)));
          // On Linux and macOS the registration records when the server started and on which
          // boot. On Windows it names only the pid, and the data directory's lock names the same
          // pid with the pipe the server listens on.
          if (process.platform === "win32") {
            expect(registration).toMatchObject({ pid: server.pid, group: true });
            expect(registration).not.toHaveProperty("started");
            expect(Option.getOrUndefined(yield* (yield* lockOf(cli.data)).owner)).toMatchObject({
              pid: server.pid,
              pipe: expect.stringMatching(lockPipe),
            });
          } else {
            expect(registration).toMatchObject({
              pid: server.pid,
              group: true,
              started: expect.any(String),
              boot: expect.any(String),
            });
          }

          // The server is killed, and the OS gives its process ID to another program that leads
          // its own process group, as a background server does. Another program takes its port,
          // accepting connections and never answering, as a hung server would.
          yield* crashServer(server.pid);
          yield* eventually(cli.alive(server.pid), (alive) => !alive, "15 seconds");
          yield* eventually(cli.refused(cli.port), (refused) => refused, "15 seconds");
          const unrelated = yield* processes.spawn(
            ChildProcess.make(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
              stdout: "ignore",
              stderr: "ignore",
            }),
          );
          yield* serving(HttpRouter.add("*", "/*", Effect.never), cli.port);
          const reuse = fs.writeFileString(
            cli.registrationFile,
            JSON.stringify({ ...registration, pid: unrelated.pid }),
          );

          // `executor service stop` gets no answer, finds that the process with that ID started
          // after the server did, or on Windows that the lock names another process, and removes
          // the registration without signalling it.
          yield* reuse;
          const stopped = yield* cli.run(["service", "stop"]);
          expect(stopped.code, stopped.stderr).toBe(0);
          expect(yield* fs.exists(cli.registrationFile)).toBe(false);
          const status = yield* cli.run(["service", "status"]);
          expect(status.stdout.trim()).toBe("stopped");
          expect(yield* cli.alive(unrelated.pid)).toBe(true);

          // A start counts the registration as hung after three unanswered requests and removes
          // it the same way. Its server then finds the port taken by another program.
          yield* reuse;
          const restarted = yield* cli.run(["service", "start"]);
          expect(restarted.code).toBe(1);
          expect(restarted.stderr).toContain(
            `Port ${cli.port} is already in use by another program.`,
          );
          expect(yield* fs.exists(cli.registrationFile)).toBe(false);
          yield* Effect.sleep("1 second");
          expect(yield* cli.alive(unrelated.pid)).toBe(true);
          expect(yield* unrelated.isRunning).toBe(true);
          yield* evidence.json("reused-pid.json", {
            server: server.pid,
            unrelated: unrelated.pid,
            stopCode: stopped.code,
            startCode: restarted.code,
          });
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceKeyStorageInvalid.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cli = yield* backgroundServiceCli();
          const refusal =
            'EXECUTOR_KEY_STORAGE must be "file" (keep keys in keys.json) or "os" (OS credential store only), or unset. Nothing was changed.';

          // Each way to start a server refuses the value before it creates the data directory.
          for (const args of [["service", "start"], [], ["--standalone"], ["serve"]]) {
            const refused = yield* cli.run(args, { EXECUTOR_KEY_STORAGE: "keyring" });
            expect(refused.code, refused.stdout).toBe(1);
            expect(refused.stderr).toContain(refusal);
            expect(refused.stdout).not.toContain("#pair=");
            expect(yield* fs.exists(cli.data)).toBe(false);
          }
          expect(yield* cli.refused(cli.port)).toBe(true);

          // Saved as a setting, which servers a client starts run with, the setting wins over the
          // environment's valid value, and nothing but the setting is written.
          const saved = yield* cli.run([
            "service",
            "set",
            "env",
            "EXECUTOR_KEY_STORAGE",
            "keyring",
          ]);
          expect(saved.code, saved.stderr).toBe(0);
          for (const args of [["service", "start"], []]) {
            const refused = yield* cli.run(args);
            expect(refused.code, refused.stdout).toBe(1);
            expect(refused.stderr).toContain(
              `The background Executor could not start.\n${refusal}`,
            );
            expect(yield* fs.readDirectory(cli.data)).toEqual(["service.json"]);
          }
          expect(yield* fs.exists(cli.registrationFile)).toBe(false);

          // Once the setting is removed, the same command starts the server.
          const unset = yield* cli.run(["service", "unset", "env", "EXECUTOR_KEY_STORAGE"]);
          expect(unset.code, unset.stderr).toBe(0);
          const started = yield* cli.run(["service", "start"]);
          expect(started.code, started.stderr).toBe(0);
          expect(started.stdout.trim()).toBe(cli.url);
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceAppsCli.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cli = yield* backgroundServiceCli();
          // No --host or EXECUTOR_HOST: the command starts the background server and uses its
          // registered password, with no API key supplied.
          const listed = yield* cli.run(["apps", "list"]);
          expect(listed.code, listed.stderr).toBe(0);
          expect(listed.stderr).toContain(starting);
          const apps = yield* Schema.decodeUnknownEffect(Apps)(listed.stdout);
          expect(apps.map((app) => app.slug)).toContain("executor");
          const registration = yield* cli.registered;
          expect(registration.url).toBe(cli.url);
          expect((yield* cli.info(cli.url)).body.pid).toBe(registration.pid);

          // The next command reuses it.
          const again = yield* cli.run(["apps", "list"]);
          expect(again.code, again.stderr).toBe(0);
          expect(again.stderr).not.toContain(starting);
          expect(yield* Schema.decodeUnknownEffect(Apps)(again.stdout)).toEqual(apps);
          const after = yield* cli.registered;
          expect([after.id, after.pid]).toEqual([registration.id, registration.pid]);

          // With the service disabled, the command runs a private server for its duration.
          const disabled = yield* cli.run(["service", "set", "disabled", "true"]);
          expect(disabled.code, disabled.stderr).toBe(0);
          expect(yield* cli.alive(registration.pid)).toBe(false);
          const own = yield* cli.run(["apps", "list"]);
          expect(own.code, own.stderr).toBe(0);
          expect(own.stderr).not.toContain(starting);
          expect(yield* Schema.decodeUnknownEffect(Apps)(own.stdout)).toEqual(apps);
          expect(yield* fs.exists(cli.registrationFile)).toBe(false);
          expect(yield* cli.refused(cli.port)).toBe(true);
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceEarlierServer.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cli = yield* backgroundServiceCli();
          // server.json as an Executor from before the background service wrote it. The process it
          // names runs: this test's own. That Executor took no lock, so only the record shows it.
          const recordOf = (url: string) =>
            JSON.stringify({
              pid: process.pid,
              version: "2.0.0-beta.15",
              url,
              command: "executor serve",
            });
          yield* fs.makeDirectory(cli.data, { recursive: true });

          // That Executor still answers at its URL, as its session route does for any loopback
          // request.
          const earlier = yield* Effect.scoped(
            Effect.gen(function* () {
              const url = yield* serving(
                HttpRouter.add(
                  "GET",
                  "/auth/session",
                  HttpServerResponse.jsonUnsafe({ authenticated: false }),
                ),
              );
              const record = recordOf(url);
              yield* fs.writeFileString(cli.registrationFile, record);
              for (const args of [["service", "start"], ["serve"]]) {
                const refused = yield* cli.run(args);
                expect(refused.code).toBe(1);
                expect(refused.stderr).toContain(
                  `An Executor from before the background service (process ${process.pid}) is using the data directory ${cli.data} at ${url}.`,
                );
                expect(refused.stderr).not.toContain(starting);
              }
              // Nothing listened or replaced the record.
              expect(yield* cli.refused(cli.port)).toBe(true);
              expect(yield* fs.readFileString(cli.registrationFile)).toBe(record);
              return url;
            }),
          );

          // Once nothing answers there, the record was left by a killed Executor whose process ID
          // another program now has. It is ignored, and a server starts in its place.
          const started = yield* cli.run(["service", "start"]);
          expect(started.code, started.stderr).toBe(0);
          expect(started.stdout.trim()).toBe(cli.url);
          expect(started.stderr).toContain(
            `Ignoring ${cli.registrationFile}: it names process ${process.pid}, but no Executor answers at ${earlier}.`,
          );
          expect((yield* cli.registered).url).toBe(cli.url);
        }),
      ),
    { timeout: 300_000 },
  );
  it.effect(
    scenarios.localServiceImpostor.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const http = yield* HttpClient.HttpClient,
            evidence = yield* Evidence;
          const cli = yield* backgroundServiceCli();
          const started = yield* cli.run(["service", "start"]);
          expect(started.code, started.stderr).toBe(0);
          const registration = yield* cli.registered;
          const password = Redacted.value(registration.password);
          // What the server proved to one client that challenged it, as anyone on the machine can
          // ask for and record: a proof only for that challenge.
          const replayedChallenge = "e2e-recorded-challenge-0123456789";
          const recorded = yield* http
            .get(`${cli.url}/api/service?challenge=${replayedChallenge}`)
            .pipe(Effect.flatMap((response) => response.json));
          expect(recorded).toMatchObject({
            id: registration.id,
            pid: registration.pid,
            status: "ready",
            proof: expect.stringMatching(/^[\w-]{43}$/u),
          });

          // The server dies without removing its registration, as after SIGKILL or a power loss.
          yield* crashServer(registration.pid);
          expect(yield* eventually(cli.refused(cli.port), (refused) => refused, "15 seconds")).toBe(
            true,
          );
          expect((yield* cli.registered).id).toBe(registration.id);

          // Another process takes the registered port and replays that answer, proof included.
          yield* Effect.scoped(
            Effect.gen(function* () {
              const requests = yield* Ref.make<
                ReadonlyArray<{
                  readonly url: string;
                  readonly headers: Readonly<Record<string, string>>;
                  readonly body: string;
                }>
              >([]);
              yield* serving(
                HttpRouter.add(
                  "*",
                  "/*",
                  Effect.gen(function* () {
                    const request = yield* HttpServerRequest.HttpServerRequest;
                    const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
                    yield* Ref.update(requests, (seen) => [
                      ...seen,
                      { url: request.url, headers: { ...request.headers }, body },
                    ]);
                    return request.url.startsWith("/api/service")
                      ? HttpServerResponse.jsonUnsafe(recorded)
                      : HttpServerResponse.empty({ status: 404 });
                  }),
                ),
                cli.port,
              );

              // Its proof is for another challenge, so it is not the server.
              const status = yield* cli.run(["service", "status"]);
              expect(status.code, status.stderr).toBe(0);
              expect(status.stdout.trim()).toBe("stopped");

              // `executor` neither pairs with it nor sends it the password. It cannot take the
              // port either, so it says another Executor holds it.
              const joined = yield* cli.run([]);
              expect(joined.code).toBe(1);
              expect(joined.stderr).toContain(
                `Port ${cli.port} is already in use by another Executor server, for another data directory.`,
              );
              expect(joined.stdout).not.toContain("#pair=");
              expect(yield* cli.opened).toEqual([]);
              const seen = yield* Ref.get(requests);
              yield* evidence.json("impostor-requests.json", {
                requests: seen.length,
                first: seen.slice(0, 3).map(({ url }) => url),
              });
              // Each client challenged it afresh, and asked it nothing else.
              const challenges = seen.map(
                ({ url }) => new URL(url, "http://127.0.0.1").searchParams.get("challenge") ?? "",
              );
              expect(challenges.length).toBeGreaterThan(0);
              expect(seen.filter(({ url }) => !url.startsWith("/api/service?"))).toEqual([]);
              expect(challenges.filter((challenge) => challenge === replayedChallenge)).toEqual([]);
              // The password is nowhere in what it received: not in a URL, a header or a body.
              expect(
                seen.filter(
                  ({ url, headers, body }) =>
                    decodeURIComponent(url).includes(password) ||
                    Object.values(headers).some((value) => value.includes(password)) ||
                    body.includes(password),
                ),
              ).toEqual([]);
            }),
          );
        }),
      ),
    { timeout: 300_000 },
  );
});
