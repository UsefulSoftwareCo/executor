// Desktop-only: the damaged-data recovery path, on camera. Boots the app
// once to create real state, kills the sidecar and corrupts data.db so a
// restart cannot succeed, then recovers via the crash screen's "Reset data"
// link (EXECUTOR_TEST_AUTO_CONFIRM_RESET=1 stands in for the native confirm
// dialog, which Playwright can't reach). Asserts the reset is backup-then-
// move: the corrupted bytes must be in ~/.executor/backups/, not gone.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const electronBinary = createRequire(join(appDir, "package.json"))("electron") as string;

const CORRUPT_MARKER = "executor-e2e-corrupted-db";

scenario(
  "Desktop · reset data recovers from a damaged database, backing it up first",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const runDir = yield* RunDir;
    yield* Effect.promise(() => run(runDir));
  }),
);

const run = async (runDir: string) => {
  const home = mkdtempSync(join(tmpdir(), "executor-desktop-e2e-reset-"));
  const videoTmp = join(runDir, ".video-tmp");
  let stepIndex = 0;

  const app = await _electron.launch({
    executablePath: electronBinary,
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, HOME: home, EXECUTOR_TEST_AUTO_CONFIRM_RESET: "1" },
    recordVideo: { dir: videoTmp, size: { width: 1280, height: 800 } },
    timeout: 120_000,
  });

  try {
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

    await step("the database is corrupted and the server killed", async () => {
      const manifest = JSON.parse(
        readFileSync(join(home, ".executor/server-control/server.json"), "utf8"),
      ) as { pid: number };
      // Corrupt first so the sidecar can never come back on its own, then
      // kill it to bring up the crash screen.
      writeFileSync(join(home, ".executor/data.db"), CORRUPT_MARKER);
      rmSync(join(home, ".executor/data.db-wal"), { force: true });
      rmSync(join(home, ".executor/data.db-shm"), { force: true });
      process.kill(manifest.pid, "SIGKILL");
      await page.getByText("stopped unexpectedly").waitFor({ timeout: 30_000 });
    });

    await step("restart alone cannot heal a damaged database", async () => {
      await page.locator("#restart").click();
      await page.getByText("Restart failed").waitFor({ timeout: 60_000 });
    });

    await step("reset data backs the state up and heals the app", async () => {
      await page.locator("#reset").click();
      await page.getByText("Settings").first().waitFor({ timeout: 120_000 });
    });

    // Backup-then-move, never delete: the corrupted bytes must live on in
    // ~/.executor/backups/<stamp>/data.db, and the live db must be fresh.
    const backupsDir = join(home, ".executor/backups");
    const stamps = readdirSync(backupsDir);
    expect(stamps.length, "exactly one backup created").toBe(1);
    const backedUp = readFileSync(join(backupsDir, stamps[0] ?? "", "data.db"), "utf8");
    expect(backedUp, "backup holds the pre-reset (corrupted) database").toBe(CORRUPT_MARKER);
    const liveDb = readFileSync(join(home, ".executor/data.db"));
    expect(liveDb.subarray(0, 6).toString(), "live database is a real SQLite file").toBe("SQLite");
  } finally {
    const page = app.windows()[0];
    const video = page?.video();
    await app.close().catch(() => {});
    const recordedPath = await video?.path().catch(() => undefined);
    if (recordedPath && existsSync(recordedPath)) {
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
