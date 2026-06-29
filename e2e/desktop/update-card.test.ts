// Desktop-only: the desktop app updates via electron-updater (a new bundle,
// swapped in place), NOT `npm i -g`, so its sidebar must show a native
// "Restart to update" action instead of the copyable npm command the web/CLI
// shell shows. A packaged build is required for a real electron-updater
// release, so `EXECUTOR_DESKTOP_FAKE_UPDATE` seeds a "downloaded" status the
// main process pushes to the renderer over IPC (see apps/desktop/src/shared/
// update.ts). Launches the REAL Electron app via Playwright against a throwaway
// HOME (same harness as the other desktop scenarios).
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { _electron, type ElectronApplication } from "playwright";

import { scenario } from "../src/scenario";
import { RunDir } from "../src/services";

const appDir = fileURLToPath(new URL("../../apps/desktop/", import.meta.url));
const electronBinary = createRequire(join(appDir, "package.json"))("electron") as string;

const FORCED_VERSION = "99.0.0";

const launchDesktop = (home: string): Promise<ElectronApplication> =>
  _electron.launch({
    executablePath: electronBinary,
    args: [appDir],
    cwd: appDir,
    env: {
      ...process.env,
      HOME: home,
      // Dev seam: stand in for a downloaded electron-updater release.
      EXECUTOR_DESKTOP_FAKE_UPDATE: JSON.stringify({
        state: "downloaded",
        version: FORCED_VERSION,
      }),
    },
    timeout: 120_000,
  });

scenario(
  "Desktop · the sidebar shows a native restart-to-update card, not the npm command",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const runDir = yield* RunDir;
    yield* Effect.promise(() => run(runDir));
  }),
);

const run = async (runDir: string) => {
  const home = mkdtempSync(join(tmpdir(), "executor-update-desktop-"));
  const app = await launchDesktop(home);
  try {
    const page = await app.firstWindow({ timeout: 120_000 });
    await page.waitForLoadState("domcontentloaded");
    await page.locator("aside.desktop-macos-sidebar").waitFor({ timeout: 90_000 });

    // The desktop-native card: the available version and a Restart action — and
    // crucially NOT the npm command the web/CLI card carries.
    await page.getByText("Update available").waitFor({ timeout: 60_000 });
    await page.getByText(`v${FORCED_VERSION}`).waitFor({ timeout: 10_000 });
    const restart = page.getByRole("button", { name: "Restart to update" });
    await restart.waitFor({ timeout: 10_000 });
    expect(
      await page.getByText("npm i -g", { exact: false }).count(),
      "the desktop card shows no npm command",
    ).toBe(0);
    await page.screenshot({ path: join(runDir, "01-desktop-update-card.png") });

    // Clicking Restart drives the install IPC. Outside a packaged build that
    // reflects "installing" rather than quitting (the real quitAndInstall only
    // runs packaged), so the wiring is provable without tearing the app down.
    await restart.click();
    await page.getByText("Restarting…").waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(runDir, "02-restarting.png") });
  } finally {
    await app.close().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
};
