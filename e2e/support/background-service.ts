import {
  Config,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
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

export const starting = "Starting background Executor...";

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

export const ServiceInfo = Schema.Struct({
  id: Schema.String,
  version: Schema.String,
  pid: Schema.Number,
  status: Schema.Literals(["starting", "ready", "stopping"]),
});

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
    yield* Effect.addFinalizer(() => Effect.sync(() => listener.closeAllConnections()));
    return {
      requests: Ref.get(requests),
      answered: Ref.get(requests).pipe(
        Effect.map((all) => all.filter((request) => request === "GET /api/service").length),
      ),
    };
  });

export type Overrides = Readonly<Record<string, string | undefined>>;

export interface RunOptions {
  readonly source?: boolean;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const redact = (text: string) => text.replace(/#pair=[a-f0-9]{64}/gu, "#pair=<redacted>");

const openerSource = `import { appendFileSync } from "node:fs";
appendFileSync(process.env.EXECUTOR_E2E_OPENED, process.argv.at(-1) + "\\n");
`;

export class ServiceCliFailed extends Schema.TaggedError<ServiceCliFailed>()("ServiceCliFailed", {
  message: Schema.String,
}) {}

const otherUser = Schema.is(Schema.Struct({ code: Schema.Literal("EPERM") }));
export const alive = (pid: number) =>
  Effect.try({ try: () => process.kill(pid, 0), catch: otherUser }).pipe(
    Effect.match({ onSuccess: () => true, onFailure: (exists) => exists }),
  );

class StartTimeUnreadable extends Schema.TaggedError<StartTimeUnreadable>()("StartTimeUnreadable", {
  message: Schema.String,
}) {}

const startTimeScript = [
  "$ErrorActionPreference = 'Stop'",
  "while ($null -ne ($line = [Console]::In.ReadLine())) {",
  "  try { $ticks = (Get-Process -Id ([int]$line)).StartTime.ToUniversalTime().Ticks } catch { $ticks = 'none' }",
  "  [Console]::Out.WriteLine($ticks); [Console]::Out.Flush()",
  "}",
].join("\n");

export const windowsStartTimes = Effect.gen(function* () {
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const questions = yield* Queue.unbounded<Uint8Array>();
  const waiting: Array<Deferred.Deferred<Option.Option<string>, StartTimeUnreadable>> = [];
  const child = yield* processes.spawn(
    ChildProcess.make(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", startTimeScript],
      { stdin: Stream.fromQueue(questions), stderr: "ignore" },
    ),
  );
  const unanswered = (message: string) =>
    Effect.sync(() => {
      for (const deferred of waiting.splice(0))
        Deferred.doneUnsafe(deferred, Effect.fail(new StartTimeUnreadable({ message })));
    });
  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) =>
      Effect.sync(() => {
        const answer = line.trim();
        const deferred = waiting.shift();
        if (deferred !== undefined)
          Deferred.doneUnsafe(
            deferred,
            Effect.succeed(/^\d+$/u.test(answer) ? Option.some(answer) : Option.none()),
          );
      }),
    ),
    Effect.ignore,
    Effect.andThen(unanswered("PowerShell stopped answering start time questions")),
    Effect.forkScoped,
  );
  const encoder = new TextEncoder();
  return (pid: number) =>
    Effect.gen(function* () {
      const deferred = Deferred.makeUnsafe<Option.Option<string>, StartTimeUnreadable>();
      yield* Effect.sync(() => {
        waiting.push(deferred);
        Queue.offerUnsafe(questions, encoder.encode(`${pid}\n`));
      });
      return yield* Deferred.await(deferred);
    }).pipe(
      Effect.timeoutOrElse({
        duration: "60 seconds",
        orElse: () =>
          Effect.fail(
            new StartTimeUnreadable({
              message: `PowerShell gave no start time for ${pid} in 60 s`,
            }),
          ),
      }),
      Effect.orDie,
    );
});

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

export const sameProcess = <R>(
  pid: number,
  recorded: string | undefined,
  probe: {
    readonly alive: (pid: number) => Effect.Effect<boolean, never, R>;
    readonly startTime: (pid: number) => Effect.Effect<Option.Option<string>, never, R>;
  },
) =>
  Effect.gen(function* () {
    if (!(yield* probe.alive(pid))) return false;
    if (recorded === undefined) return true;
    return Option.contains(yield* probe.startTime(pid), recorded);
  });

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

export const eventually = <A, E, R>(
  check: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
  within: Duration.Input,
) =>
  check.pipe(
    Effect.repeat({ until: done, schedule: Schedule.spaced("100 millis") }),
    Effect.timeout(within),
  );

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
    const source = path.resolve("apps/local/server/src/bin.ts");
    const entry = Option.isSome(packagedEntry) ? path.resolve(packagedEntry.value) : source;
    const registry = yield* Config.NonEmptyString("E2E_NPM_REGISTRY").pipe(Config.option);
    const catalogs = yield* Config.NonEmptyString("E2E_PUBLIC_CATALOGS").pipe(Config.option);
    const root = path.resolve(target.directory, "background-service");
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    yield* fs.makeDirectory(home, { recursive: true });
    const port = options.port ?? (yield* freePort);
    const url = `http://127.0.0.1:${port}`;
    const registrationFile = path.join(data, "server.json");
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
          DO_NOT_TRACK: "1",
          EXECUTOR_ENVIRONMENT: "e2e",
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
        cwd: path.dirname(file),
        extendEnv: false,
        env: environment(overrides),
        stdout: "pipe",
        stderr: "pipe",
        forceKillAfter: "5 seconds",
      });
    };

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

    const startOf =
      process.platform === "win32"
        ? yield* windowsStartTimes
        : () => Effect.succeed(Option.none<string>());
    const starts = new Map<number, string>();
    const running = (pid: number) =>
      sameProcess(pid, starts.get(pid), { alive, startTime: startOf });
    const seen = new Map<string, ServiceRegistration>();
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
        if (Option.isSome(yield* info(url).pipe(Effect.option)))
          yield* exec(["service", "stop"], {}).pipe(Effect.ignore);
        const left = yield* registration.pipe(Effect.orElseSucceed(() => Option.none()));
        for (const server of [...Option.toArray(left), ...seen.values()])
          if (yield* answersAsServer(server)) yield* crashServer(server.pid);
      }),
    );

    return {
      port,
      url,
      data,
      registrationFile,
      run,
      start,
      registration,
      registered,
      info,
      alive: running,
      refused: connectionRefused,
      opened: browser.opened,
    };
  });
