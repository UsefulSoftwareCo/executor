// Desktop-only: the sidecar-crash recovery flow, on camera. Launches the
// real Electron app against a throwaway HOME, waits for the web console,
// SIGKILLs the sidecar out from under it, asserts the in-window crash
// screen appears, then recovers via its "Restart server" button. The
// recording (session.mp4 + per-step screenshots) is the artifact a reviewer
// watches; the waits are the assertions — each one times out (fails) if the
// screen it describes never shows up.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { _electron } from "playwright";

import { scenario } from "../src/scenario";
import { RunDir } from "../src/services";

const appDir = fileURLToPath(new URL("../../apps/desktop/", import.meta.url));

// require("electron") resolves to the binary path (electron's index.js
// exports it) — resolved from apps/desktop so we get the app's pinned
// version out of the workspace store.
const electronBinary = createRequire(join(appDir, "package.json"))("electron") as string;

scenario(
  "Desktop · sidecar crash shows the recovery screen and restart heals it",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const runDir = yield* RunDir;
    yield* Effect.promise(() => run(runDir));
  }),
);

const run = async (runDir: string) => {
  // Throwaway HOME = fresh ~/.executor data dir, fresh electron-store
  // settings, no collision with a real desktop install on this machine.
  const home = mkdtempSync(join(tmpdir(), "executor-desktop-e2e-"));
  const videoTmp = join(runDir, ".video-tmp");
  let stepIndex = 0;

  const app = await _electron.launch({
    executablePath: electronBinary,
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, HOME: home },
    recordVideo: { dir: videoTmp, size: { width: 1280, height: 800 } },
    timeout: 120_000,
  });

  try {
    // firstWindow resolves only after the sidecar boots (the window is
    // created with the server's URL) — this wait IS the boot assertion.
    const page = await app.firstWindow({ timeout: 120_000 });
    const step = async (label: string, body: () => Promise<void>) => {
      await body();
      stepIndex += 1;
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      await page.screenshot({
        path: join(runDir, `${String(stepIndex).padStart(2, "0")}-${slug}.png`),
      });
    };

    await step("app boots into the web console", async () => {
      await page.getByText("Settings").first().waitFor({ timeout: 120_000 });
    });

    let sidecarPid = 0;
    await step("the local server is killed (SIGKILL)", async () => {
      const manifestPath = join(home, ".executor/server-control/server.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { pid: number };
      sidecarPid = manifest.pid;
      expect(sidecarPid, "sidecar pid recorded in the server manifest").toBeGreaterThan(0);
      process.kill(sidecarPid, "SIGKILL");
      await page.getByText("stopped unexpectedly").waitFor({ timeout: 30_000 });
    });

    await step("crash screen offers restart, update, and diagnostics", async () => {
      await page.locator("#restart").waitFor({ timeout: 5_000 });
      await page.locator("#update").waitFor({ timeout: 5_000 });
      await page.locator("#export").waitFor({ timeout: 5_000 });
    });

    await step("restart server heals the app", async () => {
      await page.locator("#restart").click();
      await page.getByText("Settings").first().waitFor({ timeout: 120_000 });
    });

    const healedManifest = JSON.parse(
      readFileSync(join(home, ".executor/server-control/server.json"), "utf8"),
    ) as { pid: number };
    expect(healedManifest.pid, "restarted sidecar is a new process").not.toBe(sidecarPid);
  } finally {
    const page = app.windows()[0];
    const video = page?.video();
    await app.close().catch(() => {});
    const recordedPath = await video?.path().catch(() => undefined);
    if (recordedPath && existsSync(recordedPath)) {
      // mp4 plays everywhere (Safari/iOS don't do webm) — same treatment as
      // the browser surface.
      await promisify(execFile)("ffmpeg", [
        "-y",
        "-i",
        recordedPath,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "26",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        join(runDir, "session.mp4"),
      ]).catch(() => {});
    }
    rmSync(videoTmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
};
