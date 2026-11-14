import { expect } from "@effect/vitest";
import { _electron, type ElectronApplication } from "playwright";
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

/**
 * What a desktop scenario's own environment keeps of the runner's: its display and session bus,
 * and on Windows the Windows directory, which every Windows process's environment names.
 */
export const runnerSession = () =>
  Object.fromEntries(
    [
      "DISPLAY",
      "XAUTHORITY",
      "WAYLAND_DISPLAY",
      "XDG_RUNTIME_DIR",
      "XDG_SESSION_TYPE",
      "DBUS_SESSION_BUS_ADDRESS",
      "SystemRoot",
    ].flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value] as const];
    }),
  );

/** Request a browser link across Electron's real session boundary, without an API key. */
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

/**
 * Launch the packaged desktop named by EXECUTOR_E2E_DESKTOP_EXECUTABLE, or else this checkout's
 * built development entry (`node apps/local/desktop/scripts/build.mjs`) with its Electron.
 */
export const launchDesktop = (options: {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packaged = yield* Config.String("EXECUTOR_E2E_DESKTOP_EXECUTABLE").pipe(Config.option);
    // Hosted runners have no usable GPU; software rendering avoids repeated GPU startup failures.
    let launch: { readonly executablePath: string; readonly args: ReadonlyArray<string> };
    if (Option.isSome(packaged))
      launch = { executablePath: packaged.value, args: ["--disable-gpu"] };
    else {
      const desktop = path.resolve("apps/local/desktop");
      if (!(yield* fs.exists(path.join(desktop, "dist/main.cjs"))))
        return yield* Effect.fail(
          new Error("Build the desktop entry first: node apps/local/desktop/scripts/build.mjs"),
        );
      const electron = path.join(desktop, "node_modules/electron");
      const binary = (yield* fs.readFileString(path.join(electron, "path.txt"))).trim();
      launch = {
        executablePath: path.join(electron, "dist", binary),
        args: [desktop, "--disable-gpu"],
      };
    }
    const data = options.env.EXECUTOR_DESKTOP_DATA_DIR;
    // A quit that does not end the desktop fails the scenario with what it was doing (see
    // `closeDesktop`), instead of hanging until the test limit.
    const electron = yield* Effect.acquireRelease(
      driver("launch desktop", () =>
        _electron.launch({
          executablePath: launch.executablePath,
          args: [...launch.args],
          cwd: options.cwd,
          env: { ...options.env },
        }),
      ).pipe(Effect.map((electron) => ({ electron, output: captureOutput(electron) }))),
      ({ electron, output }) =>
        closeDesktop(electron, { ...(data === undefined ? {} : { data }), output }).pipe(
          Effect.orDie,
        ),
    ).pipe(Effect.map(({ electron }) => electron));
    // A failed or timed-out scenario, as one whose dashboard never shows, prints the desktop's
    // own record of its connections, losses and recoveries before the window closes, which shows
    // the step it stopped at, and keeps what its windows show and its logs (see `keepEvidence`).
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

/**
 * Keep a failed scenario's evidence, which would go with its directory: a screenshot of each
 * desktop window, and the desktop's and its servers' logs from `data`, in a new folder under
 * EXECUTOR_E2E_DESKTOP_SCREENSHOTS (by default `.local/desktop-recovery`), which it names, with a
 * `scenario.json` naming the scenario (`e2e/release-evidence.ts` reads it).
 */
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
    // Which scenario failed, so the release workflow's evidence step files the folder under it.
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

/** Messages the desktop writes itself as it connects to, loses and recovers its server. */
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

/**
 * The lifecycle events as the desktop's structured fields only. What a server said and the other
 * events' messages, such as the renderer's console, may hold anything a process printed, so they
 * are counted rather than shown.
 */
const lifecycleLog = (events: ReadonlyArray<DesktopEvent>) => {
  const lifecycle = events.filter((event) => lifecycleMessages.has(event.message));
  const lines = lifecycle.map(({ annotations: { detail, error, ...annotations }, ...event }) =>
    JSON.stringify({
      ...event,
      annotations: {
        ...annotations,
        ...(detail === undefined ? {} : { detailCharacters: detail.length }),
        // An uncaught exception's first line names it; its stack stays in the kept logs.
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

// A failed assertion prints the whole event, so keep what tells runs apart: when it was logged,
// which server it names and how the desktop lost or recovered it.
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
      /** What a move changed of the CLI's settings: names only. */
      settings: Schema.optional(
        Schema.Struct({
          port: Schema.optional(Schema.Struct({ from: Schema.Number, to: Schema.Number })),
          variables: Schema.optional(Schema.Array(Schema.String)),
          removed: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
      failure: Schema.optional(Schema.String),
      attempt: Schema.optional(Schema.Number),
      /** How the desktop quit: why, which finalizers ran, for how long and how it ended. */
      reason: Schema.optional(Schema.String),
      closing: Schema.optional(Schema.String),
      seconds: Schema.optional(Schema.Number),
      outcome: Schema.optional(Schema.String),
      resources: Schema.optional(Schema.Array(Schema.String)),
      /** An uncaught exception the desktop recorded, as it described the thrown value. */
      error: Schema.optional(Schema.String),
    }),
  }),
);
export type DesktopEvent = typeof LogLine.Type;

/** The desktop's own diagnostics log, oldest first. Unreadable lines are not events. */
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
      // A failed assertion prints this. Redact pairing links as managed-server.ts does.
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

/** Wait until the log has `count` events with `message`, and return those events. */
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

/** How many times the desktop has started a background server for its data directory. */
export const serverStarts = (directory: string) =>
  desktopEvents(directory).pipe(
    Effect.map(
      (events) =>
        events.filter((event) => event.message === "Starting the background Executor").length,
    ),
  );

const RegistrationJson = Schema.fromJsonString(ServiceRegistration);

/** The server `server.json` names for `directory`, if any. */
export const registeredServer = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(directory, "server.json");
    if (!(yield* fs.exists(file))) return Option.none<ServiceRegistration>();
    return yield* fs.readFileString(file).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RegistrationJson)),
      // A server replacing the file between the check and the read is no registration yet.
      Effect.option,
    );
  });

/** Whether `server` answers on its address as that process, ready to serve every route. */
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

/**
 * The PowerShell program behind `windowsSuspender`. It reads one command per line and answers each
 * with one line, or with `error <message>`.
 */
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

/**
 * Suspend processes on Windows, where Node cannot stop one, as a debugger does: one PowerShell
 * process suspends each with NtSuspendProcess, so starting PowerShell, which takes seconds, happens
 * once. It takes `suspend <pid>`; `stall <pid>`, which waits for the server starter of the desktop
 * `<pid>` started to start an attempt and suspends both, as `stallStarter` does on POSIX; and
 * `resume`, which resumes every process it suspended. It keeps each suspended process's handle, so
 * an ID cannot name another process before it is resumed, and resumes them all when its input ends
 * with the caller's scope.
 */
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
  // Ending its input resumes what it suspended before it exits.
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

/**
 * Suspend `pid`, as a hung process stops, until `resume` or until the caller's scope closes. POSIX
 * stops it with SIGSTOP; Windows suspends it (see `windowsSuspender`).
 */
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

/**
 * Make the desktop's server starter, an Electron utility process, stop answering as soon as it has
 * spawned its first start attempt, before that attempt can serve: both are stopped, as hung
 * processes, until `resume` or until the caller's scope closes. On POSIX `ps` finds them among the
 * desktop's descendants and SIGSTOP stops them. On Windows Playwright starts Electron through
 * `cmd.exe`, so the desktop's main process is a child of the process Playwright reports; there the
 * PowerShell suspender looks for them, since starting PowerShell for each look would be too slow,
 * and suspends them. Ending the starter instead would not do on Windows: Electron notices that
 * within a second, although the attempt it started holds the starter's channel.
 */
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
          // The starter is one of the desktop's descendants; its attempt is its own child.
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

/** Signal 0 checks that a process exists; EPERM means it exists under another user. */
export const processAlive = (pid: number) =>
  Effect.try({
    try: () => process.kill(pid, 0),
    catch: (error) => Schema.is(Schema.Struct({ code: Schema.Literal("EPERM") }))(error),
  }).pipe(Effect.match({ onSuccess: () => true, onFailure: (exists) => exists }));

/**
 * Wait until `directory`'s registered server is a server other than those in `seen` and answers
 * ready, and return it. A desktop or CLI that starts one detaches it, so it is found by its file.
 * Servers are told apart by the id each registers: Windows soon gives a new server the pid of one
 * that has exited.
 */
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
    // Say when the new server has an earlier one's pid, so a passing run shows the reuse it met.
    Effect.tap((server) => {
      const earlier = seen.find((other) => other.pid === server.pid);
      return earlier === undefined
        ? Effect.void
        : Effect.logInfo(
            `Server ${server.id} has process ID ${server.pid}, which earlier server ${earlier.id} had`,
          );
    }),
    // It just answered as itself, so its pid names it: record when it started, for `serverExited`.
    Effect.tap((server) =>
      process.platform === "win32"
        ? windowsStartTime(server.pid).pipe(
            Effect.map(Option.map((start) => windowsStarts.set(server.id, start))),
          )
        : Effect.void,
    ),
  );

/** On Windows, when each server `nextServer` returned started, by its id. */
const windowsStarts = new Map<string, string>();

/**
 * Whether `server`, one `nextServer` returned, has exited: its pid names no process or, on Windows,
 * names a process that started after it did. Windows soon gives a freed pid to the next server.
 * When the start time cannot be read, only the pid naming no process counts as exited.
 */
export const serverExited = (server: ServiceRegistration) =>
  Effect.gen(function* () {
    if (!(yield* processAlive(server.pid))) return true;
    const start = windowsStarts.get(server.id);
    if (process.platform !== "win32" || start === undefined) return false;
    // A start time that cannot be read is no proof of another process: the pid's liveness decides.
    const now = yield* windowsStartTime(server.pid);
    if (Option.isNone(now)) return !(yield* processAlive(server.pid));
    return now.value !== start;
  });

/**
 * Stop every background server this scenario's desktop or CLI left for `directory`: the one
 * `server.json` names, and any in `seen`, while it still answers as itself. A server outlives the
 * desktop that started it, so a scenario's scope ends it before its directory is removed. One that
 * does not answer as itself is left alone, as `executor service stop` leaves it: its pid, as after
 * a crash, may name another program by now, and the directory goes with the scope.
 */
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
      // It proved itself just before, so a pid still running is still that server.
      if (!(yield* exited(server.pid))) yield* crashServer(server.pid);
    }
  }).pipe(Effect.ignore);

/**
 * Replace the main process's native message boxes so a scenario can answer them. Each call is
 * recorded; `answers` maps a box title to the chosen button index, or to `unanswered` for a box
 * that is never answered, as one a person leaves open; otherwise the cancel button.
 */
export const answerDialogs = (
  electron: ElectronApplication,
  answers: Readonly<Record<string, number | "unanswered">>,
) =>
  driver("answer native dialogs", () =>
    electron.evaluate(({ dialog }, answers) => {
      const record: Array<{ title: string; message: string; detail: string }> = [];
      Object.assign(globalThis, { executorE2EDialogs: record });
      const answer = (...args: ReadonlyArray<unknown>) => {
        const box = args[args.length - 1] as {
          readonly title?: string;
          readonly message: string;
          readonly detail?: string;
          readonly cancelId?: number;
        };
        record.push({ title: box.title ?? "", message: box.message, detail: box.detail ?? "" });
        const chosen = answers[box.title ?? ""];
        if (chosen === "unanswered") return new Promise<never>(() => undefined);
        return Promise.resolve({ response: chosen ?? box.cancelId ?? 0, checkboxChecked: false });
      };
      Object.assign(dialog, { showMessageBox: answer });
    }, answers),
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

/**
 * Report a replaced document's failed load after the desktop's own page has committed, as
 * Windows does when the dashboard is still loading as its server exits: `did-fail-load` with the
 * dashboard's URL arrives between the startup page's `did-navigate` and `did-stop-loading`.
 * `lateLoadFailures` counts the reports.
 */
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

/**
 * Make the window's next `count` main-frame loads of `origin` fail, as Electron reports a load
 * that never reached the server, or every one with `all`; `0` lets them through again. It also
 * starts recording the one-use pairing links the window loads, which `dashboardLoads` counts.
 */
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

/**
 * Since `failDashboardLoads` first ran: how many dashboard loads it failed, and how many distinct
 * pairing links the window loaded. The links themselves stay in the desktop.
 */
export const dashboardLoads = (electron: ElectronApplication) =>
  driver("read the window's dashboard loads", () =>
    electron.evaluate(() => {
      const control = Reflect.get(globalThis, "executorE2EFailedLoads") as
        | { failed: number; links: Set<string> }
        | undefined;
      return { failed: control?.failed ?? 0, links: control?.links.size ?? 0 };
    }),
  );

/** Click an application menu item as the user would. */
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

/**
 * The application menu bar: each menu by its role, or by its label when it has none, with its
 * items named the same way. Electron lowercases roles.
 */
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

/** The labels in one application menu. */
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

/**
 * The local CLI on a data directory, with a desktop scenario's environment. A packaged desktop's
 * CLI is the runtime it staged under its profile, which reports the desktop's own version, so it
 * can start a server the desktop joins; it exists once the desktop has launched. Otherwise, or
 * with `source`, this checkout's CLI runs from source, as the development desktop runs it.
 */
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
