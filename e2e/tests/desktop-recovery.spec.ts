import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, Fiber, FileSystem, Layer, Path, Schedule, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import type { ElectronApplication, Page } from "playwright";
import { randomBytes, randomUUID } from "node:crypto";
import { driver } from "../support/platform.ts";
import { localNpmRegistry } from "../support/npm-registry.ts";
import { freePort } from "../support/ports.ts";
import {
  answerDialogs,
  answeredDialogs,
  backendPids,
  desktopEvents,
  eventsNamed,
  clickMenuItem,
  killBackend,
  lateLoadFailures,
  launchDesktop,
  menuLabels,
  nextBackendPid,
  reportReplacedLoadFailuresLate,
} from "../support/desktop.ts";
import { scenarios } from "../test-plan.ts";

const Installation = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  state: Schema.Literals(["pending", "ready", "external", "file"]),
});
const Keys = Schema.Struct({ apiKey: Schema.String, encryptionKey: Schema.String });
/**
 * The manifest of a directory whose keys are in its own `keys.json`: they move with the backup,
 * so it names no OS credential, and it must never contain a key.
 */
const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  appVersion: Schema.String,
  createdAt: Schema.String,
  source: Schema.String,
  installation: Schema.Struct({ id: Schema.String, keySource: Schema.Literal("key-file") }),
});

/**
 * An isolated desktop profile and data directory whose key setup never touches a real OS
 * credential. `supplied` gives the server synthetic keys. `file` sets EXECUTOR_KEY_STORAGE=file,
 * so keys live only in the directory's `keys.json`. `unreachable-store` supplies none and points
 * the OS credential store somewhere it cannot be used: an empty home has no macOS default
 * keychain, which refuses access, and a missing bus has no Linux Secret Service, which is absent.
 * Windows Credential Manager cannot be made unusable for one process.
 */
const desktopHome = (keys: "supplied" | "file" | "unreachable-store" = "supplied") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "executor-desktop-recovery-" });
    const runtimePath = yield* Config.String("EXECUTOR_E2E_RUNTIME_PATH").pipe(
      Config.withDefault(process.env.PATH ?? ""),
    );
    const port = yield* freePort;
    // The server deploys the bundled Executor app, which pins this checkout's apps release.
    const registry = yield* localNpmRegistry;
    const data = path.join(home, "data");
    const display = Object.fromEntries(
      [
        "DISPLAY",
        "XAUTHORITY",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
        "XDG_SESSION_TYPE",
        "DBUS_SESSION_BUS_ADDRESS",
      ].flatMap((name) => {
        const value = process.env[name];
        return value === undefined ? [] : [[name, value] as const];
      }),
    );
    const common = {
      ...display,
      // Release scenarios never send product analytics, even from a build with a baked key.
      DO_NOT_TRACK: "1",
      PATH: runtimePath,
      EXECUTOR_PORT: String(port),
      EXECUTOR_DESKTOP_DATA_DIR: data,
      EXECUTOR_DESKTOP_PROFILE_DIR: path.join(home, "profile"),
      EXECUTOR_NPM_REGISTRY: registry.url,
    };
    const env: Record<string, string> = { ...common, HOME: process.env.HOME ?? "" };
    if (keys === "supplied") {
      env.EXECUTOR_API_KEY = randomBytes(32).toString("hex");
      env.EXECUTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    } else if (keys === "file") env.EXECUTOR_KEY_STORAGE = "file";
    else {
      env.HOME = home;
      env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(home, "no-bus")}`;
    }
    return { home, data, env, origin: `http://127.0.0.1:${port}` };
  });

const screenshot = (page: Page, name: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const directory = yield* Config.String("EXECUTOR_E2E_DESKTOP_SCREENSHOTS").pipe(
      Config.withDefault(".local/desktop-recovery"),
    );
    yield* driver(`capture ${name}`, () =>
      page.screenshot({ path: path.resolve(directory, `${name}.png`) }),
    );
  });

/** Wait until at least `count` native message boxes have been answered, and return them. */
const dialogsShown = (electron: ElectronApplication, count: number) =>
  answeredDialogs(electron).pipe(
    Effect.flatMap((boxes) =>
      boxes !== undefined && boxes.length >= count
        ? Effect.succeed(boxes)
        : Effect.fail(new Error(`Fewer than ${count} native dialogs have been shown`)),
    ),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
  );

const recoveryHeading = (page: Page, name: string) =>
  driver(`recovery: ${name}`, () =>
    page.getByRole("heading", { name, exact: true }).waitFor({ state: "visible", timeout: 60_000 }),
  );

const dashboard = (page: Page) =>
  driver("dashboard is visible", () =>
    page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible", timeout: 60_000 }),
  );

const services = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);

const exited = "Desktop backend exited";
const restarting = "Restarting the desktop backend";

it.live(scenarios.desktopCrashRecovery.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { home, data, env, origin } = yield* desktopHome();
      const electron = yield* launchDesktop({ cwd: home, env });
      const page = yield* driver("desktop window", () => electron.firstWindow());
      yield* dashboard(page);
      expect(new URL(page.url()).origin).toBe(origin);

      // An outside request to stop is not a crash, but the server is still gone: it restarts.
      const [first] = yield* backendPids(data);
      expect(first).toBeTypeOf("number");
      yield* killBackend(first!, "SIGTERM");
      const second = yield* nextBackendPid(data, [first!]);
      const [stopped] = yield* eventsNamed(data, exited, 1);
      expect(stopped?.annotations).toMatchObject({
        kind: process.platform === "win32" ? "crash" : "external-shutdown",
        ready: true,
      });

      // A crash before readiness doubles the restart delay.
      yield* killBackend(second, "SIGKILL");
      const third = yield* nextBackendPid(data, [first!, second]);
      const early = (yield* eventsNamed(data, exited, 2))[1];
      expect(early?.annotations).toMatchObject({ kind: "crash", ready: false });
      expect(
        (yield* eventsNamed(data, restarting, 2)).map((event) => event.annotations.delayMillis),
      ).toEqual([500, 1_000]);

      // The restarted server accepts the window's new one-use pairing.
      yield* dashboard(page);
      const session = yield* driver("the restarted server accepts the window's pairing", () =>
        page.evaluate(() =>
          fetch("/auth/session", { credentials: "include" }).then((response) => response.json()),
        ),
      );
      expect(session).toEqual({ authenticated: true });

      // Three unexpected exits within a minute stop restarts and show recovery.
      yield* killBackend(third);
      yield* driver("crash-loop recovery", () =>
        page
          .getByRole("heading", { name: "Executor keeps stopping", exact: true })
          .waitFor({ state: "visible", timeout: 30_000 }),
      );
      yield* screenshot(page, "recovery-crash-loop");
      const actions = yield* driver("recovery actions", () =>
        page.getByRole("button").allTextContents(),
      );
      expect(actions).toEqual(["Restart", "Show logs", "Reset data…", "Quit"]);
      expect(yield* backendPids(data)).toHaveLength(3);
      expect(yield* eventsNamed(data, restarting, 2)).toHaveLength(2);

      // Restart from the recovery page starts supervision afresh.
      yield* driver("restart from recovery", () =>
        page.getByRole("button", { name: "Restart", exact: true }).click(),
      );
      const fourth = yield* nextBackendPid(data, [first!, second, third]);
      yield* killBackend(fourth);
      const fifth = yield* nextBackendPid(data, [first!, second, third, fourth]);
      expect((yield* eventsNamed(data, exited, 4))[3]?.annotations.ready).toBe(false);
      // Readiness resets the delay: this exit waits the first delay again, not a doubled one.
      yield* dashboard(page);
      yield* killBackend(fifth);
      yield* nextBackendPid(data, [first!, second, third, fourth, fifth]);
      expect((yield* eventsNamed(data, exited, 5))[4]?.annotations.ready).toBe(true);
      expect(
        (yield* eventsNamed(data, restarting, 4)).map((event) => event.annotations.delayMillis),
      ).toEqual([500, 1_000, 500, 500]);
      yield* dashboard(page);
      expect(yield* backendPids(data)).toHaveLength(6);
    }),
  ).pipe(Effect.provide(services)),
);

it.live(scenarios.desktopLateLoadFailure.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { home, data, env } = yield* desktopHome();
      const electron = yield* launchDesktop({ cwd: home, env });
      const page = yield* driver("desktop window", () => electron.firstWindow());
      yield* dashboard(page);
      yield* reportReplacedLoadFailuresLate(electron);

      // The server exits, so the window shows the startup page, and then hears that the dashboard
      // it replaced failed to load. The startup page shows only until the restarted server is
      // ready, so the wait for it starts on the dashboard. It reads from the window: a desktop
      // stopped behind its error box answers no main-process call.
      const startupPage = yield* driver("the window shows the startup page", () =>
        page.waitForURL((url) => url.protocol === "data:", { timeout: 30_000 }),
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      const [first] = yield* backendPids(data);
      yield* killBackend(first!);
      yield* nextBackendPid(data, [first!]);
      yield* Fiber.join(startupPage);

      // That failure was the dashboard's, not the startup page's: the desktop keeps its window
      // and opens the restarted server's dashboard.
      yield* dashboard(page);
      expect(yield* lateLoadFailures(electron)).toBe(1);
      expect(yield* eventsNamed(data, "Desktop backend ready", 2)).toHaveLength(2);
      expect((yield* desktopEvents(data)).map((event) => event.message)).not.toContain(
        "Desktop stopped",
      );
    }),
  ).pipe(Effect.provide(services)),
);

it.live(scenarios.desktopClipboard.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { home, env, origin } = yield* desktopHome();
      const electron = yield* launchDesktop({ cwd: home, env });
      const page = yield* driver("desktop window", () => electron.firstWindow());
      yield* dashboard(page);
      yield* driver("open the custom app page", () => page.goto(`${origin}/apps/add/custom`));
      const copy = page.getByRole("button", { name: "Copy setup prompt" });
      yield* driver("copy the setup prompt", () => copy.click());
      yield* driver("the copy succeeds", () =>
        copy.getByText("Copied", { exact: true }).waitFor({ state: "visible" }),
      );
      const copied = yield* driver("read the system clipboard", () =>
        electron.evaluate(({ clipboard }) => clipboard.readText()),
      );
      expect(copied).toContain("Help me add a service to Executor as an app.");
    }),
  ).pipe(Effect.provide(services)),
);

it.live(scenarios.desktopReset.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, data, env } = yield* desktopHome("file");
      const backups = path.join(home, "backups");
      // Data whose key file is gone: key setup refuses, and starting over can help.
      const original = randomUUID();
      yield* fs.makeDirectory(data, { recursive: true });
      yield* fs.writeFileString(
        path.join(data, "installation.json"),
        JSON.stringify({ version: 1, id: original, state: "file" }),
      );
      yield* fs.writeFileString(path.join(data, "retained.txt"), "synthetic retained data");
      const electron = yield* launchDesktop({ cwd: home, env });
      const page = yield* driver("desktop window", () => electron.firstWindow());
      yield* recoveryHeading(page, "Executor's saved key is missing");
      yield* screenshot(page, "recovery-configuration");
      expect(
        yield* driver("recovery actions", () => page.getByRole("button").allTextContents()),
      ).toEqual(["Restart", "Show logs", "Reset data…", "Quit"]);
      // A configuration failure is not retried: one backend only.
      const started = yield* backendPids(data);
      expect(started).toHaveLength(1);

      expect(yield* menuLabels(electron, "Help")).toEqual([
        "Show diagnostics folder",
        "Export diagnostics…",
        "",
        "Reset Executor data…",
      ]);

      // Cancel leaves everything in place.
      yield* answerDialogs(electron, {});
      yield* clickMenuItem(electron, "Help", "Reset Executor data…");
      const cancelled = yield* dialogsShown(electron, 1);
      expect(cancelled.map((box) => box.title)).toEqual(["Reset Executor data?"]);
      expect(yield* fs.exists(backups)).toBe(false);
      expect(yield* fs.readFileString(path.join(data, "retained.txt"))).toBe(
        "synthetic retained data",
      );

      // A move that fails leaves the data and its lock state in place and restarts the server.
      // POSIX refuses a rename into a read-only directory; Windows ignores that, so there the
      // backups folder cannot be created at all.
      if (process.platform === "win32") yield* fs.writeFileString(backups, "");
      else yield* fs.makeDirectory(backups, { mode: 0o500 });
      yield* answerDialogs(electron, { "Reset Executor data?": 0 });
      yield* driver("failed reset from recovery", () =>
        page.getByRole("button", { name: "Reset data…", exact: true }).click(),
      );
      const failure = yield* dialogsShown(electron, 2);
      expect(failure.map((box) => box.title)).toEqual(["Reset Executor data?", "Reset failed"]);
      expect(failure[1]?.message).toBe(
        "Executor could not reset its data. Your data was left in place.",
      );
      yield* nextBackendPid(data, started);
      yield* recoveryHeading(page, "Executor's saved key is missing");
      expect(yield* fs.readFileString(path.join(data, "retained.txt"))).toBe(
        "synthetic retained data",
      );
      expect(
        yield* fs
          .readFileString(path.join(data, "installation.json"))
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Installation)))),
      ).toEqual({ version: 1, id: original, state: "file" });
      expect(yield* fs.exists(path.join(data, ".bootstrap.lock"))).toBe(false);
      if (process.platform === "win32") {
        yield* fs.remove(backups);
      } else {
        expect(yield* fs.readDirectory(backups)).toEqual([]);
        yield* fs.chmod(backups, 0o700);
      }

      // Confirming from the recovery page moves the data aside and starts fresh.
      yield* answerDialogs(electron, { "Reset Executor data?": 0 });
      yield* driver("reset from recovery", () =>
        page.getByRole("button", { name: "Reset data…", exact: true }).click(),
      );
      const dialogs = yield* dialogsShown(electron, 2);
      yield* dashboard(page);
      expect(dialogs.map((box) => box.title)).toEqual([
        "Reset Executor data?",
        "Executor data reset",
      ]);

      const moved = yield* fs.readDirectory(backups);
      expect(moved).toHaveLength(1);
      expect(moved[0]).toMatch(/^data-\d{8}T\d{6}Z-[0-9a-f]{6}$/);
      const backup = path.join(backups, moved[0]!);
      expect(dialogs[1]?.detail).toContain(backup);
      expect(yield* fs.readFileString(path.join(backup, "retained.txt"))).toBe(
        "synthetic retained data",
      );
      expect(yield* fs.exists(path.join(backup, ".bootstrap.lock"))).toBe(false);
      const manifestText = yield* fs.readFileString(path.join(backup, "executor-backup.json"));
      const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(
        manifestText,
      );
      expect(manifest.source).toBe(data);
      expect(manifest.installation.id).toBe(original);
      expect(manifestText).not.toContain("credential");
      const backedUp = yield* fs
        .readFileString(path.join(backup, "installation.json"))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Installation))));
      expect(backedUp).toEqual({ version: 1, id: original, state: "file" });

      const fresh = yield* fs
        .readFileString(path.join(data, "installation.json"))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Installation))));
      expect(fresh.id).not.toBe(original);
      expect(fresh.state).toBe("file");
      const readKeys = (directory: string) =>
        fs
          .readFileString(path.join(directory, "keys.json"))
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Keys))));
      const freshKeys = yield* readKeys(data);
      expect(yield* fs.exists(path.join(data, "retained.txt"))).toBe(false);

      // Resetting a running server stops it on purpose: that stop is never reported as an exit.
      yield* answerDialogs(electron, { "Reset Executor data?": 0 });
      yield* clickMenuItem(electron, "Help", "Reset Executor data…");
      const again = yield* dialogsShown(electron, 2);
      expect(again.map((box) => box.title)).toEqual([
        "Reset Executor data?",
        "Executor data reset",
      ]);
      yield* dashboard(page);
      const second = (yield* fs.readDirectory(backups)).find((name) => name !== moved[0]);
      expect(second).toBeDefined();
      expect(again[1]?.detail).toContain(path.join(backups, second!));
      // The running directory's key file moved with it, and its manifest names no key.
      const secondBackup = path.join(backups, second!);
      expect(yield* readKeys(secondBackup)).toEqual(freshKeys);
      const secondManifest = yield* fs.readFileString(
        path.join(secondBackup, "executor-backup.json"),
      );
      expect(
        (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(secondManifest))
          .installation.id,
      ).toBe(fresh.id);
      expect(secondManifest).not.toContain(freshKeys.apiKey);
      expect(secondManifest).not.toContain(freshKeys.encryptionKey);
      const stoppedRun = yield* desktopEvents(secondBackup);
      expect(stoppedRun.map((event) => event.message)).toContain("Desktop backend started");
      expect(
        [...stoppedRun, ...(yield* desktopEvents(data))].filter(
          (event) =>
            event.message === "Desktop backend exited" ||
            event.message === "Showing desktop recovery",
        ),
      ).toEqual([]);
      // Lines logged before a move go with it: the first backup holds both reset attempts.
      expect(
        (yield* desktopEvents(backup)).filter(
          (event) => event.message === "Resetting Executor data",
        ),
      ).toHaveLength(2);
    }),
  ).pipe(Effect.provide(services)),
);

it.live(scenarios.desktopResetWithheld.title, () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const noReset = ["Restart", "Show logs", "Quit"];

    // Another process holds the bootstrap lock. Its future timestamp keeps it from going stale.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { home, data, env } = yield* desktopHome();
        const held = path.join(data, ".bootstrap.lock");
        yield* fs.makeDirectory(held, { recursive: true });
        const later = new Date(Date.now() + 60 * 60 * 1000);
        yield* fs.utimes(held, later, later);
        const electron = yield* launchDesktop({ cwd: home, env });
        const page = yield* driver("desktop window", () => electron.firstWindow());
        yield* recoveryHeading(page, "Executor's data is in use");
        expect(
          yield* driver("recovery actions", () => page.getByRole("button").allTextContents()),
        ).toEqual(noReset);
      }),
    );

    /** Start on a directory whose record says `state`, and expect `heading` without reset. */
    const withheld = (options: {
      readonly heading: string;
      readonly keys: "supplied" | "file" | "unreachable-store";
      readonly state: "ready" | "file";
      readonly env?: Readonly<Record<string, string>>;
      readonly screenshot?: string;
    }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { home, data, env } = yield* desktopHome(options.keys);
          yield* fs.makeDirectory(data, { recursive: true });
          const record = JSON.stringify({ version: 1, id: randomUUID(), state: options.state });
          yield* fs.writeFileString(path.join(data, "installation.json"), record);
          const electron = yield* launchDesktop({ cwd: home, env: { ...env, ...options.env } });
          const page = yield* driver("desktop window", () => electron.firstWindow());
          yield* recoveryHeading(page, options.heading);
          if (options.screenshot !== undefined) yield* screenshot(page, options.screenshot);
          expect(
            yield* driver("recovery actions", () => page.getByRole("button").allTextContents()),
          ).toEqual(noReset);
          // A configuration failure is not retried, and nothing was changed or written.
          expect(yield* backendPids(data)).toHaveLength(1);
          expect(yield* fs.readFileString(path.join(data, "installation.json"))).toBe(record);
          expect(yield* fs.exists(path.join(data, "keys.json"))).toBe(false);
        }),
      );

    // Key settings that cannot apply to existing data must be changed, not reset away:
    // supplied keys on a directory that saves its own, and a key storage it does not use.
    yield* withheld({
      heading: "Executor's key settings do not match its data",
      keys: "supplied",
      state: "ready",
      screenshot: "recovery-misconfigured",
    });
    yield* withheld({
      heading: "Executor's key settings do not match its data",
      keys: "file",
      state: "ready",
    });

    // The data may be intact behind a store that is absent or refuses access, so it is never
    // offered for reset. The harness makes the store absent on Linux and refusing on macOS.
    if (process.platform === "win32") return;
    yield* withheld(
      process.platform === "darwin"
        ? {
            heading: "Executor needs access to your keychain",
            keys: "unreachable-store",
            state: "ready",
            screenshot: "recovery-credential-denied",
          }
        : {
            heading: "Executor cannot open the OS credential store",
            keys: "unreachable-store",
            state: "ready",
            screenshot: "recovery-credential-unavailable",
          },
    );
  }).pipe(Effect.provide(services)),
);
