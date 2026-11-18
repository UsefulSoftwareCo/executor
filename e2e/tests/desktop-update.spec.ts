/**
 * The desktop app's own update path, from its updater's feed to its restart, on a development
 * build of the desktop (`node apps/local/desktop/scripts/build.mjs`) on macOS. The scenario serves
 * the feed from a loopback server and names it with EXECUTOR_DESKTOP_DEV_UPDATE_CONFIG, which a
 * release build does not contain. electron-updater downloads and verifies each version as it would from
 * the release feed; only Squirrel.Mac, which installs the download and refuses an app that is not
 * Executor's signed one, is played by the scenario through Electron's `autoUpdater`, which records
 * the install it is asked for and ends the desktop as Squirrel.Mac would.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, FileSystem, Layer, Path, Schedule } from "effect";
import { FetchHttpClient } from "effect/http";
import type { ElectronApplication, Page } from "playwright";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { driver } from "../support/platform.ts";
import { localNpmRegistry } from "../support/npm-registry.ts";
import { freePort } from "../support/ports.ts";
import {
  answerDialogs,
  answeredDialogs,
  clickMenuItem,
  launchDesktop,
  menuLabels,
  runnerSession,
  stopBackgroundServers,
} from "../support/desktop.ts";
import { scenarios } from "../test-plan.ts";

/** What the feed offers: a version, and whether its download's bytes fail verification. */
interface Offer {
  readonly version: string;
  readonly corrupt: boolean;
}

/**
 * A generic electron-updater feed on loopback that offers `offer.version`. The update's file is
 * random bytes the feed lists with their SHA-512, or, when the offer is corrupt, other bytes of
 * the same size, so electron-updater's verification of the download fails.
 */
const updateFeed = Effect.gen(function* () {
  const port = yield* freePort;
  let offer:
    | { readonly version: string; readonly listed: Buffer; readonly served: Buffer }
    | undefined;
  const file = (version: string) => `Executor-${version}-mac-arm64.zip`;
  yield* Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>>((resume) => {
      const created = createServer((request, response) => {
        const name = new URL(request.url ?? "/", "http://127.0.0.1").pathname.slice(1);
        if (name === "latest-mac.yml" && offer !== undefined) {
          const bytes = offer.listed;
          const sha512 = createHash("sha512").update(bytes).digest("base64");
          response.writeHead(200, { "content-type": "text/yaml" });
          response.end(
            [
              `version: ${offer.version}`,
              "files:",
              `  - url: ${file(offer.version)}`,
              `    sha512: ${sha512}`,
              `    size: ${bytes.length}`,
              `path: ${file(offer.version)}`,
              `sha512: ${sha512}`,
              `releaseDate: '2026-11-17T00:00:00.000Z'`,
              "",
            ].join("\n"),
          );
          return;
        }
        const bytes =
          offer !== undefined && name === file(offer.version) ? offer.served : undefined;
        if (bytes === undefined) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, {
          "content-type": "application/zip",
          "content-length": bytes.length,
        });
        response.end(bytes);
      });
      created.listen(port, "127.0.0.1", () => resume(Effect.succeed(created)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );
  return {
    url: `http://127.0.0.1:${port}/`,
    offer: (next: Offer) =>
      Effect.sync(() => {
        const listed = randomBytes(64 * 1024);
        offer = {
          version: next.version,
          listed,
          served: next.corrupt ? randomBytes(listed.length) : listed,
        };
      }),
  };
});

/**
 * Play Squirrel.Mac in the desktop's main process: it accepts electron-updater's download as
 * fetched and, asked to install, writes `marker` and ends the desktop as an install does.
 */
const standInForSquirrel = (electron: ElectronApplication, marker: string) =>
  driver("stand in for Squirrel.Mac", () =>
    electron.evaluate(({ app, autoUpdater }, marker) => {
      const fs = process.getBuiltinModule("node:fs");
      Object.assign(autoUpdater, {
        setFeedURL: () => undefined,
        checkForUpdates: () =>
          void setImmediate(() =>
            autoUpdater.emit("update-downloaded", {}, "", "", new Date(), ""),
          ),
        quitAndInstall: () => {
          fs.writeFileSync(marker, "installed");
          app.exit(0);
        },
      });
    }, marker),
  );

const sidebar = (page: Page) => page.locator("aside.sidebar");
const restartLink = (page: Page, version: string) =>
  sidebar(page).getByRole("link", { name: `Restart Executor to install v${version}` });

/** The sidebar block's lines of text, top to bottom. */
const blockLines = (page: Page) =>
  driver("read the sidebar's update block", () =>
    sidebar(page)
      .locator(".sidebar-update")
      .innerText()
      .then((text) => text.split("\n").filter((line) => line.trim() !== "")),
  );

/** Resize the desktop's window. */
const resizeWindow = (electron: ElectronApplication, width: number, height: number) =>
  driver(`resize the window to ${width}x${height}`, () =>
    electron.evaluate(
      ({ BrowserWindow }, [width, height]) => {
        const window = BrowserWindow.getAllWindows().find((each) => each.isVisible());
        window?.setContentSize(width!, height!);
      },
      [width, height],
    ),
  );

const dashboard = (page: Page) =>
  driver("dashboard is visible", () =>
    page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible", timeout: 60_000 }),
  );

/** The labels of the Updates menu, once `ready` says they are what the scenario waits for. */
const updatesMenu = (electron: ElectronApplication, ready: (labels: Array<string>) => boolean) =>
  menuLabels(electron, "Updates").pipe(
    Effect.flatMap((labels) =>
      ready(labels)
        ? Effect.succeed(labels)
        : Effect.fail(new Error(`The Updates menu is ${JSON.stringify(labels)}`)),
    ),
    Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 300 }),
  );

/** Wait for a native message box whose message starts with `message`. */
const dialogShown = (electron: ElectronApplication, message: string) =>
  answeredDialogs(electron).pipe(
    Effect.flatMap((boxes) =>
      boxes?.some((box) => box.message.startsWith(message)) === true
        ? Effect.succeed(boxes)
        : Effect.fail(new Error(`No dialog said ${message}`)),
    ),
    Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 300 }),
  );

/** Wait until the Squirrel.Mac stand-in wrote `marker`, as it does when asked to install. */
const installed = (marker: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(marker);
  }).pipe(Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 300 }));

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

it.live(scenarios.desktopUpdate.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      // A stand-in for Squirrel.Mac only means something on macOS, and a release build does not
      // contain the setting that names the feed the scenario serves.
      if (process.platform !== "darwin")
        return yield* Effect.fail(
          new Error("The desktop update scenario stands in for Squirrel.Mac, so it runs on macOS."),
        );
      if (process.env.EXECUTOR_E2E_DESKTOP_EXECUTABLE !== undefined)
        return yield* Effect.fail(
          new Error(
            "The desktop update scenario runs a development build, whose updater reads the feed it serves; unset EXECUTOR_E2E_DESKTOP_EXECUTABLE.",
          ),
        );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "executor-desktop-update-" });
      const data = path.join(home, "data");
      const feed = yield* updateFeed;
      const config = path.join(home, "app-update.yml");
      yield* fs.writeFileString(
        config,
        `provider: generic\nurl: ${feed.url}\nchannel: latest\nupdaterCacheDirName: executor-desktop-update-e2e\n`,
      );
      const registry = yield* localNpmRegistry;
      // macOS has no variable for its cache directory, where the updater downloads, only the
      // home it is in.
      const env: Record<string, string> = {
        ...runnerSession(),
        DO_NOT_TRACK: "1",
        EXECUTOR_NO_UPDATE_CHECK: "1",
        PATH: process.env.PATH ?? "",
        HOME: path.join(home, "cache-home"),
        EXECUTOR_PORT: String(yield* freePort),
        EXECUTOR_DESKTOP_DATA_DIR: data,
        EXECUTOR_DESKTOP_PROFILE_DIR: path.join(home, "profile"),
        EXECUTOR_DESKTOP_DEV_UPDATE_CONFIG: config,
        EXECUTOR_NPM_REGISTRY: registry.url,
        EXECUTOR_API_KEY: randomBytes(32).toString("hex"),
        EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      };
      yield* Effect.addFinalizer(() => stopBackgroundServers(data, () => []));

      // The first check, shortly after the desktop starts, downloads the version the feed offers.
      // Once it is ready the sidebar offers its restart, and so does the Updates menu, for
      // someone who keeps no window open.
      yield* feed.offer({ version: "2.0.0-beta.122", corrupt: false });
      const first = path.join(home, "installed-from-menu");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const electron = yield* launchDesktop({ cwd: home, env });
          yield* standInForSquirrel(electron, first);
          yield* answerDialogs(electron, {});
          const page = yield* driver("desktop window", () => electron.firstWindow());
          yield* dashboard(page);
          yield* driver("the first update is ready in the sidebar", () =>
            restartLink(page, "2.0.0-beta.122").waitFor({ timeout: 60_000 }),
          );
          expect(yield* blockLines(page)).toEqual([
            "Update ready",
            "Version 2.0.0-beta.122 is ready to install.",
            "Restart to update",
          ]);
          expect(yield* updatesMenu(electron, (labels) => labels.length === 2)).toEqual([
            "Restart to update (v2.0.0-beta.122)",
            "Check for updates…",
          ]);

          // A newer version whose download fails verification leaves nothing to restart into:
          // the block and the menu's restart go, and the menu's check says it failed.
          yield* feed.offer({ version: "2.0.0-beta.123", corrupt: true });
          yield* clickMenuItem(electron, "Updates", "Check for updates…");
          yield* dialogShown(electron, "The update could not be completed.");
          yield* driver("the block goes", () =>
            sidebar(page).locator(".sidebar-update").waitFor({ state: "detached" }),
          );
          expect(yield* updatesMenu(electron, (labels) => labels.length === 1)).toEqual([
            "Check for updates…",
          ]);
          expect(
            yield* driver("read the announcement", () =>
              page.locator(".desktop-update-announcement").innerText(),
            ),
          ).toBe("");

          // Checking again downloads it whole. The menu's check offers the restart in a dialog,
          // which is declined here; the block and the menu keep offering it with the long version.
          yield* feed.offer({ version: "2.0.0-beta.123", corrupt: false });
          yield* clickMenuItem(electron, "Updates", "Check for updates…");
          yield* dialogShown(electron, "Executor 2 2.0.0-beta.123 is ready to install.");
          yield* driver("the newer update is ready in the sidebar", () =>
            restartLink(page, "2.0.0-beta.123").waitFor({ timeout: 60_000 }),
          );
          expect(
            yield* driver("read the announcement", () =>
              page.locator(".desktop-update-announcement").innerText(),
            ),
          ).toBe("Update ready: Executor v2.0.0-beta.123. Restart Executor to install it.");
          expect(yield* blockLines(page)).toEqual([
            "Update ready",
            "Version 2.0.0-beta.123 is ready to install.",
            "Restart to update",
          ]);
          yield* screenshot(page, "desktop-update-ready");
          expect(yield* updatesMenu(electron, (labels) => labels.length === 2)).toEqual([
            "Restart to update (v2.0.0-beta.123)",
            "Check for updates…",
          ]);

          // The shortest window still shows the block and its restart, in place of the resource
          // links, and the Updates menu keeps offering the same restart.
          yield* resizeWindow(electron, 1180, 540);
          yield* driver("the window is 540 px tall", () =>
            page.waitForFunction(() => window.innerHeight === 540),
          );
          expect(
            yield* driver("read the short window's sidebar", () =>
              Promise.all([
                restartLink(page, "2.0.0-beta.123").isVisible(),
                sidebar(page).getByRole("link", { name: "Docs", exact: true }).count(),
              ]),
            ),
          ).toEqual([true, 0]);
          expect(yield* updatesMenu(electron, (labels) => labels.length === 2)).toEqual([
            "Restart to update (v2.0.0-beta.123)",
            "Check for updates…",
          ]);
          yield* screenshot(page, "desktop-update-short-window");

          // The menu's restart installs it, as the block's link does.
          yield* clickMenuItem(electron, "Updates", "Restart to update (v2.0.0-beta.123)");
          expect(yield* installed(first)).toBe("installed");
        }),
      );

      // A restart that did not install, as here, leaves the update to the next start's check,
      // which makes it ready again; the block's link, which the desktop intercepts, installs it.
      const second = path.join(home, "installed-from-sidebar");
      const electron = yield* launchDesktop({ cwd: home, env });
      yield* standInForSquirrel(electron, second);
      const page = yield* driver("desktop window", () => electron.firstWindow());
      yield* dashboard(page);
      yield* driver("press the block's restart link", () =>
        restartLink(page, "2.0.0-beta.123")
          .waitFor({ timeout: 60_000 })
          .then(() => restartLink(page, "2.0.0-beta.123").click()),
      );
      expect(yield* installed(second)).toBe("installed");
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
);
