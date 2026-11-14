import { expect, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, Fiber, FileSystem, Layer, Option, Path, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import type { ElectronApplication, Page } from "playwright";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { driver } from "../support/platform.ts";
import { localNpmRegistry } from "../support/npm-registry.ts";
import { connectionRefused, freePort } from "../support/ports.ts";
import {
  answerDialogs,
  answeredDialogs,
  answersReady,
  clickMenuItem,
  dashboardLoads,
  desktopCli,
  desktopEvents,
  eventsNamed,
  failDashboardLoads,
  lateLoadFailures,
  launchDesktop,
  menuBar,
  menuLabels,
  nextServer,
  processAlive,
  registeredServer,
  reportReplacedLoadFailuresLate,
  runnerSession,
  serverExited,
  serverStarts,
  stallStarter,
  stopBackgroundServers,
  suspendProcess,
} from "../support/desktop.ts";
import {
  crashServer,
  type ServiceRegistration,
  stoppingServer,
} from "../support/background-service.ts";
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
 *
 * The desktop starts its background server detached, and it outlives the desktop, so the scope
 * stops every server the scenario left for the data directory, or for `legacy`, the directory an
 * older desktop kept its data in. `port: false` leaves EXECUTOR_PORT unset for the desktop, so
 * `service.json` chooses its server's port.
 *
 * The OS per-user cache directory is inside the scenario's directory too: the server keeps its
 * compile cache there, and a packaged desktop's updater downloads updates into it
 * (`%LOCALAPPDATA%`, `~/Library/Caches` or `$XDG_CACHE_HOME`).
 */
const desktopHome = (
  options: {
    readonly keys?: "supplied" | "file" | "unreachable-store";
    readonly port?: boolean;
    readonly legacy?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const keys = options.keys ?? "supplied";
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "executor-desktop-recovery-" });
    const runtimePath = yield* Config.String("EXECUTOR_E2E_RUNTIME_PATH").pipe(
      Config.withDefault(process.env.PATH ?? ""),
    );
    const port = yield* freePort;
    // The server deploys the bundled Executor app, which pins this checkout's apps release.
    const registry = yield* localNpmRegistry;
    const data = path.join(home, "data");
    const legacy = path.join(home, "legacy");
    const cacheHome = path.join(home, "cache-home");
    const common = {
      ...runnerSession(),
      // Release scenarios never send product analytics, even from a build with a baked key.
      DO_NOT_TRACK: "1",
      EXECUTOR_NO_UPDATE_CHECK: "1",
      PATH: runtimePath,
      ...(process.platform === "win32"
        ? { LOCALAPPDATA: cacheHome }
        : process.platform === "darwin"
          ? {}
          : { XDG_CACHE_HOME: cacheHome }),
      ...(options.port === false ? {} : { EXECUTOR_PORT: String(port) }),
      EXECUTOR_DESKTOP_DATA_DIR: data,
      ...(options.legacy === true ? { EXECUTOR_DESKTOP_LEGACY_DATA_DIR: legacy } : {}),
      EXECUTOR_DESKTOP_PROFILE_DIR: path.join(home, "profile"),
      EXECUTOR_NPM_REGISTRY: registry.url,
    };
    // macOS has no variable for its cache directory, only the home it is in.
    const env: Record<string, string> = {
      ...common,
      HOME: process.platform === "darwin" ? cacheHome : (process.env.HOME ?? ""),
    };
    if (keys === "supplied") {
      env.EXECUTOR_API_KEY = randomBytes(32).toString("hex");
      env.EXECUTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    } else if (keys === "file") env.EXECUTOR_KEY_STORAGE = "file";
    else {
      env.HOME = home;
      env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(home, "no-bus")}`;
    }
    const seen: Array<ServiceRegistration> = [];
    yield* Effect.addFinalizer(() =>
      Effect.forEach([data, legacy], (directory) => stopBackgroundServers(directory, () => seen)),
    );
    // The CLI on the same data directory as the desktop.
    const cli = yield* desktopCli({ env: { ...env, EXECUTOR_DATA_DIR: data }, cwd: home });
    return {
      home,
      data,
      legacy,
      env,
      port,
      origin: `http://127.0.0.1:${port}`,
      cli,
      /** Wait for a server for `directory` other than `servers`; it is stopped with the scope. */
      nextServer: (servers: ReadonlyArray<ServiceRegistration>, directory = data) =>
        nextServer(directory, servers).pipe(
          Effect.tap((server) => Effect.sync(() => seen.push(server))),
        ),
    };
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

/** The window's session is paired with the server it shows. */
const pairedSession = (page: Page) =>
  driver("the window's session is paired", () =>
    page.evaluate(() =>
      fetch("/auth/session", { credentials: "include" }).then((response) => response.json()),
    ),
  );

/** `executor service status` for a running server. */
const statusLine = (server: ServiceRegistration) =>
  `${server.url} (version ${server.version}, process ${server.pid})`;

const services = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);

/** What the CLI says on stderr when it starts a background server. */
const startingInCli = "Starting background Executor";
const Apps = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String })),
);

const lostServer = "Background Executor stopped answering";
const dashboardFailed = "Desktop window could not load the dashboard";
const waitingForServer = "Waiting for the background Executor to start again";

it.live(scenarios.desktopCrashRecovery.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { data, home, env, origin, cli, nextServer } = yield* desktopHome();
      const electron = yield* launchDesktop({ cwd: home, env });
      const page = yield* driver("desktop window", () => electron.firstWindow());
      yield* dashboard(page);
      expect(new URL(page.url()).origin).toBe(origin);
      const first = yield* nextServer([]);
      const servers = [first];

      // Stopping the shared server on purpose, as `executor service stop` does, is not a crash,
      // and the desktop does not start another by itself: it says the server was stopped.
      const stopped = yield* cli.run(["service", "stop"]);
      expect(stopped.code, stopped.stderr).toBe(0);
      yield* recoveryHeading(page, "The background Executor was stopped");
      yield* screenshot(page, "stopped");
      expect(
        yield* driver("stopped page actions", () => page.getByRole("button").allTextContents()),
      ).toEqual(["Start", "Quit"]);
      yield* eventsNamed(data, waitingForServer, 1);
      const starts = yield* serverStarts(data);
      expect((yield* cli.run(["service", "status"])).stdout.trim()).toBe("stopped");

      // A server the CLI starts again is joined as soon as it answers, without starting one: the
      // CLI found none running, and the desktop started none.
      const begun = yield* cli.run(["service", "start"]);
      expect(begun.code, begun.stderr).toBe(0);
      expect(begun.stderr).toContain(startingInCli);
      const fromCli = yield* nextServer(servers);
      servers.push(fromCli);
      yield* dashboard(page);
      expect(yield* pairedSession(page)).toEqual({ authenticated: true });
      expect((yield* eventsNamed(data, "Background Executor ready", 2))[1]?.annotations.pid).toBe(
        fromCli.pid,
      );

      // `executor service restart` replaces it, and the desktop follows to the new one.
      const restart = yield* cli.run(["service", "restart"]);
      expect(restart.code, restart.stderr).toBe(0);
      const replacement = yield* nextServer(servers);
      servers.push(replacement);
      expect((yield* eventsNamed(data, "Background Executor ready", 3))[2]?.annotations.pid).toBe(
        replacement.pid,
      );
      yield* dashboard(page);
      expect(yield* pairedSession(page)).toEqual({ authenticated: true });
      expect(yield* serverStarts(data)).toBe(starts);

      // Start on the stopped page starts a server from the desktop and pairs the window with it.
      expect((yield* cli.run(["service", "stop"])).code).toBe(0);
      yield* recoveryHeading(page, "The background Executor was stopped");
      yield* driver("start from the stopped page", () =>
        page.getByRole("button", { name: "Start", exact: true }).click(),
      );
      const fromDesktop = yield* nextServer(servers);
      servers.push(fromDesktop);
      expect(fromDesktop.url).toBe(origin);
      yield* dashboard(page);
      expect(yield* pairedSession(page)).toEqual({ authenticated: true });
      expect(yield* serverStarts(data)).toBe(starts + 1);
      const deliberate = (yield* eventsNamed(data, lostServer, 3)).map(
        (event) => event.annotations.loss,
      );
      expect(deliberate[0]).toBe("stopped");
      expect(["stopped", "replaced"]).toContain(deliberate[1]);
      expect(deliberate[2]).toBe("stopped");

      // A server that crashes leaves its registration behind and stops answering. The desktop
      // replaces it and pairs the window with the new one.
      for (const _ of [1, 2]) {
        yield* crashServer(servers[servers.length - 1]!.pid);
        const next = yield* nextServer(servers);
        expect(next.url).toBe(origin);
        servers.push(next);
        yield* dashboard(page);
        expect(yield* pairedSession(page)).toEqual({ authenticated: true });
      }
      const crashStarts = yield* serverStarts(data);

      // A third crash within a minute stops reconnecting and shows recovery; no server starts.
      yield* crashServer(servers[servers.length - 1]!.pid);
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
      expect(
        (yield* eventsNamed(data, lostServer, 6)).slice(3).map((event) => event.annotations.loss),
      ).toEqual(["unanswered", "unanswered", "unanswered"]);
      expect(yield* serverStarts(data)).toBe(crashStarts);
      const left = yield* registeredServer(data);
      expect(Option.isNone(left) || (yield* serverExited(left.value))).toBe(true);

      // Restart from the recovery page starts a server and pairs the window again.
      yield* driver("restart from recovery", () =>
        page.getByRole("button", { name: "Restart", exact: true }).click(),
      );
      const restarted = yield* nextServer(servers);
      yield* dashboard(page);
      expect(new URL(page.url()).origin).toBe(origin);
      expect(yield* pairedSession(page)).toEqual({ authenticated: true });
      const status = yield* cli.run(["service", "status"]);
      expect(status.stdout.trim()).toBe(statusLine(restarted));
    }),
  ).pipe(Effect.provide(services)),
);

it.live(scenarios.desktopLateLoadFailure.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { home, data, env, nextServer } = yield* desktopHome();
      const electron = yield* launchDesktop({ cwd: home, env });
      const page = yield* driver("desktop window", () => electron.firstWindow());
      yield* dashboard(page);
      yield* reportReplacedLoadFailuresLate(electron);

      // The server crashes, so the window shows the startup page, and then hears that the
      // dashboard it replaced failed to load. The startup page shows only until the replacement
      // server is ready, so the wait for it starts on the dashboard. It reads from the window: a
      // desktop stopped behind its error box answers no main-process call.
      const startupPage = yield* driver("the window shows the startup page", () =>
        page.waitForURL((url) => url.protocol === "data:", { timeout: 30_000 }),
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      const first = yield* nextServer([]);
      yield* crashServer(first.pid);
      yield* nextServer([first]);
      yield* Fiber.join(startupPage);

      // That failure was the dashboard's, not the startup page's: the desktop keeps its window
      // and opens the new server's dashboard.
      yield* dashboard(page);
      expect(yield* lateLoadFailures(electron)).toBe(1);
      expect(yield* eventsNamed(data, "Executor desktop ready", 2)).toHaveLength(2);
      expect((yield* desktopEvents(data)).map((event) => event.message)).not.toContain(
        "Desktop stopped",
      );
    }),
  ).pipe(Effect.provide(services)),
);

it.live(scenarios.desktopDashboardRetry.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { home, data, env, origin, nextServer } = yield* desktopHome();
      const electron = yield* launchDesktop({ cwd: home, env });
      const page = yield* driver("desktop window", () => electron.firstWindow());
      yield* dashboard(page);
      const first = yield* nextServer([]);
      const failures = Effect.map(desktopEvents(data), (events) =>
        events.filter((event) => event.message === dashboardFailed),
      );
      expect(yield* failures).toEqual([]);

      // The window's next two dashboard loads fail. Each time the desktop loads the dashboard
      // again with a fresh pairing link, since the one it used is spent, and the window is paired.
      yield* failDashboardLoads(electron, origin, 2);
      yield* crashServer(first.pid);
      const second = yield* nextServer([first]);
      yield* dashboard(page);
      expect(yield* pairedSession(page)).toEqual({ authenticated: true });
      expect(yield* dashboardLoads(electron)).toEqual({ failed: 2, links: 3 });
      expect(
        (yield* eventsNamed(data, dashboardFailed, 2)).map(({ annotations }) => [
          annotations.attempt,
          annotations.failure,
        ]),
      ).toEqual([
        [1, "ERR_BLOCKED_BY_CLIENT (-20)"],
        [2, "ERR_BLOCKED_BY_CLIENT (-20)"],
      ]);
      expect(yield* failures).toHaveLength(2);

      // When every load fails, the third failure in a row shows the dashboard's own recovery page
      // with the failure, and no other server starts. The server runs, so it offers no reset.
      // Restart joins the server and pairs the window.
      const starts = yield* serverStarts(data);
      yield* failDashboardLoads(electron, origin, "all");
      yield* crashServer(second.pid);
      const third = yield* nextServer([first, second]);
      yield* recoveryHeading(page, "Executor could not load its dashboard");
      yield* screenshot(page, "recovery-dashboard");
      expect(
        yield* driver("recovery actions", () => page.getByRole("button").allTextContents()),
      ).toEqual(["Restart", "Show logs", "Quit"]);
      expect(yield* driver("the failure", () => page.locator("pre").textContent())).toBe(
        `The Executor window could not load the dashboard from ${origin} 3 times in a row. The last time: ERR_BLOCKED_BY_CLIENT (-20).`,
      );
      // The desktop logs each failure before it shows the page, but its logger buffers lines and
      // writes them to the file every 250 ms (rotatingJsonLogger in packages/telemetry/src/files.ts),
      // so the page can show before the file holds the third; wait for all five.
      expect(
        (yield* eventsNamed(data, dashboardFailed, 5))
          .slice(2)
          .map(({ annotations }) => annotations.attempt),
      ).toEqual([1, 2, 3]);
      const [shown] = yield* eventsNamed(data, "Showing desktop recovery", 1);
      expect(shown?.annotations.recovery).toEqual({ stage: "dashboard" });
      expect(yield* dashboardLoads(electron)).toEqual({ failed: 5, links: 6 });
      expect(yield* serverStarts(data)).toBe(starts + 1);
      expect(yield* answersReady(third)).toBe(true);

      yield* failDashboardLoads(electron, origin, 0);
      yield* driver("restart from recovery", () =>
        page.getByRole("button", { name: "Restart", exact: true }).click(),
      );
      yield* dashboard(page);
      expect(yield* pairedSession(page)).toEqual({ authenticated: true });
      expect(yield* serverStarts(data)).toBe(starts + 1);
      expect((yield* eventsNamed(data, "Background Executor ready", 4))[3]?.annotations.pid).toBe(
        third.pid,
      );
      expect(yield* failures).toHaveLength(5);
    }),
  ).pipe(Effect.provide(services)),
);

it.live(
  scenarios.desktopStarterDeadline.title,
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { home, data, env, nextServer } = yield* desktopHome();
        const electron = yield* launchDesktop({ cwd: home, env });
        const page = yield* driver("desktop window", () => electron.firstWindow());
        // The server starter stops answering once it has started a server: it and that start
        // attempt hang until they are resumed.
        const stalled = yield* stallStarter(electron);

        // After its deadline the desktop stops waiting and says the server could not start.
        yield* driver("start recovery after the starter's deadline", () =>
          page
            .getByRole("heading", {
              name: "Executor could not start its local server",
              exact: true,
            })
            .waitFor({ state: "visible", timeout: 240_000 }),
        );
        const [failed] = yield* eventsNamed(data, "Background Executor could not start", 1);
        expect(failed?.annotations.detail).toContain(
          "did not say whether the server started within 3 minutes",
        );

        // The hung starter is stopped, and the start attempt it left, which never served, is
        // ended first, as the starter would have ended it.
        const [ended] = yield* eventsNamed(
          data,
          "Ended a start attempt of a server starter that did not exit",
          1,
        );
        expect(ended?.annotations.pid).toBe(stalled.attempt);
        yield* stalled.resume;
        yield* processAlive(stalled.attempt).pipe(
          Effect.filterOrFail(
            (alive) => !alive,
            () => new Error("The start attempt the hung starter left still runs"),
          ),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
        );
        expect(Option.isNone(yield* registeredServer(data))).toBe(true);

        // Restart starts a server and pairs the window with it.
        yield* driver("restart from recovery", () =>
          page.getByRole("button", { name: "Restart", exact: true }).click(),
        );
        // No server is registered, so any that answers is the one Restart started.
        yield* nextServer([]);
        yield* dashboard(page);
        expect(yield* pairedSession(page)).toEqual({ authenticated: true });
        expect(yield* serverStarts(data)).toBe(2);
      }),
    ).pipe(Effect.provide(services)),
  300_000,
);

it.live(scenarios.desktopSharedService.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { home, data, env, origin, cli, nextServer } = yield* desktopHome({ keys: "file" });

      // The desktop starts the data directory's background server, and the CLI uses that one.
      const started = yield* Effect.scoped(
        Effect.gen(function* () {
          const electron = yield* launchDesktop({ cwd: home, env });
          const page = yield* driver("desktop window", () => electron.firstWindow());
          yield* dashboard(page);
          expect(new URL(page.url()).origin).toBe(origin);
          const server = yield* nextServer([]);
          const [ready] = yield* eventsNamed(data, "Background Executor ready", 1);
          expect(ready?.annotations.pid).toBe(server.pid);
          const status = yield* cli.run(["service", "status"]);
          expect(status.code, status.stderr).toBe(0);
          expect(status.stdout.trim()).toBe(statusLine(server));
          const listed = yield* cli.run(["apps", "list"]);
          expect(listed.code, listed.stderr).toBe(0);
          expect(listed.stderr).not.toContain(startingInCli);
          expect((yield* Schema.decodeUnknownEffect(Apps)(listed.stdout)).length).toBeGreaterThan(
            0,
          );
          return server;
        }),
      );

      // Quitting the desktop leaves the server running for the CLI and MCP clients.
      expect(yield* answersReady(started)).toBe(true);
      const after = yield* cli.run(["service", "status"]);
      expect(after.stdout.trim()).toBe(statusLine(started));

      // A server the CLI starts is the one the desktop joins: it starts none of its own.
      const stopped = yield* cli.run(["service", "stop"]);
      expect(stopped.code, stopped.stderr).toBe(0);
      expect(yield* serverExited(started)).toBe(true);
      expect((yield* cli.run(["service", "status"])).stdout.trim()).toBe("stopped");
      const begun = yield* cli.run(["service", "start"]);
      expect(begun.code, begun.stderr).toBe(0);
      expect(begun.stdout.trim()).toBe(origin);
      const fromCli = yield* nextServer([started]);
      const starts = yield* serverStarts(data);
      const electron = yield* launchDesktop({ cwd: home, env });
      const page = yield* driver("desktop window", () => electron.firstWindow());
      yield* dashboard(page);
      expect(new URL(page.url()).origin).toBe(origin);
      expect(yield* pairedSession(page)).toEqual({ authenticated: true });
      const [, joined] = yield* eventsNamed(data, "Background Executor ready", 2);
      expect(joined?.annotations.pid).toBe(fromCli.pid);
      expect(yield* serverStarts(data)).toBe(starts);
      expect((yield* cli.run(["service", "status"])).stdout.trim()).toBe(statusLine(fromCli));
    }),
  ).pipe(Effect.provide(services)),
);

/**
 * Real data in `directory`, made the way a user's is: the CLI starts a background server there,
 * which sets up its keys, storage and bundled app. Returns that server and the apps it lists.
 */
const seedData = (
  cli: Effect.Success<ReturnType<typeof desktopCli>>,
  directory: string,
  port: number,
) =>
  Effect.gen(function* () {
    const listed = yield* cli.run(
      ["apps", "list"],
      { EXECUTOR_DATA_DIR: directory, EXECUTOR_PORT: String(port) },
      { source: true },
    );
    expect(listed.code, listed.stderr).toBe(0);
    const apps = yield* Schema.decodeUnknownEffect(Apps)(listed.stdout);
    expect(apps.length).toBeGreaterThan(0);
    const server = yield* nextServer(directory, []);
    return { server, apps };
  });

/** An older desktop's `desktop.json`, which chose its server's port. */
const legacySettings = (directory: string, port: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(
      path.join(directory, "desktop.json"),
      JSON.stringify({ version: 1, port }),
    );
  });

const MigrationRecord = Schema.fromJsonString(
  Schema.Struct({
    state: Schema.String,
    result: Schema.optional(
      Schema.Struct({
        kind: Schema.String,
        archived: Schema.optional(Schema.String),
        backup: Schema.optional(Schema.String),
      }),
    ),
  }),
);

it.live(scenarios.desktopMigrationMoved.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // No EXECUTOR_PORT: the old desktop's saved port must carry over to the shared directory.
      const { home, data, legacy, env, cli, nextServer } = yield* desktopHome({
        keys: "file",
        port: false,
        legacy: true,
      });
      const backups = path.join(home, "backups");
      const old = yield* seedData(cli, legacy, yield* freePort);
      const desktopPort = yield* freePort;
      yield* legacySettings(legacy, desktopPort);
      const installation = yield* fs.readFileString(path.join(legacy, "installation.json"));
      const keys = yield* fs.readFileString(path.join(legacy, "keys.json"));
      // Older desktops created their data directory with the default mode, readable by others.
      const posix = process.platform !== "win32";
      if (posix) yield* fs.chmod(legacy, 0o755);

      // While a server still uses the old data, nothing moves and no server starts: the window
      // explains what to quit.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const electron = yield* launchDesktop({ cwd: home, env });
          const page = yield* driver("desktop window", () => electron.firstWindow());
          yield* recoveryHeading(page, "Executor could not move its data");
          expect(
            yield* driver("recovery actions", () => page.getByRole("button").allTextContents()),
          ).toEqual(["Restart", "Quit"]);
          const said = yield* driver("the migration's message", () =>
            page.locator("pre").textContent(),
          );
          expect(said).toContain(`(process ${old.server.pid}) is using ${legacy}`);
          expect(said).toContain("Nothing was changed.");
          yield* screenshot(page, "recovery-migration");
        }),
      );
      expect(yield* fs.exists(data)).toBe(false);
      expect(yield* fs.exists(path.join(home, "migration.json"))).toBe(false);
      expect(yield* fs.readFileString(path.join(legacy, "installation.json"))).toBe(installation);
      const stopped = yield* cli.run(
        ["service", "stop"],
        { EXECUTOR_DATA_DIR: legacy },
        { source: true },
      );
      expect(stopped.code, stopped.stderr).toBe(0);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const electron = yield* launchDesktop({ cwd: home, env });
          const page = yield* driver("desktop window", () => electron.firstWindow());
          yield* dashboard(page);
          // The server runs on the moved data, on the old desktop's port.
          expect(new URL(page.url()).origin).toBe(`http://127.0.0.1:${desktopPort}`);
          const server = yield* nextServer([old.server]);
          expect(server.url).toBe(`http://127.0.0.1:${desktopPort}`);
          expect(yield* pairedSession(page)).toEqual({ authenticated: true });
        }),
      );

      const [moved] = yield* eventsNamed(data, "Moved the desktop's data", 1);
      expect(moved?.annotations.kind).toBe("moved");
      expect(moved?.annotations.archived).toBeUndefined();
      const backup = moved?.annotations.backup ?? "";
      expect(path.dirname(backup)).toBe(backups);
      expect(path.basename(backup)).toMatch(/^desktop-data-\d{8}T\d{6}Z-[0-9a-f]{6}$/);
      // The data moved whole and unchanged, keys included; the old directory became the backup.
      expect(yield* fs.exists(legacy)).toBe(false);
      expect(yield* fs.readFileString(path.join(data, "installation.json"))).toBe(installation);
      expect(yield* fs.readFileString(path.join(data, "keys.json"))).toBe(keys);
      expect(yield* fs.readFileString(path.join(backup, "installation.json"))).toBe(installation);
      expect(JSON.parse(yield* fs.readFileString(path.join(data, "service.json")))).toMatchObject({
        port: desktopPort,
      });
      // The shared directory is private, as the CLI creates it, whatever the old one's mode was.
      if (posix) expect((yield* fs.stat(data)).mode & 0o777).toBe(0o700);
      const listed = yield* cli.run(["apps", "list"]);
      expect(listed.code, listed.stderr).toBe(0);
      expect(listed.stderr).not.toContain(startingInCli);
      expect(yield* Schema.decodeUnknownEffect(Apps)(listed.stdout)).toEqual(old.apps);
      const record = yield* fs
        .readFileString(path.join(home, "migration.json"))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(MigrationRecord)));
      expect(record).toMatchObject({ state: "done", result: { kind: "moved", backup } });
      const events = (yield* desktopEvents(data)).map((event) => event.message);
      expect(events).not.toContain("Showing the moved data notice");
      // Moving finished before the desktop first started a server.
      expect(events.indexOf("Moved the desktop's data")).toBeLessThan(
        events.indexOf("Starting the background Executor"),
      );

      // It moves once: an old directory that reappears later is left alone.
      yield* fs.makeDirectory(legacy);
      const stray = JSON.stringify({ version: 1, id: randomUUID(), state: "file" });
      yield* fs.writeFileString(path.join(legacy, "installation.json"), stray);
      const electron = yield* launchDesktop({ cwd: home, env });
      const page = yield* driver("desktop window", () => electron.firstWindow());
      yield* dashboard(page);
      expect(yield* eventsNamed(data, "Executor desktop ready", 2)).toHaveLength(2);
      expect(
        (yield* desktopEvents(data)).filter(
          (event) => event.message === "Moved the desktop's data",
        ),
      ).toHaveLength(1);
      expect(yield* fs.readFileString(path.join(legacy, "installation.json"))).toBe(stray);
      expect(yield* fs.readFileString(path.join(data, "installation.json"))).toBe(installation);
    }),
  ).pipe(Effect.provide(services)),
);

/**
 * A desktop home where the old desktop directory holds the desktop's data, with its saved port, and
 * the shared directory holds the CLI's own data, whose background server is running: a machine
 * that used both before the desktop shared the CLI's data.
 */
const replacedHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* desktopHome({ keys: "file", port: false, legacy: true });
  const desktopData = yield* seedData(home.cli, home.legacy, yield* freePort);
  expect(
    (yield* home.cli.run(["service", "stop"], { EXECUTOR_DATA_DIR: home.legacy }, { source: true }))
      .code,
  ).toBe(0);
  const desktopPort = yield* freePort;
  yield* legacySettings(home.legacy, desktopPort);
  const desktopInstallation = yield* fs.readFileString(path.join(home.legacy, "installation.json"));
  const cliData = yield* seedData(home.cli, home.data, yield* freePort);
  const cliInstallation = yield* fs.readFileString(path.join(home.data, "installation.json"));
  expect(cliInstallation).not.toBe(desktopInstallation);
  expect(cliData.apps).not.toEqual(desktopData.apps);
  return { ...home, desktopData, desktopPort, desktopInstallation, cliData, cliInstallation };
});
type ReplacedHome = Effect.Success<typeof replacedHome>;

/**
 * In a launch after the desktop's data replaced the CLI's: the server runs on the moved data, on the
 * old desktop's port; the CLI's server was stopped and its data moved aside, whole; the desktop's
 * data won. Returns where the CLI's data went.
 */
const replacedData = (home: ReplacedHome, page: Page) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    expect(new URL(page.url()).origin).toBe(`http://127.0.0.1:${home.desktopPort}`);
    yield* home.nextServer([home.desktopData.server, home.cliData.server]);
    expect(yield* serverExited(home.cliData.server)).toBe(true);
    const [replaced] = yield* eventsNamed(home.data, "Moved the desktop's data", 1);
    expect(replaced?.annotations.kind).toBe("replaced");
    const archived = replaced?.annotations.archived ?? "";
    expect(path.dirname(archived)).toBe(path.join(home.home, "backups"));
    expect(path.basename(archived)).toMatch(/^cli-data-\d{8}T\d{6}Z-[0-9a-f]{6}$/);
    expect(yield* fs.readFileString(path.join(archived, "installation.json"))).toBe(
      home.cliInstallation,
    );
    expect(yield* fs.readFileString(path.join(home.data, "installation.json"))).toBe(
      home.desktopInstallation,
    );
    const listed = yield* home.cli.run(["apps", "list"]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(yield* Schema.decodeUnknownEffect(Apps)(listed.stdout)).toEqual(home.desktopData.apps);
    return archived;
  });

const movedNotice = "Executor now shares its data with the CLI";

/** `electron`'s launch showed the notice that names where the CLI's data went. */
const noticeNamed = (electron: ElectronApplication, data: string, archived: string) =>
  Effect.gen(function* () {
    const [notice] = yield* dialogsShown(electron, 1);
    expect(notice?.title).toBe(movedNotice);
    expect(notice?.detail).toContain(archived);
    const [shown] = yield* eventsNamed(data, "Showing the moved data notice", 1);
    expect(shown?.annotations.archived).toBe(archived);
  });

/** Once the notice has been answered, a later launch does not show it again. */
const noticeShownOnce = (home: ReplacedHome) =>
  Effect.scoped(
    Effect.gen(function* () {
      const logged = (message: string) =>
        Effect.map(
          desktopEvents(home.data),
          (events) => events.filter((event) => event.message === message).length,
        );
      const shown = yield* logged("Showing the moved data notice");
      const ready = yield* logged("Executor desktop ready");
      const electron = yield* launchDesktop({ cwd: home.home, env: home.env });
      yield* answerDialogs(electron, {});
      const page = yield* driver("desktop window", () => electron.firstWindow());
      yield* dashboard(page);
      yield* eventsNamed(home.data, "Executor desktop ready", ready + 1);
      expect(yield* pairedSession(page)).toEqual({ authenticated: true });
      expect(yield* answeredDialogs(electron)).toEqual([]);
      expect(yield* logged("Showing the moved data notice")).toBe(shown);
    }),
  );

it.live(scenarios.desktopMigrationReplaced.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const home = yield* replacedHome;

      // The launch that moves the data starts the server on it and names where the CLI's data went.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const electron = yield* launchDesktop({ cwd: home.home, env: home.env });
          // The notice shows once the window has settled; record it instead of waiting for a person.
          yield* answerDialogs(electron, {});
          const page = yield* driver("desktop window", () => electron.firstWindow());
          yield* dashboard(page);
          expect(yield* pairedSession(page)).toEqual({ authenticated: true });
          const archived = yield* replacedData(home, page);
          yield* noticeNamed(electron, home.data, archived);
          // In that one launch the data moved before a server started, and the notice came once
          // the window showed the dashboard.
          const events = (yield* desktopEvents(home.data)).map((event) => event.message);
          expect(events.filter((message) => message === "Starting Executor desktop")).toHaveLength(
            1,
          );
          expect(events.indexOf("Moved the desktop's data")).toBeLessThan(
            events.indexOf("Starting the background Executor"),
          );
          expect(events.indexOf("Executor desktop ready")).toBeLessThan(
            events.indexOf("Showing the moved data notice"),
          );
          yield* screenshot(page, "migration-replaced");
        }),
      );

      yield* noticeShownOnce(home);
    }),
  ).pipe(Effect.provide(services)),
);

it.live(scenarios.desktopMigrationReplacedClosed.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* replacedHome;
      const recordPath = path.join(home.home, "migration.json");
      /** Whether the migration record says the move is done; it only ever moves forward. */
      const moveDone = Effect.gen(function* () {
        if (!(yield* fs.exists(recordPath))) return false;
        const record = yield* fs
          .readFileString(recordPath)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(MigrationRecord)));
        return record.state === "done";
      });

      // Closing the window while the data moves ends the app once the move is done. The move first
      // stops the CLI's server, which is suspended: it waits seconds for it to answer and then to
      // exit before it ends it, so the window closes long before the data has moved. Whether it
      // did is read from the migration record before the server is resumed, and required, since
      // the checks below hold only for a window closed during the move.
      const closed = yield* Effect.scoped(
        Effect.gen(function* () {
          const held = yield* suspendProcess(home.cliData.server.pid);
          const electron = yield* launchDesktop({ cwd: home.home, env: home.env });
          // Resumed before the desktop is closed, which waits for the move.
          yield* Effect.addFinalizer(() => held.resume);
          // A notice this launch shows stays unanswered, so it is still due on the next launch.
          yield* answerDialogs(electron, { [movedNotice]: "unanswered" });
          const page = yield* driver("desktop window", () => electron.firstWindow());
          yield* driver("the window says the data is moving", () =>
            page
              .getByRole("heading", { name: "Moving your Executor data…", exact: true })
              .waitFor({ state: "visible", timeout: 60_000 }),
          );
          const menu = yield* menuBar(electron);
          const quit = yield* driver("the desktop quits once the data has moved", () =>
            electron.waitForEvent("close", { timeout: 120_000 }),
          ).pipe(Effect.forkScoped({ startImmediately: true }));
          yield* driver("close the window while the data moves", () =>
            electron.evaluate(({ BrowserWindow }) => {
              for (const window of BrowserWindow.getAllWindows()) window.close();
            }),
          );
          // Electron quits as the last window closes, in the same step, so once no window is left
          // the desktop has been asked to quit. It answers, so it still runs.
          const windowless = driver("no desktop window is left", () =>
            electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
          ).pipe(
            Effect.filterOrFail(
              (windows) => windows === 0,
              () => new Error("A desktop window is still open"),
            ),
            Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 600 }),
            Effect.as(true),
          );
          const running = yield* Effect.race(windowless, Effect.as(Fiber.join(quit), false));
          const moved = yield* moveDone;
          yield* held.resume;
          yield* Fiber.join(quit);
          return { running, moved, menu };
        }),
      );
      expect(closed.running, "the desktop quit before its last window had closed").toBe(true);
      expect(closed.moved, "the data had moved before the window closed").toBe(false);
      const interrupted = (yield* desktopEvents(home.data)).map((event) => event.message);
      expect(interrupted).toContain("Moved the desktop's data");
      // The desktop quit once the move was done, before it started or joined a server, and so
      // before the notice. Meanwhile its menu was its own, with none of its actions, which need
      // the data: File, by its label, with only Quit (Close on macOS), and the standard Edit, View
      // and Window menus. Electron's default menu has the same items, but builds File from its
      // role.
      expect(interrupted).not.toContain("Connecting to the background Executor");
      expect(interrupted).not.toContain("Showing the moved data notice");
      const darwin = process.platform === "darwin";
      expect(closed.menu.map(({ menu }) => menu)).toEqual([
        ...(darwin ? ["appmenu"] : []),
        "File",
        "editmenu",
        "viewmenu",
        "windowmenu",
      ]);
      expect(closed.menu.find(({ menu }) => menu === "File")?.items).toEqual([
        darwin ? "close" : "quit",
      ]);

      // The next launch starts the server on the moved data and names where the CLI's data went.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const electron = yield* launchDesktop({ cwd: home.home, env: home.env });
          yield* answerDialogs(electron, {});
          const page = yield* driver("desktop window", () => electron.firstWindow());
          yield* dashboard(page);
          expect(yield* pairedSession(page)).toEqual({ authenticated: true });
          const archived = yield* replacedData(home, page);
          yield* noticeNamed(electron, home.data, archived);
        }),
      );

      yield* noticeShownOnce(home);
    }),
  ).pipe(Effect.provide(services)),
);

it.live(scenarios.desktopMigrationSettings.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* desktopHome({ keys: "file", port: false, legacy: true });
      const backups = path.join(home.home, "backups");
      const recordPath = path.join(home.home, "migration.json");
      const desktopData = yield* seedData(home.cli, home.legacy, yield* freePort);
      const stopped = yield* home.cli.run(
        ["service", "stop"],
        { EXECUTOR_DATA_DIR: home.legacy },
        { source: true },
      );
      expect(stopped.code, stopped.stderr).toBe(0);
      const desktopPort = yield* freePort;
      yield* legacySettings(home.legacy, desktopPort);
      const setAll = (settings: ReadonlyArray<ReadonlyArray<string>>) =>
        Effect.forEach(
          settings,
          (args) =>
            home.cli
              .run(args, {}, { source: true })
              .pipe(Effect.tap((set) => Effect.sync(() => expect(set.code, set.stderr).toBe(0)))),
          { discard: true },
        );

      // The CLI's directory holds only its settings, as `executor service set` leaves them before
      // any server has run: its own port, a variable for its servers, how its keys are kept, and
      // the service turned off.
      yield* setAll([
        ["service", "set", "port", String(yield* freePort)],
        ["service", "set", "env", "EXECUTOR_E2E_CARRIED", "kept"],
        ["service", "set", "env", "EXECUTOR_KEY_STORAGE", "file"],
        ["service", "set", "disabled", "true"],
      ]);
      const firstSettings = yield* fs.readFileString(path.join(home.data, "service.json"));
      expect(yield* fs.readDirectory(home.data)).toEqual(["service.json"]);

      // The first launch copies the data but cannot move the old directory aside, so it keeps the
      // verified copy for the next launch and changes nothing else. POSIX refuses a rename into a
      // read-only folder; Windows ignores that, but refuses to rename a folder with a file open.
      yield* Effect.scoped(
        Effect.gen(function* () {
          if (process.platform === "win32")
            yield* fs.open(path.join(home.legacy, "desktop.json"), { flag: "r" });
          else yield* fs.makeDirectory(backups, { mode: 0o500 });
          const electron = yield* launchDesktop({ cwd: home.home, env: home.env });
          const page = yield* driver("desktop window", () => electron.firstWindow());
          yield* recoveryHeading(page, "Executor could not move its data");
          expect(
            yield* driver("the migration's message", () => page.locator("pre").textContent()),
          ).toContain("Executor continues moving your data the next time it starts.");
        }),
      );
      if (process.platform !== "win32") {
        expect(yield* fs.readDirectory(backups)).toEqual([]);
        yield* fs.chmod(backups, 0o700);
      }
      const kept = yield* fs
        .readFileString(recordPath)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(MigrationRecord)));
      expect(kept.state).toBe("copied");
      expect(yield* fs.readDirectory(home.data)).toEqual(["service.json"]);
      expect(yield* fs.readFileString(path.join(home.data, "service.json"))).toBe(firstSettings);
      expect(yield* fs.exists(home.legacy)).toBe(true);

      // Meanwhile the CLI's settings change. The next launch moves the copy with them as they are
      // then.
      const cliPort = yield* freePort;
      yield* setAll([
        ["service", "set", "port", String(cliPort)],
        ["service", "set", "env", "EXECUTOR_E2E_LATER", "later"],
      ]);
      const cliSettings = yield* fs.readFileString(path.join(home.data, "service.json"));

      // The launch that moves the data names where the CLI's settings went and what changed.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const electron = yield* launchDesktop({ cwd: home.home, env: home.env });
          yield* answerDialogs(electron, {});
          const page = yield* driver("desktop window", () => electron.firstWindow());
          yield* dashboard(page);
          expect(new URL(page.url()).origin).toBe(`http://127.0.0.1:${desktopPort}`);
          const server = yield* home.nextServer([desktopData.server]);
          expect(server.url).toBe(`http://127.0.0.1:${desktopPort}`);
          expect(yield* pairedSession(page)).toEqual({ authenticated: true });
          const [moved] = yield* eventsNamed(home.data, "Moved the desktop's data", 1);
          expect(moved?.annotations.kind).toBe("moved");
          expect(moved?.annotations.settings).toEqual({
            port: { from: cliPort, to: desktopPort },
            variables: ["EXECUTOR_KEY_STORAGE"],
            removed: ["disabled"],
          });
          const archived = moved?.annotations.archived ?? "";
          expect(path.dirname(archived)).toBe(backups);
          expect(path.basename(archived)).toMatch(/^cli-data-\d{8}T\d{6}Z-[0-9a-f]{6}$/);
          // The CLI's settings are kept there as they were.
          expect(yield* fs.readFileString(path.join(archived, "service.json"))).toBe(cliSettings);
          yield* noticeNamed(electron, home.data, archived);
          const [notice] = yield* dialogsShown(electron, 1);
          expect(notice?.detail).toContain(
            `The background Executor now uses port ${desktopPort}, as the desktop did, instead of the CLI's port ${cliPort}.`,
          );
          expect(notice?.detail).toContain(
            "These CLI env settings belonged to its previous data, so they stayed with it: EXECUTOR_KEY_STORAGE.",
          );
          expect(notice?.detail).toContain(
            "The CLI's disabled setting was removed: the desktop runs the background Executor, so `executor` and `executor apps` use it too.",
          );
          expect(notice?.detail).not.toContain("EXECUTOR_E2E_CARRIED");
          expect(notice?.detail).not.toContain("EXECUTOR_E2E_LATER");
        }),
      );

      // The shared directory has the CLI's other settings as they were when the copy moved in,
      // with the desktop's port and the service on, and is private.
      expect(JSON.parse(yield* fs.readFileString(path.join(home.data, "service.json")))).toEqual({
        env: { EXECUTOR_E2E_CARRIED: "kept", EXECUTOR_E2E_LATER: "later" },
        port: desktopPort,
      });
      for (const [args, value] of [
        [["service", "get", "disabled"], "false"],
        [["service", "get", "env", "EXECUTOR_E2E_CARRIED"], "kept"],
        [["service", "get", "env", "EXECUTOR_E2E_LATER"], "later"],
        [["service", "get", "env", "EXECUTOR_KEY_STORAGE"], ""],
        [["service", "get", "port"], String(desktopPort)],
      ] as const) {
        const read = yield* home.cli.run(args, {}, { source: true });
        expect(read.code, read.stderr).toBe(0);
        expect(read.stdout.trim()).toBe(value);
      }
      if (process.platform !== "win32")
        expect((yield* fs.stat(home.data)).mode & 0o777).toBe(0o700);

      // App commands use the background server the desktop left running, as they did not while
      // the service was off.
      const listed = yield* home.cli.run(["apps", "list"], {}, { source: true });
      expect(listed.code, listed.stderr).toBe(0);
      expect(listed.stderr).not.toContain(startingInCli);
      expect(yield* Schema.decodeUnknownEffect(Apps)(listed.stdout)).toEqual(desktopData.apps);
    }),
  ).pipe(Effect.provide(services)),
);

it.live(scenarios.desktopSlowStop.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { data, home, env, cli, nextServer } = yield* desktopHome();
      const electron = yield* launchDesktop({ cwd: home, env });
      const page = yield* driver("desktop window", () => electron.firstWindow());
      yield* dashboard(page);
      const server = yield* nextServer([]);
      const starts = yield* serverStarts(data);

      // The server is asked to stop and takes seconds to exit, keeping its registration until
      // then and answering meanwhile that it is stopping. A real server's own shutdown takes a
      // fraction of a second, so it is ended and a stand-in answers in its place, as it would.
      yield* crashServer(server.pid);
      yield* connectionRefused(Number(new URL(server.url).port)).pipe(
        Effect.filterOrFail(
          (refused) => refused,
          () => new Error("The ended server's port still accepts connections"),
        ),
        Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 500 }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const stopping = yield* stoppingServer(server);
          // The desktop says the server was stopped, while it is still stopping.
          yield* recoveryHeading(page, "The background Executor was stopped");
          expect(
            yield* driver("stopped page actions", () => page.getByRole("button").allTextContents()),
          ).toEqual(["Start", "Quit"]);
          const [lost] = yield* eventsNamed(data, lostServer, 1);
          expect(lost?.annotations).toMatchObject({ pid: server.pid, loss: "stopped" });
          // It waits on that page through more of the server's answers than the three missed
          // checks after which a server that stopped answering counts as lost, starting none.
          const seen = yield* stopping.answered;
          yield* stopping.answered.pipe(
            Effect.filterOrFail(
              (answered) => answered >= seen + 5,
              () => new Error("The desktop has stopped asking the stopping server"),
            ),
            Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
          );
          expect(yield* serverStarts(data)).toBe(starts);
          yield* recoveryHeading(page, "The background Executor was stopped");
          // The server's last step is removing its registration.
          yield* fs.remove(path.join(data, "server.json"));
        }),
      );

      // The stop was not counted as a crash: the server the CLI starts next is joined, and the
      // desktop has started none of its own.
      const begun = yield* cli.run(["service", "start"]);
      expect(begun.code, begun.stderr).toBe(0);
      expect(begun.stderr).toContain(startingInCli);
      const fromCli = yield* nextServer([server]);
      yield* dashboard(page);
      expect(yield* pairedSession(page)).toEqual({ authenticated: true });
      expect((yield* eventsNamed(data, "Background Executor ready", 2))[1]?.annotations.pid).toBe(
        fromCli.pid,
      );
      expect(yield* serverStarts(data)).toBe(starts);
      expect(
        (yield* desktopEvents(data))
          .filter((event) => event.message === lostServer)
          .map((event) => event.annotations.loss),
      ).toEqual(["stopped"]);
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
      yield* driver("open the From scratch dialog", () =>
        page
          .goto(`${origin}/apps`)
          .then(() => page.getByRole("button", { name: "Add app", exact: true }).click())
          .then(() => page.getByRole("menuitem", { name: /^From scratch/ }).click()),
      );
      const copy = page.getByRole("button", { name: "Copy setup prompt" });
      yield* driver("copy the setup prompt", () => copy.click());
      yield* driver("the copy succeeds", () =>
        copy.getByText("Copied", { exact: true }).waitFor({ state: "visible" }),
      );
      const copied = yield* driver("read the system clipboard", () =>
        electron.evaluate(({ clipboard }) => clipboard.readText()),
      );
      expect(copied).toContain("Help me build a new Executor app.");
    }),
  ).pipe(Effect.provide(services)),
);

it.live(scenarios.desktopReset.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, data, env, nextServer } = yield* desktopHome({ keys: "file" });
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
      // The server said why it refused, and a configuration failure is not retried.
      const [refused] = yield* eventsNamed(data, "Background Executor could not start", 1);
      expect(refused?.annotations).toMatchObject({
        stage: "configuration",
        configuration: "credential-missing",
      });
      expect(yield* serverStarts(data)).toBe(1);
      expect(Option.isNone(yield* registeredServer(data))).toBe(true);

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

      // A move that fails leaves the data and its lock state in place and starts the server again.
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
      yield* serverStarts(data).pipe(
        Effect.filterOrFail(
          (starts) => starts >= 2,
          () => new Error("The desktop has not started the server again"),
        ),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
      );
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
      expect(yield* fs.exists(path.join(data, ".server.lock"))).toBe(false);
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
      const fresh = yield* nextServer([]);
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
      expect(yield* fs.exists(path.join(backup, ".server.lock"))).toBe(false);
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

      const created = yield* fs
        .readFileString(path.join(data, "installation.json"))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Installation))));
      expect(created.id).not.toBe(original);
      expect(created.state).toBe("file");
      const readKeys = (directory: string) =>
        fs
          .readFileString(path.join(directory, "keys.json"))
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Keys))));
      const freshKeys = yield* readKeys(data);
      expect(yield* fs.exists(path.join(data, "retained.txt"))).toBe(false);

      // Resetting while the server runs stops it on purpose: the desktop never reports it lost.
      yield* answerDialogs(electron, { "Reset Executor data?": 0 });
      yield* clickMenuItem(electron, "Help", "Reset Executor data…");
      const again = yield* dialogsShown(electron, 2);
      expect(again.map((box) => box.title)).toEqual([
        "Reset Executor data?",
        "Executor data reset",
      ]);
      yield* dashboard(page);
      const third = yield* nextServer([fresh]);
      expect(yield* serverExited(fresh)).toBe(true);
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
      ).toBe(created.id);
      expect(secondManifest).not.toContain(freshKeys.apiKey);
      expect(secondManifest).not.toContain(freshKeys.encryptionKey);
      const stoppedRun = yield* desktopEvents(secondBackup);
      expect(stoppedRun.map((event) => event.message)).toContain("Background Executor ready");
      expect(
        [...stoppedRun, ...(yield* desktopEvents(data))].filter(
          (event) => event.message === lostServer || event.message === "Showing desktop recovery",
        ),
      ).toEqual([]);
      // Lines logged before a move go with it: the first backup holds both reset attempts.
      expect(
        (yield* desktopEvents(backup)).filter(
          (event) => event.message === "Resetting Executor data",
        ),
      ).toHaveLength(2);

      // A server killed outright leaves its lock and registration behind. Reset, chosen before
      // the desktop replaces it, takes that lock over as the next server would, and moves the
      // data aside.
      const startsBeforeCrash = yield* serverStarts(data);
      yield* crashServer(third.pid);
      yield* answerDialogs(electron, { "Reset Executor data?": 0 });
      yield* clickMenuItem(electron, "Help", "Reset Executor data…");
      const afterCrash = yield* dialogsShown(electron, 2);
      expect(afterCrash.map((box) => box.title)).toEqual([
        "Reset Executor data?",
        "Executor data reset",
      ]);
      yield* dashboard(page);
      yield* nextServer([fresh, third]);
      expect(yield* pairedSession(page)).toEqual({ authenticated: true });
      const crashedBackup = (yield* fs.readDirectory(backups)).find(
        (name) => name !== moved[0] && name !== second,
      );
      expect(crashedBackup).toBeDefined();
      expect(afterCrash[1]?.detail).toContain(path.join(backups, crashedBackup!));
      const crashedData = path.join(backups, crashedBackup!);
      expect(yield* fs.exists(path.join(crashedData, ".server.lock"))).toBe(false);
      expect(yield* fs.exists(path.join(crashedData, "server.json"))).toBe(false);
      expect(yield* fs.exists(path.join(crashedData, "installation.json"))).toBe(true);
      // The desktop had started no replacement for the killed server before the reset ran.
      expect(yield* serverStarts(crashedData)).toBe(startsBeforeCrash);
    }),
  ).pipe(Effect.provide(services)),
);

it.live(scenarios.desktopResetWithheld.title, () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const noReset = ["Restart", "Show logs", "Quit"];

    /** The server refused with `reason`, said so on its structured channel, and was not retried. */
    const refusedOnce = (data: string, reason: string) =>
      Effect.gen(function* () {
        const [refused] = yield* eventsNamed(data, "Background Executor could not start", 1);
        expect(refused?.annotations).toMatchObject({
          stage: "configuration",
          configuration: reason,
        });
        expect(yield* serverStarts(data)).toBe(1);
        expect(Option.isNone(yield* registeredServer(data))).toBe(true);
      });

    // Another process holds the server lock, or the key setup lock, without being a running
    // server. Its future timestamp keeps it from going stale.
    for (const held of [".server.lock", ".bootstrap.lock"])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { home, data, env } = yield* desktopHome();
          const lock = path.join(data, held);
          yield* fs.makeDirectory(lock, { recursive: true });
          const later = new Date(Date.now() + 60 * 60 * 1000);
          yield* fs.utimes(lock, later, later);
          const electron = yield* launchDesktop({ cwd: home, env });
          const page = yield* driver("desktop window", () => electron.firstWindow());
          yield* recoveryHeading(page, "Executor's data is in use");
          expect(
            yield* driver("recovery actions", () => page.getByRole("button").allTextContents()),
          ).toEqual(noReset);
          yield* refusedOnce(data, "locked");
          expect(yield* fs.exists(lock)).toBe(true);
        }),
      );

    // An Executor from before the background service runs on the data: it holds no lock, so only
    // its server.json shows it, and the desktop cannot stop it. This test's own process stands in
    // for it, with a listener that answers as that Executor did.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { home, data, env } = yield* desktopHome({ keys: "file" });
        const backups = path.join(home, "backups");
        const session = HttpRouter.add(
          "GET",
          "/auth/session",
          HttpServerResponse.json({ authenticated: false }),
        );
        const listening = yield* Layer.build(
          HttpRouter.serve(session, { disableLogger: true, disableListenLog: true }).pipe(
            Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
          ),
        );
        const listener = yield* HttpServer.HttpServer.pipe(Effect.provideContext(listening));
        if (!("port" in listener.address)) return yield* Effect.die("The listener must use TCP");
        const earlier = `http://127.0.0.1:${listener.address.port}`;
        const record = JSON.stringify({
          pid: process.pid,
          version: "2.0.0-beta.15",
          url: earlier,
          command: "executor serve",
        });
        yield* fs.makeDirectory(data, { recursive: true });
        yield* fs.writeFileString(path.join(data, "server.json"), record);
        const electron = yield* launchDesktop({ cwd: home, env });
        const page = yield* driver("desktop window", () => electron.firstWindow());
        yield* recoveryHeading(page, "Executor's data is in use");
        expect(
          yield* driver("recovery actions", () => page.getByRole("button").allTextContents()),
        ).toEqual(noReset);
        expect(yield* driver("the refusal", () => page.locator("pre").textContent())).toContain(
          `An Executor from before the background service (process ${process.pid})`,
        );
        const [refused] = yield* eventsNamed(data, "Background Executor could not start", 1);
        expect(refused?.annotations).toMatchObject({
          stage: "configuration",
          configuration: "locked",
        });
        expect(yield* serverStarts(data)).toBe(0);

        // Reset from the menu refuses too, and leaves the data in place.
        yield* answerDialogs(electron, { "Reset Executor data?": 0 });
        yield* clickMenuItem(electron, "Help", "Reset Executor data…");
        const failure = yield* dialogsShown(electron, 2);
        expect(failure.map((box) => box.title)).toEqual(["Reset Executor data?", "Reset failed"]);
        expect(failure[1]?.detail).toBe(
          "Another Executor process is using the data directory. Quit it and try again.",
        );
        expect(yield* fs.exists(backups)).toBe(false);
        expect(yield* fs.readFileString(path.join(data, "server.json"))).toBe(record);
        yield* recoveryHeading(page, "Executor's data is in use");
        expect(yield* serverStarts(data)).toBe(0);
      }),
    );

    /** Start on a directory whose record says `state`, and expect `heading` without reset. */
    const withheld = (options: {
      readonly heading: string;
      readonly reason: string;
      readonly keys: "supplied" | "file" | "unreachable-store";
      readonly state: "ready" | "file";
      readonly env?: Readonly<Record<string, string>>;
      readonly screenshot?: string;
    }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { home, data, env } = yield* desktopHome({ keys: options.keys });
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
          yield* refusedOnce(data, options.reason);
          expect(yield* fs.readFileString(path.join(data, "installation.json"))).toBe(record);
          expect(yield* fs.exists(path.join(data, "keys.json"))).toBe(false);
        }),
      );

    // Key settings that cannot apply to existing data must be changed, not reset away:
    // supplied keys on a directory that saves its own, and a key storage it does not use.
    yield* withheld({
      heading: "Executor's key settings do not match its data",
      reason: "misconfigured",
      keys: "supplied",
      state: "ready",
      screenshot: "recovery-misconfigured",
    });
    yield* withheld({
      heading: "Executor's key settings do not match its data",
      reason: "misconfigured",
      keys: "file",
      state: "ready",
    });

    // An EXECUTOR_KEY_STORAGE the server cannot use is refused before anything is created, set in
    // the desktop's environment or saved with `executor service set env`, which the servers a
    // client starts run with. It is fixed by changing the setting, never by a reset.
    for (const saved of [false, true])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { home, data, env, cli } = yield* desktopHome({ keys: "file" });
          if (saved) {
            const set = yield* cli.run(
              ["service", "set", "env", "EXECUTOR_KEY_STORAGE", "keyring"],
              {},
              { source: true },
            );
            expect(set.code, set.stderr).toBe(0);
          }
          const electron = yield* launchDesktop({
            cwd: home,
            env: saved ? env : { ...env, EXECUTOR_KEY_STORAGE: "keyring" },
          });
          const page = yield* driver("desktop window", () => electron.firstWindow());
          yield* recoveryHeading(page, "Executor's key settings do not match its data");
          expect(
            yield* driver("recovery actions", () => page.getByRole("button").allTextContents()),
          ).toEqual(noReset);
          yield* refusedOnce(data, "misconfigured");
          const [refused] = yield* eventsNamed(data, "Background Executor could not start", 1);
          expect(refused?.annotations.detail).toContain(
            'EXECUTOR_KEY_STORAGE must be "file" (keep keys in keys.json) or "os" (OS credential store only), or unset.',
          );
          // The data directory holds only the desktop's own log, and the saved setting.
          expect((yield* fs.readDirectory(data)).toSorted()).toEqual(
            saved ? ["diagnostics", "service.json"] : ["diagnostics"],
          );
          expect(yield* fs.readDirectory(path.join(data, "diagnostics"))).toEqual([
            "executor-desktop.jsonl",
          ]);
        }),
      );

    // The data may be intact behind a store that is absent or refuses access, so it is never
    // offered for reset. The harness makes the store absent on Linux and refusing on macOS.
    if (process.platform === "win32") return;
    yield* withheld(
      process.platform === "darwin"
        ? {
            heading: "Executor needs access to your keychain",
            reason: "credential-denied",
            keys: "unreachable-store",
            state: "ready",
            screenshot: "recovery-credential-denied",
          }
        : {
            heading: "Executor cannot open the OS credential store",
            reason: "credential-unavailable",
            keys: "unreachable-store",
            state: "ready",
            screenshot: "recovery-credential-unavailable",
          },
    );
  }).pipe(Effect.provide(services)),
);
