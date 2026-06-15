// Desktop-only: proves the *telemetry* contract around a dying sidecar — the
// distinction the on-screen crash flow can't show, because a clean shutdown and
// a hard kill paint the SAME recovery screen. The only observable difference is
// what reaches Sentry, so this launches the real Electron app pointed at a local
// Sentry envelope sink (via the non-packaged EXECUTOR_DESKTOP_SENTRY_DSN seam)
// and asserts:
//   - SIGKILL (hard kill)  → a "Sidecar exited unexpectedly" crash IS reported
//   - SIGINT  (clean stop) → the recovery screen shows but NOTHING is reported
//
// The negative is made conclusive with a fence: a second SIGKILL after the
// SIGINT. Sentry's transport is FIFO per client, so once the fence's crash
// envelope has arrived, any envelope the SIGINT would have produced (enqueued
// earlier) must already be present too — its absence is real, not just slow.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { _electron } from "playwright";

import { scenario } from "../src/scenario";
import { RunDir } from "../src/services";

const appDir = fileURLToPath(new URL("../../apps/desktop/", import.meta.url));
const electronBinary = createRequire(join(appDir, "package.json"))("electron") as string;

const SIDECAR_CRASH_MESSAGE = "Sidecar exited unexpectedly";

scenario(
  "Desktop · a clean sidecar shutdown recovers without a crash report",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const runDir = yield* RunDir;
    yield* Effect.promise(() => run(runDir));
  }),
);

/** Minimal Sentry ingest: every POSTed envelope body (gunzipped) is buffered. */
const startSentrySink = async (): Promise<{
  server: Server;
  dsn: string;
  envelopes: string[];
}> => {
  const envelopes: string[] = [];
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: tolerate a non-gzip body rather than dropping the envelope
        try {
          body = gunzipSync(body);
        } catch {
          // fall through with the raw bytes
        }
      }
      envelopes.push(body.toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "e2e" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  // DSN shape: http://<publicKey>@<host>/<projectId> — the SDK POSTs envelopes
  // to http://<host>/api/<projectId>/envelope/, which the sink accepts wholesale.
  return { server, dsn: `http://e2e@127.0.0.1:${port}/1`, envelopes };
};

const run = async (runDir: string) => {
  const { server: sink, dsn, envelopes } = await startSentrySink();
  const home = mkdtempSync(join(tmpdir(), "executor-desktop-sentry-e2e-"));
  const videoTmp = join(runDir, ".video-tmp");
  let stepIndex = 0;

  const crashReports = () => envelopes.filter((e) => e.includes(SIDECAR_CRASH_MESSAGE));
  const sigkillReports = () =>
    crashReports().filter((e) => e.includes(`${SIDECAR_CRASH_MESSAGE} (code=null signal=SIGKILL)`));

  const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 60_000) => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for ${label}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  const app = await _electron.launch({
    executablePath: electronBinary,
    args: [appDir],
    cwd: appDir,
    // EXECUTOR_DESKTOP_SENTRY_DSN turns on main-process crash reporting in the
    // non-packaged build and routes it at the sink. HOME isolates a fresh data
    // dir from any real install on this machine.
    env: { ...process.env, HOME: home, EXECUTOR_DESKTOP_SENTRY_DSN: dsn },
    recordVideo: { dir: videoTmp, size: { width: 1280, height: 800 } },
    timeout: 120_000,
  });

  const manifestPath = join(home, ".executor/server-control/server.json");
  const sidecarPid = (): number => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { pid: number };
    expect(manifest.pid, "sidecar pid recorded in the server manifest").toBeGreaterThan(0);
    return manifest.pid;
  };

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

    // SIGKILL #1 — the report path. Establishes that the sink works and a hard
    // kill IS reported, which also calibrates that envelopes arrive in time.
    await step("a hard kill (SIGKILL) is reported as a crash", async () => {
      process.kill(sidecarPid(), "SIGKILL");
      await page.getByText("stopped unexpectedly").waitFor({ timeout: 30_000 });
      await waitFor(() => sigkillReports().length >= 1, "the first SIGKILL crash report");
    });

    await step("restart heals the app", async () => {
      await page.locator("#restart").click();
      await page.getByText("Settings").first().waitFor({ timeout: 120_000 });
    });

    // SIGINT — the clean-shutdown path. The dev sidecar handles SIGINT and exits
    // 0; the app surfaces the SAME recovery screen, but this must NOT be reported.
    await step("a clean stop (SIGINT) shows recovery but is not reported", async () => {
      process.kill(sidecarPid(), "SIGINT");
      await page.getByText("stopped unexpectedly").waitFor({ timeout: 30_000 });
    });

    await step("restart heals the app again", async () => {
      await page.locator("#restart").click();
      await page.getByText("Settings").first().waitFor({ timeout: 120_000 });
    });

    // SIGKILL #2 — the fence. Once its crash envelope has landed, FIFO ordering
    // guarantees any envelope the SIGINT would have produced is already here.
    await step("fence: a second hard kill is reported", async () => {
      process.kill(sidecarPid(), "SIGKILL");
      await page.getByText("stopped unexpectedly").waitFor({ timeout: 30_000 });
      await waitFor(() => sigkillReports().length >= 2, "the fence SIGKILL crash report");
    });

    // The verdict: every sidecar-exit crash reported was a SIGKILL — the SIGINT
    // in between contributed nothing.
    const reports = crashReports();
    expect(
      reports.length,
      `only the two SIGKILLs were reported, got: ${JSON.stringify(reports.map(firstLine))}`,
    ).toBe(2);
    expect(
      reports.every((e) => e.includes("signal=SIGKILL")),
      "no clean SIGINT shutdown (code=0 / signal=null) was reported as a crash",
    ).toBe(true);
  } finally {
    const page = app.windows()[0];
    const video = page?.video();
    await app.close().catch(() => {});
    await new Promise<void>((resolve) => sink.close(() => resolve()));
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

const firstLine = (envelope: string): string => {
  const match = envelope.match(new RegExp(`${SIDECAR_CRASH_MESSAGE}[^"\\\\]*`));
  return match ? match[0] : envelope.slice(0, 80);
};
