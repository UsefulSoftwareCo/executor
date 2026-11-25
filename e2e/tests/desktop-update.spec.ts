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

interface Offer {
  readonly version: string;
  readonly corrupt: boolean;
  readonly notes?: ReadonlyArray<{ readonly version: string; readonly note: string | null }>;
  readonly since?: string;
}

const updateFeed = Effect.gen(function* () {
  const port = yield* freePort;
  let offer:
    | {
        readonly version: string;
        readonly listed: Buffer;
        readonly served: Buffer;
        readonly notes?: Offer["notes"];
        readonly since?: Offer["since"];
      }
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
              ...(offer.notes === undefined
                ? []
                : [
                    "releaseNotes:",
                    ...offer.notes.flatMap((entry) => [
                      `  - version: ${entry.version}`,
                      `    note: ${JSON.stringify(entry.note)}`,
                    ]),
                  ]),
              ...(offer.since === undefined ? [] : [`releaseNotesSince: ${offer.since}`]),
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
          notes: next.notes,
          since: next.since,
        };
      }),
  };
});

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

const blockLines = (page: Page) =>
  driver("read the sidebar's update block", () =>
    sidebar(page)
      .locator(".sidebar-update")
      .innerText()
      .then((text) => text.split("\n").filter((line) => line.trim() !== "")),
  );

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

const updatesMenu = (electron: ElectronApplication, ready: (labels: Array<string>) => boolean) =>
  menuLabels(electron, "Updates").pipe(
    Effect.flatMap((labels) =>
      ready(labels)
        ? Effect.succeed(labels)
        : Effect.fail(new Error(`The Updates menu is ${JSON.stringify(labels)}`)),
    ),
    Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 300 }),
  );

const dialogShown = (electron: ElectronApplication, message: string) =>
  answeredDialogs(electron).pipe(
    Effect.flatMap((boxes) =>
      boxes?.some((box) => box.message.startsWith(message)) === true
        ? Effect.succeed(boxes)
        : Effect.fail(new Error(`No dialog said ${message}`)),
    ),
    Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 300 }),
  );

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

          yield* feed.offer({
            version: "2.0.0-beta.123",
            corrupt: false,
            notes: [
              { version: "2.0.0-beta.124", note: "Not offered yet." },
              {
                version: "2.0.0-beta.123",
                note: 'Apps open from the sidebar.\n<img src=x onerror="document.title=1">\nThe desktop app restarts faster.',
              },
              { version: "2.0.0-beta.122", note: null },
            ],
            since: "2.0.0-beta.121",
          });
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
            "v2.0.0-beta.123 Apps open from the sidebar.",
            "Restart to update",
          ]);
          expect(
            yield* driver("read the update the desktop sent", () =>
              page.evaluate(
                () =>
                  JSON.parse(document.documentElement.getAttribute("data-desktop-update") ?? "{}")
                    .releasesSince,
              ),
            ),
          ).toBe("2.0.0-beta.121");
          yield* screenshot(page, "desktop-update-ready");
          yield* driver("open the notes", () =>
            sidebar(page)
              .getByRole("button", { name: "See what's new in v2.0.0-beta.123" })
              .click(),
          );
          const notes = page.getByRole("dialog", { name: "What's new in v2.0.0-beta.123" });
          expect(
            yield* driver("read the notes", () =>
              notes.evaluate((element) =>
                [...element.querySelectorAll(".release-notes-release")].map((release) => [
                  release.querySelector("h3")?.textContent,
                  ...[...release.querySelectorAll("li, p")].map((item) => item.textContent),
                ]),
              ),
            ),
          ).toEqual([
            ["v2.0.0-beta.123", "Apps open from the sidebar.", "The desktop app restarts faster."],
            ["v2.0.0-beta.122", "No changes were listed for this release."],
          ]);
          expect(yield* driver("count images", () => notes.locator("img").count())).toBe(0);
          yield* screenshot(page, "desktop-update-notes");
          yield* driver("close the notes", () =>
            page.keyboard.press("Escape").then(() => notes.waitFor({ state: "detached" })),
          );
          expect(yield* updatesMenu(electron, (labels) => labels.length === 2)).toEqual([
            "Restart to update (v2.0.0-beta.123)",
            "Check for updates…",
          ]);

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

          yield* clickMenuItem(electron, "Updates", "Restart to update (v2.0.0-beta.123)");
          expect(yield* installed(first)).toBe("installed");
        }),
      );

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
