import { expect } from "@effect/vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import {
  type Cause,
  Config,
  Console,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  type PlatformError,
  Queue,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  answersAsServer,
  crashServer,
  ServiceInfo,
  ServiceRegistration,
  windowsStartTime,
} from "./background-service.ts";
import { captureOutput, closeDesktop, redactLinks } from "./desktop-quit.ts";
import { driver } from "./platform.ts";
import { reveal } from "./failure-text.ts";

export const runnerSession = () =>
  Object.fromEntries(
    [
      "DISPLAY",
      "XAUTHORITY",
      "WAYLAND_DISPLAY",
      "XDG_RUNTIME_DIR",
      "XDG_SESSION_TYPE",
      "XDG_CURRENT_DESKTOP",
      "DBUS_SESSION_BUS_ADDRESS",
      "SystemRoot",
    ].flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value] as const];
    }),
  );

export const requestBrowserPairing = (electron: ElectronApplication, origin: string) =>
  driver("pair from the native desktop session", () =>
    electron.evaluate(({ session }, origin) => {
      return session
        .fromPartition("executor-desktop")
        .fetch(`${origin}/auth/pair`, {
          method: "POST",
          credentials: "include",
          headers: { origin },
          redirect: "error",
        })
        .then((response) => response.json().then((body) => ({ status: response.status, body })));
    }, origin),
  );

const installElectron = (electron: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const child = yield* processes.spawn(
        ChildProcess.make(process.execPath, [path.join(electron, "install.js")], {
          cwd: electron,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "inherit",
          forceKillAfter: "5 seconds",
        }),
      );
      const code = Number(yield* child.exitCode.pipe(Effect.timeout("10 minutes")));
      if (code !== 0)
        return yield* Effect.fail(new Error(`Electron's installer exited with ${code}`));
    }),
  );

const desktopExecutable = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packaged = yield* Config.String("EXECUTOR_E2E_DESKTOP_EXECUTABLE").pipe(Config.option);
  if (Option.isSome(packaged)) return { executablePath: packaged.value, args: ["--disable-gpu"] };
  const desktop = path.resolve("apps/local/desktop");
  if (!(yield* fs.exists(path.join(desktop, "dist/main.cjs"))))
    return yield* Effect.fail(
      new Error("Build the desktop entry first: node apps/local/desktop/scripts/build.mjs"),
    );
  const electron = path.join(desktop, "node_modules/electron");
  const pathFile = path.join(electron, "path.txt");
  if (!(yield* fs.exists(pathFile))) yield* installElectron(electron);
  const binary = (yield* fs.readFileString(pathFile)).trim();
  return {
    executablePath: path.join(electron, "dist", binary),
    args: [desktop, "--disable-gpu"],
  };
});

export const openDesktopLink = (options: {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly link: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const launch = yield* desktopExecutable;
      const child = yield* processes.spawn(
        ChildProcess.make(
          launch.executablePath,
          [...launch.args, ...(process.platform === "linux" ? ["--no-sandbox"] : []), options.link],
          {
            cwd: options.cwd,
            extendEnv: false,
            env: { ...options.env },
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            forceKillAfter: "5 seconds",
          },
        ),
      );
      return Number(yield* child.exitCode.pipe(Effect.timeout("60 seconds")));
    }),
  );

export const choseRunLocally = (profile: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(profile, "desktop-accounts.json");
    if (yield* fs.exists(file)) return;
    yield* fs.makeDirectory(profile, { recursive: true });
    yield* fs.writeFileString(file, JSON.stringify({ version: 1, local: true, lastUsed: null }));
  });

export const dashboardReady = (page: Page, operation = "dashboard is visible") =>
  driver(operation, () =>
    page
      .getByRole("heading", { name: /^Apps/ })
      .waitFor({ state: "visible", timeout: 60_000 })
      .then(() =>
        page.waitForFunction(
          () => document.documentElement.hasAttribute("data-hydrated") && !("$_TSR" in window),
          undefined,
          { timeout: 60_000 },
        ),
      ),
  );

export const runsScripts = (electron: ElectronApplication, page: Page) =>
  page.isClosed()
    ? Promise.resolve(false)
    : electron
        .browserWindow(page)
        .then((window) =>
          window.evaluate(
            (shown) => shown.webContents.getLastWebPreferences()?.javascript !== false,
          ),
        )
        .catch(() => false);

export const welcomeWindow = (electron: ElectronApplication) =>
  driver("find the welcome window", () =>
    Promise.all(
      electron.windows().map((page) =>
        page
          .title()
          .then((title) => ({ title, page }))
          .catch(() => ({ title: "", page })),
      ),
    ).then((pages) => {
      const found = pages.find(({ title }) => title === "Welcome to Executor");
      if (found === undefined) throw new Error("No window shows the welcome page");
      return found.page;
    }),
  ).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }));

export const runLocally = (electron: ElectronApplication) =>
  Effect.gen(function* () {
    const welcome = yield* welcomeWindow(electron);
    yield* driver("choose Run locally", () =>
      welcome.getByRole("button", { name: "Run locally", exact: true }).click(),
    );
  });

export const localWindow = (electron: ElectronApplication) =>
  driver("find the local window", () =>
    Promise.all(
      electron.windows().map((page) =>
        page.isClosed()
          ? Promise.resolve({ title: "", page })
          : page
              .title()
              .then((title) => ({ title, page }))
              .catch(() => ({ title: "", page })),
      ),
    ).then((pages) => {
      const found = pages.find(
        ({ title, page }) => !page.isClosed() && title !== "Welcome to Executor" && title !== "",
      );
      if (found === undefined) throw new Error("No window shows this computer's Executor");
      return found.page;
    }),
  ).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }));

export const launchDesktop = (options: {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly args?: ReadonlyArray<string>;
  readonly welcome?: boolean;
}) =>
  Effect.gen(function* () {
    const launch = yield* desktopExecutable;
    const data = options.env.EXECUTOR_DESKTOP_DATA_DIR;
    const profile = options.env.EXECUTOR_DESKTOP_PROFILE_DIR;
    if (options.welcome !== true && profile !== undefined) yield* choseRunLocally(profile);
    const electron = yield* Effect.acquireRelease(
      driver("launch desktop", () =>
        _electron.launch({
          executablePath: launch.executablePath,
          args: [...launch.args, ...(options.args ?? [])],
          cwd: options.cwd,
          env: { ...options.env },
        }),
      ).pipe(Effect.map((electron) => ({ electron, output: captureOutput(electron) }))),
      ({ electron, output }) =>
        closeDesktop(electron, { ...(data === undefined ? {} : { data }), output }).pipe(
          Effect.orDie,
        ),
    ).pipe(Effect.map(({ electron }) => electron));
    if (data !== undefined)
      yield* Effect.addFinalizer((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : desktopEvents(data).pipe(
              Effect.flatMap((events) => Console.error(lifecycleLog(events))),
              Effect.ignore,
              Effect.andThen(keepEvidence(electron, data).pipe(Effect.ignore)),
            ),
      );
    return electron;
  });

const keepEvidence = (electron: ElectronApplication, data: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const screenshots = yield* Config.String("EXECUTOR_E2E_DESKTOP_SCREENSHOTS").pipe(
      Config.withDefault(".local/desktop-recovery"),
    );
    const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
    const directory = path.resolve(screenshots, `failed-${stamp}-${process.pid}`);
    yield* fs.makeDirectory(directory, { recursive: true });
    const { currentTestName, testPath } = expect.getState();
    yield* fs.writeFileString(
      path.join(directory, "scenario.json"),
      JSON.stringify({ title: currentTestName ?? "", file: testPath ?? "" }),
    );
    yield* Effect.forEach(
      electron.windows(),
      (page, index) =>
        driver("capture the failed scenario's window", () =>
          page.screenshot({
            path: path.join(directory, `window-${index + 1}.png`),
            timeout: 10_000,
          }),
        ).pipe(Effect.ignore),
      { discard: true },
    );
    const diagnostics = path.join(data, "diagnostics");
    const logs = (yield* fs.readDirectory(diagnostics).pipe(Effect.orElseSucceed(() => []))).filter(
      (name) => name.endsWith(".jsonl"),
    );
    for (const name of logs)
      yield* fs.readFileString(path.join(diagnostics, name)).pipe(
        Effect.flatMap((text) =>
          fs.writeFileString(path.join(directory, name), redactLinks(text), { mode: 0o600 }),
        ),
        Effect.ignore,
      );
    yield* Console.error(`The failed scenario's desktop windows and logs are in ${directory}`);
  });

const lifecycleMessages = new Set([
  "Starting Executor desktop",
  "Moved the desktop's data",
  "Executor could not move the desktop's data",
  "Connecting to the background Executor",
  "Starting the background Executor",
  "Background Executor ready",
  "Background Executor stopped answering",
  "Background Executor could not start",
  "Could not pair with the background Executor",
  "Executor desktop ready",
  "Desktop window could not load the dashboard",
  "Showing desktop recovery",
  "Showing the moved data notice",
  "Resetting Executor data",
  "Moved Executor data to a backup",
  "Executor data reset failed",
  "Desktop stopped",
  "Desktop quitting",
  "Desktop still quitting",
  "Desktop closed",
  "Desktop uncaught exception",
]);

const lifecycleLog = (events: ReadonlyArray<DesktopEvent>) => {
  const lifecycle = events.filter((event) => lifecycleMessages.has(event.message));
  const lines = lifecycle.map(({ annotations: { detail, error, ...annotations }, ...event }) =>
    JSON.stringify({
      ...event,
      annotations: {
        ...annotations,
        ...(detail === undefined ? {} : { detailCharacters: detail.length }),
        ...(error === undefined ? {} : { error: redactLinks(error.split("\n")[0] ?? "") }),
      },
    }),
  );
  return [
    "Desktop lifecycle at the end of the scenario:",
    ...lines,
    `Other desktop log events not shown: ${events.length - lifecycle.length}.`,
  ].join("\n");
};

const LogLine = Schema.fromJsonString(
  Schema.Struct({
    timestamp: Schema.String,
    level: Schema.String,
    message: Schema.String,
    annotations: Schema.Struct({
      url: Schema.optional(Schema.String),
      pid: Schema.optional(Schema.Number),
      version: Schema.optional(Schema.String),
      origin: Schema.optional(Schema.String),
      loss: Schema.optional(Schema.String),
      stage: Schema.optional(Schema.String),
      configuration: Schema.optional(Schema.String),
      detail: Schema.optional(Schema.String),
      recovery: Schema.optional(
        Schema.Struct({ stage: Schema.String, reason: Schema.optional(Schema.String) }),
      ),
      kind: Schema.optional(Schema.String),
      archived: Schema.optional(Schema.String),
      backup: Schema.optional(Schema.String),
      settings: Schema.optional(
        Schema.Struct({
          port: Schema.optional(Schema.Struct({ from: Schema.Number, to: Schema.Number })),
          variables: Schema.optional(Schema.Array(Schema.String)),
          removed: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
      failure: Schema.optional(Schema.String),
      attempt: Schema.optional(Schema.Number),
      reason: Schema.optional(Schema.String),
      closing: Schema.optional(Schema.String),
      seconds: Schema.optional(Schema.Number),
      startedAt: Schema.optional(Schema.String),
      outcome: Schema.optional(Schema.String),
      resources: Schema.optional(Schema.Array(Schema.String)),
      error: Schema.optional(Schema.String),
    }),
  }),
);
export type DesktopEvent = typeof LogLine.Type;

export const desktopEvents = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(directory, "diagnostics", "executor-desktop.jsonl");
    if (!(yield* fs.exists(file))) return [];
    const text = yield* fs.readFileString(file);
    return text.split("\n").flatMap((line) => {
      const entry = Schema.decodeUnknownOption(LogLine)(line);
      if (Option.isNone(entry)) return [];
      const { detail } = entry.value.annotations;
      return detail === undefined
        ? [entry.value]
        : [
            {
              ...entry.value,
              annotations: {
                ...entry.value.annotations,
                detail: redactLinks(detail),
              },
            },
          ];
    });
  });

export const eventsNamed = (directory: string, message: string, count: number) =>
  desktopEvents(directory).pipe(
    Effect.map((events) => events.filter((event) => event.message === message)),
    Effect.flatMap((events) =>
      events.length >= count
        ? Effect.succeed(events)
        : Effect.fail(new Error(`The desktop has logged "${message}" ${events.length} times`)),
    ),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
  );

export const serverStarts = (directory: string) =>
  desktopEvents(directory).pipe(
    Effect.map(
      (events) =>
        events.filter((event) => event.message === "Starting the background Executor").length,
    ),
  );

const RegistrationJson = Schema.fromJsonString(ServiceRegistration);

export const registeredServer = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(directory, "server.json");
    if (!(yield* fs.exists(file))) return Option.none<ServiceRegistration>();
    return yield* fs
      .readFileString(file)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(RegistrationJson)), Effect.option);
  });

export const answersReady = (server: ServiceRegistration) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.get(`${server.url}/api/service`);
    const info = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(ServiceInfo)));
    return (
      response.status === 200 &&
      info.status === "ready" &&
      info.id === server.id &&
      info.pid === server.pid
    );
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() => false),
  );

const suspenderScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -Namespace ExecutorE2E -Name Suspension -MemberDefinition @'
[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr process);
[DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr process);
'@
$held = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
function Hold([int] $id) {
  $process = [System.Diagnostics.Process]::GetProcessById($id)
  $status = [ExecutorE2E.Suspension]::NtSuspendProcess($process.Handle)
  if ($status -ne 0) { throw "NtSuspendProcess($id) returned $status" }
  $held.Add($process)
}
function Release {
  foreach ($process in $held) { [void][ExecutorE2E.Suspension]::NtResumeProcess($process.Handle) }
  $held.Clear()
}
function Reply([string] $line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }
function Stall([int] $app) {
  $until = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $until) {
    $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CommandLine)
    $ours = @{ $app = $true }
    do {
      $grew = $false
      foreach ($row in $all) {
        if ($ours.ContainsKey([int] $row.ParentProcessId) -and -not $ours.ContainsKey([int] $row.ProcessId)) {
          $ours[[int] $row.ProcessId] = $true
          $grew = $true
        }
      }
    } while ($grew)
    $starter = $all | Where-Object { $ours.ContainsKey([int] $_.ProcessId) -and $_.CommandLine -like '*node.mojom.NodeService*' } | Select-Object -First 1
    if ($starter) {
      $attempt = $all | Where-Object { $_.ParentProcessId -eq $starter.ProcessId -and $_.CommandLine -like '*serve --service*' } | Select-Object -First 1
      if ($attempt) {
        Hold $starter.ProcessId
        Hold $attempt.ProcessId
        return "$($starter.ProcessId) $($attempt.ProcessId)"
      }
    }
    Start-Sleep -Milliseconds 20
  }
  throw "No server starter of process $app started an attempt within 60 seconds"
}
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $command, $argument = $line.Split(' ', 2)
  try {
    switch ($command) {
      'suspend' { Hold ([int] $argument); Reply 'suspended' }
      'stall' { Reply (Stall ([int] $argument)) }
      'resume' { Release; Reply 'resumed' }
      default { throw "Unknown command $command" }
    }
  } catch {
    Reply "error $($_.Exception.Message)"
  }
}
Release
`;

const windowsSuspender = Effect.gen(function* () {
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const commands = yield* Queue.unbounded<string, Cause.Done>();
  const child = yield* processes.spawn(
    ChildProcess.make(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(suspenderScript, "utf16le").toString("base64"),
      ],
      {
        stdin: Stream.fromQueue(commands).pipe(
          Stream.map((line) => `${line}\n`),
          Stream.encodeText,
        ),
        stderr: "inherit",
      },
    ),
  );
  yield* Effect.addFinalizer(() =>
    Queue.end(commands).pipe(
      Effect.andThen(child.exitCode),
      Effect.timeout("30 seconds"),
      Effect.ignore,
    ),
  );
  const replies = yield* Queue.unbounded<string, PlatformError.PlatformError | Cause.Done>();
  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runIntoQueue(replies),
    Effect.forkScoped,
  );
  return (command: string) =>
    Queue.offer(commands, command).pipe(
      Effect.andThen(Queue.take(replies)),
      Effect.timeout("90 seconds"),
      Effect.mapError(() => new Error(`The process suspender did not answer "${command}"`)),
      Effect.flatMap((reply) =>
        reply.startsWith("error ")
          ? Effect.fail(new Error(`The process suspender could not ${reply.slice(6)}`))
          : Effect.succeed(reply),
      ),
    );
});

export const suspendProcess = (pid: number) =>
  Effect.gen(function* () {
    if (process.platform === "win32") {
      const send = yield* windowsSuspender;
      yield* send(`suspend ${pid}`);
      return { resume: send("resume").pipe(Effect.ignore) };
    }
    yield* Effect.try(() => process.kill(pid, "SIGSTOP"));
    const resume = Effect.try(() => process.kill(pid, "SIGCONT")).pipe(Effect.ignore);
    yield* Effect.addFinalizer(() => resume);
    return { resume };
  });

export const stallStarter = (electron: ElectronApplication) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const app = electron.process().pid;
    if (app === undefined) return yield* Effect.fail(new Error("The desktop has no process ID"));
    if (process.platform === "win32") {
      const send = yield* windowsSuspender;
      const [starter = 0, attempt = 0] = (yield* send(`stall ${app}`)).split(" ").map(Number);
      if (!(starter > 0 && attempt > 0))
        return yield* Effect.fail(new Error("The desktop's server starter started no attempt"));
      return { starter, attempt, resume: send("resume").pipe(Effect.ignore) };
    }
    const Row = /^\s*(\d+)\s+(\d+)\s+(.*)$/u;
    const found = yield* processes
      .lines(ChildProcess.make("ps", ["-A", "-o", "pid=,ppid=,command="]))
      .pipe(
        Effect.flatMap((lines) => {
          const rows = lines.flatMap((line) => {
            const match = Row.exec(line);
            return match === null
              ? []
              : [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] ?? "" }];
          });
          const ours = new Set([app]);
          for (let grew = true; grew;) {
            grew = false;
            for (const row of rows)
              if (ours.has(row.parent) && !ours.has(row.pid)) {
                ours.add(row.pid);
                grew = true;
              }
          }
          const starter = rows.find(
            (row) => ours.has(row.pid) && row.command.includes("node.mojom.NodeService"),
          );
          const attempt =
            starter === undefined ? undefined : rows.find((row) => row.parent === starter.pid);
          if (starter === undefined || attempt === undefined)
            return Effect.fail(
              new Error("The desktop's server starter has started no attempt yet"),
            );
          return Effect.try(() => {
            process.kill(starter.pid, "SIGSTOP");
            process.kill(attempt.pid, "SIGSTOP");
            return { starter: starter.pid, attempt: attempt.pid };
          });
        }),
        Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 3000 }),
      );
    const resume = Effect.forEach(
      [found.starter, found.attempt],
      (pid) => Effect.try(() => process.kill(pid, "SIGCONT")).pipe(Effect.ignore),
      { discard: true },
    );
    yield* Effect.addFinalizer(() => resume);
    return { ...found, resume };
  });

export const processAlive = (pid: number) =>
  Effect.try({
    try: () => process.kill(pid, 0),
    catch: (error) => Schema.is(Schema.Struct({ code: Schema.Literal("EPERM") }))(error),
  }).pipe(Effect.match({ onSuccess: () => true, onFailure: (exists) => exists }));

export const nextServer = (directory: string, seen: ReadonlyArray<ServiceRegistration>) =>
  registeredServer(directory).pipe(
    Effect.flatMap((found) =>
      Option.isSome(found) && !seen.some((server) => server.id === found.value.id)
        ? answersReady(found.value).pipe(Effect.map((ready) => (ready ? found : Option.none())))
        : Effect.succeed(Option.none<ServiceRegistration>()),
    ),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new Error(`No new background server answers for ${directory} yet`)),
        onSome: Effect.succeed,
      }),
    ),
    Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 1200 }),
    Effect.tap((server) => {
      const earlier = seen.find((other) => other.pid === server.pid);
      return earlier === undefined
        ? Effect.void
        : Effect.logInfo(
            `Server ${server.id} has process ID ${server.pid}, which earlier server ${earlier.id} had`,
          );
    }),
    Effect.tap((server) =>
      process.platform === "win32"
        ? windowsStartTime(server.pid).pipe(
            Effect.map(Option.map((start) => windowsStarts.set(server.id, start))),
          )
        : Effect.void,
    ),
  );

const windowsStarts = new Map<string, string>();

export const serverExited = (server: ServiceRegistration) =>
  Effect.gen(function* () {
    if (!(yield* processAlive(server.pid))) return true;
    const start = windowsStarts.get(server.id);
    if (process.platform !== "win32" || start === undefined) return false;
    const now = yield* windowsStartTime(server.pid);
    if (Option.isNone(now)) return !(yield* processAlive(server.pid));
    return now.value !== start;
  });

export const stopBackgroundServers = (
  directory: string,
  seen: () => ReadonlyArray<ServiceRegistration>,
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const exited = (pid: number) =>
      processAlive(pid).pipe(
        Effect.repeat({
          while: (alive) => alive,
          schedule: Schedule.spaced("100 millis").pipe(Schedule.upTo({ times: 100 })),
        }),
        Effect.map((alive) => !alive),
      );
    const registered = yield* registeredServer(directory);
    for (const server of [...Option.toArray(registered), ...seen()]) {
      if (!(yield* answersAsServer(server))) continue;
      yield* http
        .post(`${server.url}/api/service/stop`, {
          headers: { authorization: `Bearer ${reveal(server.password)}` },
        })
        .pipe(Effect.timeout("5 seconds"), Effect.ignore);
      if (!(yield* exited(server.pid))) yield* crashServer(server.pid);
    }
  }).pipe(Effect.ignore);

export const answerDialogs = (
  electron: ElectronApplication,
  answers: Readonly<Record<string, number | "unanswered" | "held">>,
) =>
  driver("answer native dialogs", () =>
    electron.evaluate(({ dialog, BrowserWindow }, answers) => {
      const record: Array<{ title: string; message: string; detail: string }> = [];
      const parents: Array<{ title: string; parent: "none" | "hidden" | "visible" }> = [];
      Object.assign(globalThis, { executorE2EDialogParents: parents });
      const held = new Map<string, Array<(response: number) => void>>();
      Object.assign(globalThis, { executorE2EDialogs: record, executorE2EHeldDialogs: held });
      const answer = (...args: ReadonlyArray<unknown>) => {
        const box = args[args.length - 1] as {
          readonly title?: string;
          readonly message: string;
          readonly detail?: string;
          readonly cancelId?: number;
        };
        const title = box.title ?? "";
        record.push({ title, message: box.message, detail: box.detail ?? "" });
        const parent = args.length > 1 ? args[0] : undefined;
        parents.push({
          title,
          parent:
            parent instanceof BrowserWindow ? (parent.isVisible() ? "visible" : "hidden") : "none",
        });
        const chosen = answers[title];
        if (chosen === "unanswered") return new Promise<never>(() => undefined);
        if (chosen === "held")
          return new Promise<{ response: number; checkboxChecked: boolean }>((resolve) => {
            const waiting = held.get(title) ?? [];
            waiting.push((response) => resolve({ response, checkboxChecked: false }));
            held.set(title, waiting);
          });
        return Promise.resolve({ response: chosen ?? box.cancelId ?? 0, checkboxChecked: false });
      };
      Object.assign(dialog, { showMessageBox: answer });
    }, answers),
  );

export const heldDialogs = (electron: ElectronApplication, title: string) =>
  driver("count held dialogs", () =>
    electron.evaluate(
      (_, title) =>
        (
          Reflect.get(globalThis, "executorE2EHeldDialogs") as
            | Map<string, Array<(response: number) => void>>
            | undefined
        )?.get(title)?.length ?? 0,
      title,
    ),
  );

export const releaseHeldDialog = (electron: ElectronApplication, title: string, response: number) =>
  driver(`answer the held ${title} dialog`, () =>
    electron.evaluate(
      (_, [title, response]) => {
        const held = Reflect.get(globalThis, "executorE2EHeldDialogs") as Map<
          string,
          Array<(response: number) => void>
        >;
        const next = held.get(title)?.shift();
        if (next === undefined) throw new Error(`No ${title} dialog is held`);
        next(response);
      },
      [title, response] as const,
    ),
  );

export const recordExternalOpens = (electron: ElectronApplication) =>
  driver("record pages sent to the system browser", () =>
    electron.evaluate(({ shell }) => {
      const opened: Array<string> = [];
      Object.assign(globalThis, { executorE2EExternalOpens: opened });
      Object.assign(shell, {
        openExternal: (url: string) => {
          opened.push(url);
          return Promise.resolve();
        },
      });
    }),
  );

export const externalOpens = (electron: ElectronApplication) =>
  driver("read pages sent to the system browser", () =>
    electron.evaluate(
      () =>
        (Reflect.get(globalThis, "executorE2EExternalOpens") as Array<string> | undefined) ?? [],
    ),
  );

export const standInForNotifications = (electron: ElectronApplication) =>
  driver("stand in for the system's notifications", () =>
    electron.evaluate(({ Notification }) => {
      const shown: Array<Electron.Notification> = [];
      Object.assign(globalThis, { executorE2ENotifications: shown });
      Notification.prototype.show = function (this: Electron.Notification) {
        shown.push(this);
        queueMicrotask(() => this.emit("show", {}));
      };
    }),
  );

export const shownNotifications = (electron: ElectronApplication) =>
  driver("read the notifications the desktop showed", () =>
    electron.evaluate(() =>
      (
        (Reflect.get(globalThis, "executorE2ENotifications") as
          | Array<Electron.Notification>
          | undefined) ?? []
      ).map((shown) => ({ id: shown.id, title: shown.title, body: shown.body })),
    ),
  );

export const clickNotification = (electron: ElectronApplication, index: number) =>
  driver(`click shown notification ${index + 1}`, () =>
    electron.evaluate((_, index) => {
      const shown = (
        Reflect.get(globalThis, "executorE2ENotifications") as Array<Electron.Notification>
      )[index];
      if (shown === undefined) throw new Error(`No notification ${index + 1} was shown`);
      shown.emit("click", {});
    }, index),
  );

export const dialogParents = (electron: ElectronApplication, title: string) =>
  driver(`read the parents of ${title} dialogs`, () =>
    electron.evaluate(
      (_, title) =>
        (
          (Reflect.get(globalThis, "executorE2EDialogParents") as
            | Array<{ title: string; parent: string }>
            | undefined) ?? []
        )
          .filter((entry) => entry.title === title)
          .map((entry) => entry.parent),
      title,
    ),
  );

export const answeredDialogs = (electron: ElectronApplication) =>
  driver("read answered dialogs", () =>
    electron.evaluate(
      () =>
        Reflect.get(globalThis, "executorE2EDialogs") as
          | Array<{ title: string; message: string; detail: string }>
          | undefined,
    ),
  );

export const reportReplacedLoadFailuresLate = (electron: ElectronApplication) =>
  driver("report replaced loads' failures late", () =>
    electron.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows();
      if (window === undefined) throw new Error("The desktop has no window");
      const contents = window.webContents;
      const record = { reported: 0 };
      Object.assign(globalThis, { executorE2ELateLoadFailures: record });
      let previous = contents.getURL();
      contents.on("did-navigate", (_event, url) => {
        const replaced = previous;
        previous = url;
        if (!url.startsWith("data:") || replaced.startsWith("data:")) return;
        record.reported += 1;
        contents.emit("did-fail-load", {}, -3, "", replaced, true);
      });
    }),
  );

export const lateLoadFailures = (electron: ElectronApplication) =>
  driver("read late load failure reports", () =>
    electron.evaluate(
      () =>
        (Reflect.get(globalThis, "executorE2ELateLoadFailures") as { reported: number } | undefined)
          ?.reported ?? 0,
    ),
  );

export const failDashboardLoads = (
  electron: ElectronApplication,
  origin: string,
  count: number | "all",
) =>
  driver("fail the window's dashboard loads", () =>
    electron.evaluate(
      ({ BrowserWindow, session }, [origin, count]) => {
        const [window] = BrowserWindow.getAllWindows();
        if (window === undefined) throw new Error("The desktop has no window");
        type Control = { remaining: number | "all"; failed: number; links: Set<string> };
        let control = Reflect.get(globalThis, "executorE2EFailedLoads") as Control | undefined;
        if (control === undefined) {
          const created: Control = { remaining: 0, failed: 0, links: new Set() };
          control = created;
          Object.assign(globalThis, { executorE2EFailedLoads: created });
          window.webContents.on("did-start-navigation", (details) => {
            const url = new URL(details.url);
            if (details.isMainFrame && url.origin === origin && url.hash.startsWith("#pair="))
              created.links.add(url.hash);
          });
          session
            .fromPartition("executor-desktop")
            .webRequest.onBeforeRequest({ urls: [`${origin}/*`] }, (details, callback) => {
              const fail =
                details.resourceType === "mainFrame" &&
                (created.remaining === "all" || created.remaining > 0);
              if (fail) {
                if (created.remaining !== "all") created.remaining -= 1;
                created.failed += 1;
              }
              callback({ cancel: fail });
            });
        }
        control.remaining = count;
      },
      [origin, count] as const,
    ),
  );

export const dashboardLoads = (electron: ElectronApplication) =>
  driver("read the window's dashboard loads", () =>
    electron.evaluate(() => {
      const control = Reflect.get(globalThis, "executorE2EFailedLoads") as
        | { failed: number; links: Set<string> }
        | undefined;
      return { failed: control?.failed ?? 0, links: control?.links.size ?? 0 };
    }),
  );

export const clickMenuItem = (electron: ElectronApplication, menu: string, item: string) =>
  driver(`click ${menu} → ${item}`, () =>
    electron.evaluate(
      ({ Menu }, [menu, item]) => {
        const target = Menu.getApplicationMenu()
          ?.items.find((entry) => entry.label === menu || entry.role === menu.toLowerCase())
          ?.submenu?.items.find((entry) => entry.label === item);
        if (target === undefined) throw new Error(`Missing menu item ${menu} → ${item}`);
        target.click();
      },
      [menu, item] as const,
    ),
  );

export const menuPath = (
  electron: ElectronApplication,
  path: ReadonlyArray<string>,
  click: boolean,
) =>
  driver(`${click ? "click" : "read"} ${path.join(" → ")}`, () =>
    electron.evaluate(
      ({ Menu }, [path, click]) => {
        let items = Menu.getApplicationMenu()?.items ?? [];
        let found: Electron.MenuItem | undefined;
        for (const step of path) {
          found = items.find((entry) => entry.label === step);
          if (found === undefined)
            throw new Error(
              `Missing menu item ${step} among ${items.map((entry) => entry.label).join(", ")}`,
            );
          items = found.submenu?.items ?? [];
        }
        if (click) found?.click();
        return items.map((entry) => (entry.type === "separator" ? "-" : entry.label));
      },
      [path, click] as const,
    ),
  );

export const menuBar = (electron: ElectronApplication) =>
  driver("read the application menu", () =>
    electron.evaluate(
      ({ Menu }) =>
        Menu.getApplicationMenu()?.items.map((menu) => ({
          menu: menu.role ?? menu.label,
          items: menu.submenu?.items.map((item) => item.role ?? item.label) ?? [],
        })) ?? [],
    ),
  );

export const menuLabels = (electron: ElectronApplication, menu: string) =>
  driver(`read the ${menu} menu`, () =>
    electron.evaluate(
      ({ Menu }, menu) =>
        Menu.getApplicationMenu()
          ?.items.find((entry) => entry.label === menu || entry.role === menu.toLowerCase())
          ?.submenu?.items.map((entry) => entry.label) ?? [],
      menu,
    ),
  );

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const desktopCli = (options: {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const packaged = yield* Config.String("EXECUTOR_E2E_DESKTOP_EXECUTABLE").pipe(Config.option);
    const sourceCli = ["node", path.resolve("apps/local/server/src/bin.ts")] as const;
    const staged = Effect.gen(function* () {
      const profile = options.env.EXECUTOR_DESKTOP_PROFILE_DIR;
      if (profile === undefined) return yield* Effect.fail(new Error("No desktop profile is set"));
      const staging = path.join(profile, "runtime");
      const names = (yield* fs.readDirectory(staging)).filter(
        (name) => !name.startsWith(".staging-"),
      );
      const [name] = names;
      if (name === undefined || names.length !== 1)
        return yield* Effect.fail(new Error(`Expected one staged runtime in ${staging}`));
      const root = path.join(staging, name);
      return [
        path.join(root, "node", process.platform === "win32" ? "node.exe" : "node"),
        path.join(root, "bin.mjs"),
      ] as const;
    });
    return {
      run: (
        args: ReadonlyArray<string>,
        overrides: Readonly<Record<string, string | undefined>> = {},
        from: { readonly source?: boolean } = {},
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const [command, ...prefix] =
              Option.isNone(packaged) || from.source === true ? sourceCli : yield* staged;
            const env = Object.fromEntries(
              Object.entries({ ...options.env, ...overrides }).flatMap(([name, value]) =>
                value === undefined ? [] : [[name, value] as const],
              ),
            );
            const child = yield* processes.spawn(
              ChildProcess.make(command, [...prefix, ...args], {
                cwd: options.cwd,
                extendEnv: false,
                env,
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
                forceKillAfter: "5 seconds",
              }),
            );
            const [code, stdout, stderr] = yield* Effect.all(
              [
                child.exitCode,
                child.stdout.pipe(Stream.decodeText(), Stream.mkString),
                child.stderr.pipe(Stream.decodeText(), Stream.mkString),
              ],
              { concurrency: 3 },
            ).pipe(Effect.timeout("150 seconds"));
            return { code: Number(code), stdout, stderr } satisfies CliResult;
          }),
        ),
    };
  });

export const watchDesktopShell = (electron: ElectronApplication) =>
  driver("watch menu-bar items and global shortcuts", () =>
    electron.evaluate(({ Tray, globalShortcut }) => {
      type Entry = { tray: Electron.Tray; tooltip: string; menu: Electron.Menu | undefined };
      const record = { trays: [] as Array<Entry>, shortcuts: new Map<string, () => void>() };
      Object.assign(globalThis, { executorE2EShell: record });
      const entry = (tray: Electron.Tray) => {
        const found = record.trays.find((candidate) => candidate.tray === tray);
        if (found !== undefined) return found;
        const created: Entry = { tray, tooltip: "", menu: undefined };
        record.trays.push(created);
        return created;
      };
      const setToolTip = Tray.prototype.setToolTip;
      Tray.prototype.setToolTip = function (this: Electron.Tray, text: string) {
        entry(this).tooltip = text;
        return setToolTip.call(this, text);
      };
      const setContextMenu = Tray.prototype.setContextMenu;
      Tray.prototype.setContextMenu = function (this: Electron.Tray, menu: Electron.Menu | null) {
        entry(this).menu = menu ?? undefined;
        return setContextMenu.call(this, menu);
      };
      Tray.prototype.popUpContextMenu = function (this: Electron.Tray, menu?: Electron.Menu) {
        entry(this).menu = menu;
      };
      const register = globalShortcut.register.bind(globalShortcut);
      globalShortcut.register = (accelerator: Electron.Accelerator, callback: () => void) => {
        const registered = register(accelerator, callback);
        if (registered) record.shortcuts.set(accelerator, callback);
        return registered;
      };
    }),
  );

export const menuBarItems = (electron: ElectronApplication) =>
  driver("read the menu-bar items", () =>
    electron.evaluate(() => {
      const record = Reflect.get(globalThis, "executorE2EShell") as
        | { trays: Array<{ tray: Electron.Tray; tooltip: string }> }
        | undefined;
      return (record?.trays ?? [])
        .filter((entry) => !entry.tray.isDestroyed())
        .map((entry) => entry.tooltip);
    }),
  );

export const clickMenuBarItem = (electron: ElectronApplication, tooltip: string) =>
  driver(`click the ${tooltip} menu-bar item`, () =>
    electron.evaluate((_, tooltip) => {
      const record = Reflect.get(globalThis, "executorE2EShell") as {
        trays: Array<{ tray: Electron.Tray; tooltip: string }>;
      };
      const found = record.trays.find(
        (entry) => !entry.tray.isDestroyed() && entry.tooltip === tooltip,
      );
      if (found === undefined) throw new Error(`No menu-bar item is named ${tooltip}`);
      found.tray.emit("click");
    }, tooltip),
  );

export const menuBarItemMenu = (electron: ElectronApplication, tooltip: string, click?: string) =>
  driver(`open the ${tooltip} menu-bar item's menu`, () =>
    electron.evaluate(
      (_, [tooltip, click]) => {
        const record = Reflect.get(globalThis, "executorE2EShell") as {
          trays: Array<{ tray: Electron.Tray; tooltip: string; menu: Electron.Menu | undefined }>;
        };
        const found = record.trays.find(
          (entry) => !entry.tray.isDestroyed() && entry.tooltip === tooltip,
        );
        if (found === undefined) throw new Error(`No menu-bar item is named ${tooltip}`);
        if (process.platform === "darwin") found.tray.emit("right-click");
        const items = found.menu?.items ?? [];
        if (click !== undefined) {
          const item = items.find((candidate) => candidate.label === click);
          if (item === undefined) throw new Error(`The ${tooltip} menu has no ${click}`);
          item.click();
        }
        return items.map((item) =>
          item.type === "separator"
            ? "-"
            : item.submenu === undefined || item.submenu === null
              ? item.label
              : `${item.label}: ${item.submenu.items
                  .map((entry) =>
                    entry.type === "separator"
                      ? "-"
                      : entry.type === "checkbox"
                        ? `${entry.checked ? "[x]" : "[ ]"} ${entry.label}`
                        : entry.label,
                  )
                  .join(", ")}`,
        );
      },
      [tooltip, click] as const,
    ),
  );

export const pressShortcut = (electron: ElectronApplication, accelerator: string) =>
  driver(`press ${accelerator}`, () =>
    electron.evaluate((_, accelerator) => {
      const record = Reflect.get(globalThis, "executorE2EShell") as {
        shortcuts: Map<string, () => void>;
      };
      const callback = record.shortcuts.get(accelerator);
      if (callback === undefined) throw new Error(`${accelerator} was never registered`);
      callback();
    }, accelerator),
  );

export const systemAudioAvailable = process.platform !== "linux";

export const permissionStates = (states: Readonly<Record<string, string>>) => ({
  menuBar: "prompt",
  shortcuts: "prompt",
  floating: "prompt",
  startAtLogin: "prompt",
  microphone: "prompt",
  camera: "prompt",
  systemAudio: systemAudioAvailable ? "prompt" : "unavailable",
  clipboardRead: "prompt",
  notifications: "prompt",
  ...states,
});

const permissionMenuLabels: ReadonlyArray<readonly [string, string]> = [
  ["menuBar", "Menu bar item"],
  ["shortcuts", "Keyboard shortcuts"],
  ["floating", "Keep above other windows"],
  ["startAtLogin", "Start at login"],
  ["microphone", "Microphone"],
  ["camera", "Camera"],
  ["systemAudio", "System audio"],
  ["clipboardRead", "Read the clipboard"],
  ["notifications", "Notifications"],
];

export const permissionsMenu = (granted: ReadonlyArray<string>) =>
  `Permissions: ${permissionMenuLabels
    .filter(([name]) => name !== "systemAudio" || systemAudioAvailable)
    .map(([name, label]) => `${granted.includes(name) ? "[x]" : "[ ]"} ${label}`)
    .join(", ")}`;
