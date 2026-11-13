/**
 * The real local CLI against a background Executor of its own: an isolated HOME, data directory,
 * key file and fixed port, and a fake browser opener first on PATH that records the link it is
 * given. A server that a command starts is detached from it, outside every process group the
 * spawner owns, so the scope's finalizer runs `executor service stop` and then kills any server
 * process that is still registered or still answers as one this scenario saw.
 *
 * `server.json` and `GET /api/service` are the service's public contract with every local client;
 * their schemas are restated here rather than imported from the product.
 */
import {
  Config,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect";
import {
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { Evidence } from "./evidence.ts";
import { Target } from "./platform.ts";
import { connectionRefused, freePort } from "./ports.ts";
import { localEntryCommand } from "./local-entry.ts";
import { heldValue, reveal } from "./failure-text.ts";

/** `server.json`: the process that serves a data directory and how to reach it. */
/** What `executor` prints when it starts a background server. */
export const starting = "Starting background Executor...";

/** Serve `routes` on a loopback port, by default a free one, for the current scope; its URL. */
export const serving = <E, R>(routes: Layer.Layer<never, E, R>, port = 0) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port })),
      ),
    );
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
    return `http://127.0.0.1:${server.address.port}`;
  });

export const ServiceRegistration = Schema.Struct({
  id: Schema.String,
  version: Schema.String,
  url: Schema.String,
  pid: Schema.Number,
  password: heldValue(Schema.RedactedFromValue(Schema.String)),
});
export type ServiceRegistration = typeof ServiceRegistration.Type;
const RegistrationJson = Schema.fromJsonString(ServiceRegistration);

/**
 * `GET /api/service`: the process answering on a port, and whether it serves every route yet, or
 * is going away once asked to stop.
 */
export const ServiceInfo = Schema.Struct({
  id: Schema.String,
  version: Schema.String,
  pid: Schema.Number,
  status: Schema.Literals(["starting", "ready", "stopping"]),
});

/**
 * A stand-in for `server` once it has been asked to stop and before it exits, for the current
 * scope: it answers on the server's address as that process, with the proof of the registration's
 * password for each fresh challenge that the server gives, and says it is stopping. A real server's
 * own shutdown takes a fraction of a second; this one lasts until its scope closes, which closes
 * every connection to it, as the server's exit would. `requests` are the method and path of each
 * request it was sent, in order.
 */
export const stoppingServer = (server: ServiceRegistration) =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<string>>([]);
    const handler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, server.url);
      yield* Ref.update(requests, (all) => [...all, `${request.method} ${url.pathname}`]);
      if (request.method !== "GET" || url.pathname !== "/api/service")
        return HttpServerResponse.empty({ status: 503 });
      const challenge = url.searchParams.get("challenge");
      return HttpServerResponse.jsonUnsafe(
        {
          id: server.id,
          version: server.version,
          pid: server.pid,
          status: "stopping",
          ...(challenge === null
            ? {}
            : {
                proof: createHmac("sha256", reveal(server.password))
                  .update(challenge)
                  .digest("base64url"),
              }),
        },
        { status: 503, headers: { "retry-after": "1" } },
      );
    });
    const listener = yield* Effect.sync(() => createServer());
    yield* Layer.build(
      HttpRouter.serve(HttpRouter.add("*", "/*", handler), {
        disableLogger: true,
        disableListenLog: true,
      }).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(() => listener, {
            host: "127.0.0.1",
            port: Number(new URL(server.url).port),
          }),
        ),
      ),
    );
    // A server that exits closes every connection to it, as the product's listener also does
    // when it shuts down. One left open would keep the port from the next server on Windows.
    yield* Effect.addFinalizer(() => Effect.sync(() => listener.closeAllConnections()));
    return {
      requests: Ref.get(requests),
      /** How many times it has said it is stopping. */
      answered: Ref.get(requests).pipe(
        Effect.map((all) => all.filter((request) => request === "GET /api/service").length),
      ),
    };
  });

/** Variables for one command; `undefined` removes one the helper sets, such as EXECUTOR_PORT. */
export type Overrides = Readonly<Record<string, string | undefined>>;

/** `source` runs the checkout's CLI under Node, even when the scenario tests a release executable. */
export interface RunOptions {
  readonly source?: boolean;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Connection links carry a one-use credential; evidence keeps only their shape. */
const redact = (text: string) => text.replace(/#pair=[a-f0-9]{64}/gu, "#pair=<redacted>");

/**
 * Records the last argument it was started with, which is the URL for `open`, `xdg-open` and
 * `rundll32 url.dll,FileProtocolHandler`.
 */
const openerSource = `import { appendFileSync } from "node:fs";
appendFileSync(process.env.EXECUTOR_E2E_OPENED, process.argv.at(-1) + "\\n");
`;

/** A command did not reach the state a scenario waits for; the message says which. */
export class ServiceCliFailed extends Schema.TaggedError<ServiceCliFailed>()("ServiceCliFailed", {
  message: Schema.String,
}) {}

const otherUser = Schema.is(Schema.Struct({ code: Schema.Literal("EPERM") }));
/** Signal 0 checks that a process exists; EPERM means it exists under another user. */
const alive = (pid: number) =>
  Effect.try({ try: () => process.kill(pid, 0), catch: otherUser }).pipe(
    Effect.match({ onSuccess: () => true, onFailure: (exists) => exists }),
  );

/**
 * Windows: when the process a process ID names now started, in 100-nanosecond ticks. Windows soon
 * gives a freed process ID to another process, often another `executor.exe`: the next server, or a
 * command another scenario runs at the same time. An image name cannot tell those apart; a start
 * time can. Windows keeps no start time a Node program reads without starting one, so PowerShell
 * reads it.
 */
export const windowsStartTime = (pid: number) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* processes
      .lines(
        ChildProcess.make(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
          ],
          { stderr: "ignore" },
        ),
      )
      .pipe(
        Effect.map((lines) =>
          Option.fromNullishOr(
            lines.map((line) => line.trim()).find((line) => /^\d+$/u.test(line)),
          ),
        ),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
  });

/**
 * End a background server as a crash would: nothing it runs on shutdown runs. Its child processes,
 * the telemetry collector and workerd, end with it, as they would with the machine. A server a
 * client starts is detached into its own process group, so POSIX signals that group, or the
 * process alone when it leads none; Windows ends the process tree. A process that has already
 * exited cannot be signalled, which is fine here.
 */
export const crashServer = (pid: number) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    if (process.platform === "win32") {
      yield* processes
        .exitCode(
          ChildProcess.make("taskkill", ["/pid", String(pid), "/t", "/f"], {
            stdout: "ignore",
            stderr: "ignore",
          }),
        )
        .pipe(Effect.ignore);
      return;
    }
    yield* Effect.try(() => process.kill(-pid, "SIGKILL")).pipe(
      Effect.catch(() => Effect.try(() => process.kill(pid, "SIGKILL"))),
      Effect.ignore,
    );
  });

/**
 * Whether `server` still answers on its address as that process, starting, ready or stopping.
 * Only then is its pid known to be the server's, and safe to end with its process tree.
 */
export const answersAsServer = (server: ServiceRegistration) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.get(`${server.url}/api/service`);
    const body = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(ServiceInfo)));
    return body.id === server.id && body.pid === server.pid;
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() => false),
  );

/** Repeat `check` every 100 ms until `done` holds, failing once `within` passes first. */
export const eventually = <A, E, R>(
  check: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
  within: Duration.Input,
) =>
  check.pipe(
    Effect.repeat({ until: done, schedule: Schedule.spaced("100 millis") }),
    Effect.timeout(within),
  );

/**
 * A browser opener that records the URL it was asked to open, under `root`. Put
 * `environment` in a command's environment: it puts the opener first on PATH. The launcher opens
 * links with `open` on macOS, `xdg-open` elsewhere on Unix and `rundll32` on Windows, which starts
 * only an executable, so the opener is compiled there.
 */
export const fakeBrowserOpener = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const bin = path.join(root, "bin");
    const log = path.join(root, "opened.log");
    const opener = path.join(root, "opener.mjs");
    yield* fs.makeDirectory(bin, { recursive: true });
    yield* fs.writeFileString(opener, openerSource);
    if (process.platform === "win32") {
      const compiled = yield* processes.exitCode(
        ChildProcess.make(
          "bun",
          ["build", "--compile", opener, "--outfile", path.join(bin, "rundll32.exe")],
          { stdout: "ignore", stderr: "inherit" },
        ),
      );
      if (Number(compiled) !== 0) return yield* Effect.die("Could not build the fake opener");
    } else
      for (const name of ["open", "xdg-open"]) {
        yield* fs.writeFileString(
          path.join(bin, name),
          `#!/bin/sh\nexec "${process.execPath}" "${opener}" "$@"\n`,
        );
        yield* fs.chmod(path.join(bin, name), 0o755);
      }
    return {
      environment: {
        PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        EXECUTOR_E2E_OPENED: log,
      },
      /** Every URL the opener was given, in order. */
      opened: fs
        .exists(log)
        .pipe(
          Effect.flatMap((exists) =>
            exists
              ? fs.readFileString(log).pipe(Effect.map((text) => text.split("\n").filter(Boolean)))
              : Effect.succeed([]),
          ),
        ),
    };
  });

/**
 * A CLI with its own home and data directory under the scenario's folder, so a failed scenario
 * keeps the server's diagnostics. `port` is EXECUTOR_PORT; by default a free one, never 4312.
 */
export const backgroundServiceCli = (options: { readonly port?: number } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      processes = yield* ChildProcessSpawner.ChildProcessSpawner,
      http = yield* HttpClient.HttpClient,
      evidence = yield* Evidence,
      target = yield* Target;
    const packagedEntry = yield* Config.NonEmptyString("EXECUTOR_E2E_LOCAL_ENTRY").pipe(
      Config.option,
    );
    // A release executable reports the version it was built as; the checkout's CLI reports
    // EXECUTOR_BUILD_VERSION, so only it can stand in for another release.
    const source = path.resolve("apps/local/server/src/bin.ts");
    const entry = Option.isSome(packagedEntry) ? path.resolve(packagedEntry.value) : source;
    // Startup deploys the bundled Executor app, which pins this checkout's apps release.
    const registry = yield* Config.NonEmptyString("E2E_NPM_REGISTRY").pipe(Config.option);
    const catalogs = yield* Config.NonEmptyString("E2E_PUBLIC_CATALOGS").pipe(Config.option);
    const root = path.resolve(target.directory, "background-service");
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    yield* fs.makeDirectory(home, { recursive: true });
    const port = options.port ?? (yield* freePort);
    const url = `http://127.0.0.1:${port}`;
    const registrationFile = path.join(data, "server.json");
    // The checkout's CLI compiles its Worker host when no prepared one exists, as in the release
    // workflow, which builds none; a release executable carries its own.
    const workerBundle = path.resolve(".local/test-runtime/host.json");
    const prepared = yield* fs.exists(workerBundle);

    const browser = yield* fakeBrowserOpener(root);

    const environment = (overrides: Overrides) =>
      Object.fromEntries(
        Object.entries({
          ...browser.environment,
          ...(process.platform === "win32"
            ? {
                SystemRoot: process.env.SystemRoot,
                ComSpec: process.env.ComSpec,
                PATHEXT: process.env.PATHEXT,
                APPDATA: process.env.APPDATA,
                LOCALAPPDATA: process.env.LOCALAPPDATA,
              }
            : {}),
          HOME: home,
          USERPROFILE: home,
          // Release scenarios never send product analytics, even from a build with a baked key.
          DO_NOT_TRACK: "1",
          EXECUTOR_ENVIRONMENT: "e2e",
          // Keys stay in keys.json so no run touches the machine's OS credential store.
          EXECUTOR_KEY_STORAGE: "file",
          EXECUTOR_NO_UPDATE_CHECK: "1",
          ...(prepared ? { EXECUTOR_WORKER_BUNDLE: workerBundle } : {}),
          ...(Option.isSome(registry) ? { EXECUTOR_NPM_REGISTRY: registry.value } : {}),
          ...(Option.isSome(catalogs)
            ? {
                EXECUTOR_CATALOG_URL: `${catalogs.value}/catalog/index.json`,
                EXECUTOR_REGISTRY_URL: catalogs.value,
              }
            : {}),
          EXECUTOR_DATA_DIR: data,
          EXECUTOR_PORT: String(port),
          ...overrides,
        }).flatMap(([name, value]) => (value === undefined ? [] : [[name, value] as const])),
      );
    const command = (args: ReadonlyArray<string>, overrides: Overrides, from: RunOptions) => {
      const file = from.source === true ? source : entry;
      const { command, args: argv } = localEntryCommand(file, args);
      return ChildProcess.make(command, argv, {
        // A working directory inside the scenario's folder could not be removed on Windows
        // while a stopped child finishes exiting.
        cwd: path.dirname(file),
        extendEnv: false,
        env: environment(overrides),
        stdout: "pipe",
        stderr: "pipe",
        forceKillAfter: "5 seconds",
      });
    };

    /** Run one command to exit and return its code and complete output. */
    const exec = (args: ReadonlyArray<string>, overrides: Overrides, from: RunOptions = {}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* processes.spawn(command(args, overrides, from));
          const [code, stdout, stderr] = yield* Effect.all(
            [
              child.exitCode,
              child.stdout.pipe(Stream.decodeText(), Stream.mkString),
              child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            ],
            { concurrency: 3 },
          ).pipe(Effect.timeout("150 seconds"));
          return { code: Number(code), stdout, stderr } satisfies CommandResult;
        }),
      );
    let commands = 0;
    const run = (args: ReadonlyArray<string>, overrides: Overrides = {}, from: RunOptions = {}) =>
      evidence.step(
        `executor ${args.join(" ")}`.trim(),
        Effect.gen(function* () {
          const result = yield* exec(args, overrides, from);
          commands += 1;
          yield* evidence.json(
            `command-${commands}-${args.join("-").replaceAll(/[^a-z0-9-]+/gu, "") || "executor"}.json`,
            {
              args,
              overrides,
              ...from,
              code: result.code,
              stdout: redact(result.stdout),
              stderr: redact(result.stderr),
            },
          );
          return result;
        }),
      );

    /**
     * Start a command that keeps running in the caller's scope, and wait for the first output line
     * `ready` accepts. Fails, keeping the output, if the command exits first. `output` reads what it
     * has written on stdout and stderr so far, with links redacted.
     */
    const start = (
      args: ReadonlyArray<string>,
      ready: (line: string) => boolean,
      overrides: Overrides = {},
    ) =>
      evidence.step(
        `start executor ${args.join(" ")}`,
        Effect.gen(function* () {
          const child = yield* processes.spawn(command(args, overrides, {}));
          const output = yield* Ref.make("");
          const matched = yield* Deferred.make<string>();
          yield* Stream.merge(child.stdout, child.stderr).pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) =>
              Ref.update(output, (before) => `${before}${redact(line)}\n`).pipe(
                Effect.andThen(ready(line) ? Deferred.succeed(matched, line) : Effect.void),
              ),
            ),
            Effect.forkScoped,
          );
          commands += 1;
          const saved = `command-${commands}-${args.join("-").replaceAll(/[^a-z0-9-]+/gu, "")}.json`;
          yield* Effect.addFinalizer(() =>
            Ref.get(output).pipe(Effect.flatMap((text) => evidence.json(saved, { args, text }))),
          );
          const line = yield* Effect.raceFirst(
            Deferred.await(matched),
            child.exitCode.pipe(
              Effect.flatMap((code) =>
                Effect.fail(
                  new ServiceCliFailed({
                    message: `executor ${args.join(" ")} exited (${code}) before it was ready`,
                  }),
                ),
              ),
            ),
          ).pipe(Effect.timeout("150 seconds"));
          return { child, line, output: Ref.get(output) };
        }),
      );

    const startOf = (pid: number) =>
      windowsStartTime(pid).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, processes),
      );
    /** On Windows, when each server this scenario saw started. */
    const starts = new Map<number, string>();
    /**
     * Whether `pid` still names a process. On Windows a server's ID counts only while it names a
     * process that started when that server did, since the ID may already name another process.
     */
    const running = (pid: number) =>
      Effect.gen(function* () {
        if (!(yield* alive(pid))) return false;
        const start = starts.get(pid);
        if (start === undefined) return true;
        return Option.contains(yield* startOf(pid), start);
      });
    /** Every server this scenario saw registered, by id, for cleanup. */
    const seen = new Map<string, ServiceRegistration>();
    /** The registered server, if `server.json` exists. */
    const registration = Effect.gen(function* () {
      if (!(yield* fs.exists(registrationFile))) return Option.none<ServiceRegistration>();
      const text = yield* fs.readFileString(registrationFile);
      const value = yield* Schema.decodeUnknownEffect(RegistrationJson)(text);
      seen.set(value.id, value);
      if (process.platform === "win32" && !starts.has(value.pid)) {
        const start = yield* startOf(value.pid);
        if (Option.isSome(start)) starts.set(value.pid, start.value);
      }
      return Option.some(value);
    });
    const registered = registration.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new ServiceCliFailed({ message: `${registrationFile} does not exist` })),
          onSome: Effect.succeed,
        }),
      ),
    );

    /** What `GET /api/service` answers at `base`. */
    const info = (base: string) =>
      http.get(`${base}/api/service`).pipe(
        Effect.flatMap((response) =>
          response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ServiceInfo)),
            Effect.map((body) => ({ status: response.status, body })),
          ),
        ),
        Effect.timeout("5 seconds"),
      );
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* exec(["service", "stop"], {}).pipe(Effect.ignore);
        // A start attempt that outlived its command can take the port once the server stops; it
        // registers before it opens storage, so a second stop finds it.
        if (Option.isSome(yield* info(url).pipe(Effect.option)))
          yield* exec(["service", "stop"], {}).pipe(Effect.ignore);
        // Whatever still answers as a server this scenario saw, the registered one included, is
        // ended with its collector and workerd. A pid that does not answer as its server may name
        // another program by now, so it is left alone.
        const left = yield* registration.pipe(Effect.orElseSucceed(() => Option.none()));
        for (const server of [...Option.toArray(left), ...seen.values()])
          if (yield* answersAsServer(server)) yield* crashServer(server.pid);
      }),
    );

    return {
      /** EXECUTOR_PORT and its loopback URL. */
      port,
      url,
      /** The absolute data directory, as the product names it in messages. */
      data,
      registrationFile,
      run,
      start,
      registration,
      registered,
      info,
      /** Whether a process ID still names its process; see `running`. */
      alive: running,
      /** Whether nothing listens on `port` any more. */
      refused: connectionRefused,
      /** Every URL the fake browser opener was given, in order. */
      opened: browser.opened,
    };
  });
