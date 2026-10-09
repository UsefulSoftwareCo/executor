import { _electron, type ElectronApplication } from "playwright";
import { Config, Console, Effect, Exit, FileSystem, Option, Path, Schedule, Schema } from "effect";
import { driver } from "./platform.ts";

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
    const electron = yield* Effect.acquireRelease(
      driver("launch desktop", () =>
        _electron.launch({
          executablePath: launch.executablePath,
          args: [...launch.args],
          cwd: options.cwd,
          env: { ...options.env },
        }),
      ),
      (electron) => driver("close desktop", () => electron.close()).pipe(Effect.orDie),
    );
    // A failed or timed-out scenario prints the desktop's own record of its backend starts, exits
    // and restarts before the window closes, which shows the step it stopped at.
    const data = options.env.EXECUTOR_DESKTOP_DATA_DIR;
    if (data !== undefined)
      yield* Effect.addFinalizer((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : desktopEvents(data).pipe(
              Effect.flatMap((events) => Console.error(lifecycleLog(events))),
              Effect.ignore,
            ),
      );
    return electron;
  });

/** Messages the desktop writes itself as it starts, stops and restarts its backend. */
const lifecycleMessages = new Set([
  "Starting Executor desktop",
  "Desktop backend started",
  "Desktop backend could not start",
  "Desktop backend ready",
  "Desktop backend exited",
  "Desktop backend stopped",
  "Restarting the desktop backend",
  "Executor desktop ready",
  "Showing desktop recovery",
  "Resetting Executor data",
  "Moved Executor data to a backup",
  "Executor data reset failed",
  "Desktop stopped",
]);

/**
 * The lifecycle events as the desktop's structured fields only. A backend's stderr and the other
 * events' messages, such as the renderer's console, may hold anything a process printed, so they
 * are counted rather than shown.
 */
const lifecycleLog = (events: ReadonlyArray<DesktopEvent>) => {
  const lifecycle = events.filter((event) => lifecycleMessages.has(event.message));
  const lines = lifecycle.map(({ annotations: { stderr, ...annotations }, ...event }) =>
    JSON.stringify({
      ...event,
      annotations: {
        ...annotations,
        ...(stderr === undefined ? {} : { stderrCharacters: stderr.length }),
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
// which backend run it describes and how that run ended.
const LogLine = Schema.fromJsonString(
  Schema.Struct({
    timestamp: Schema.String,
    level: Schema.String,
    message: Schema.String,
    annotations: Schema.Struct({
      run: Schema.optional(Schema.Number),
      pid: Schema.optional(Schema.Number),
      kind: Schema.optional(Schema.String),
      ready: Schema.optional(Schema.Boolean),
      exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
      signal: Schema.optional(Schema.NullOr(Schema.String)),
      configuration: Schema.optional(Schema.String),
      stderr: Schema.optional(Schema.String),
      recovery: Schema.optional(
        Schema.Struct({ stage: Schema.String, reason: Schema.optional(Schema.String) }),
      ),
      backup: Schema.optional(Schema.String),
      delayMillis: Schema.optional(Schema.Number),
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
      const { stderr } = entry.value.annotations;
      // A failed assertion prints this. Redact pairing links as managed-server.ts does.
      return stderr === undefined
        ? [entry.value]
        : [
            {
              ...entry.value,
              annotations: {
                ...entry.value.annotations,
                stderr: stderr.replace(/#pair=[a-f0-9]{64}/g, "#pair=<redacted>"),
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

/** Backend process IDs in start order, from the desktop's own diagnostics log. */
export const backendPids = (directory: string) =>
  desktopEvents(directory).pipe(
    Effect.map((events) =>
      events.flatMap((event) =>
        event.message === "Desktop backend started" && event.annotations.pid !== undefined
          ? [event.annotations.pid]
          : [],
      ),
    ),
  );

/** Wait until the desktop has started a backend after the ones already seen. */
export const nextBackendPid = (directory: string, seen: ReadonlyArray<number>) =>
  backendPids(directory).pipe(
    Effect.flatMap((pids) =>
      pids.length > seen.length
        ? Effect.succeed(pids[pids.length - 1]!)
        : Effect.fail(new Error("The desktop has not started another backend")),
    ),
    // Polled often, so a scenario can end a backend before it reports readiness.
    Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 1200 }),
  );

/**
 * End a backend. SIGKILL is a crash: no shutdown handlers run. SIGTERM is an outside request to
 * stop, except on Windows, where every signal terminates the process at once.
 */
export const killBackend = (pid: number, signal: "SIGKILL" | "SIGTERM" = "SIGKILL") =>
  Effect.sync(() => {
    process.kill(pid, signal);
  });

/**
 * Replace the main process's native message boxes so a scenario can answer them. Each call is
 * recorded; `answers` maps a box title to the chosen button index, otherwise the cancel button.
 */
export const answerDialogs = (
  electron: ElectronApplication,
  answers: Readonly<Record<string, number>>,
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
        return Promise.resolve({
          response: answers[box.title ?? ""] ?? box.cancelId ?? 0,
          checkboxChecked: false,
        });
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
