// Packaged desktop supervised-daemon regressions. These run against the real
// electron-builder bundle and its compiled sidecar because the supervised attach
// path is production-only (`app.isPackaged`).
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { _electron, type ElectronApplication } from "playwright";
import {
  normalizeExecutorServerConnection,
  serializeExecutorLocalServerManifest,
} from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { RunDir } from "../src/services";
import { waitForHttp } from "../setup/boot";

interface PackagedExecutorBridge {
  readonly getSettings: () => Promise<{ readonly port: number }>;
  readonly updateSettings: (patch: { readonly port: number }) => Promise<unknown>;
  readonly restartServer: () => Promise<unknown>;
  readonly getServerConnection: () => Promise<{ readonly origin: string } | null>;
}

declare global {
  interface Window {
    readonly executor: PackagedExecutorBridge;
  }
}

const appExe = process.env.E2E_DESKTOP_APP_EXE;
const sidecarBin = process.env.E2E_DESKTOP_SIDECAR_BIN;
const clientDir = sidecarBin ? join(dirname(dirname(sidecarBin)), "web-ui") : "";

const guiAvailable = (): boolean => {
  if (process.platform === "darwin") {
    try {
      return execFileSync("launchctl", ["managername"], { encoding: "utf8" }).trim() === "Aqua";
    } catch {
      return false;
    }
  }
  if (process.platform === "linux")
    return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  return true;
};

const packagedSingleInstanceAvailable = (): boolean => {
  if (process.platform !== "darwin" || !appExe) return true;
  try {
    const lines = execFileSync("pgrep", ["-fl", "Executor.app/Contents/MacOS/Executor"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    return !lines.some((line) => !line.includes(appExe));
  } catch {
    return true;
  }
};

const requireBundle = (): { readonly app: string; readonly sidecar: string } => {
  if (!appExe || !sidecarBin) {
    throw new Error(
      "E2E_DESKTOP_APP_EXE / E2E_DESKTOP_SIDECAR_BIN not set — did desktop-packaged.globalsetup run?",
    );
  }
  return { app: appExe, sidecar: sidecarBin };
};

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });

interface DaemonStart {
  readonly child: ChildProcess;
  readonly ready: boolean;
  readonly stderr: string;
}

const startSupervisedDaemon = (env: NodeJS.ProcessEnv): Promise<DaemonStart> =>
  new Promise((resolve) => {
    const { sidecar } = requireBundle();
    const child = spawn(sidecar, [], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let settled = false;
    const settle = (ready: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ child, ready, stderr });
    };
    const timer = setTimeout(() => settle(false), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("EXECUTOR_READY:")) {
        clearTimeout(timer);
        settle(true);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("exit", () => {
      clearTimeout(timer);
      settle(false);
    });
  });

const closeWithVideo = async (
  app: ElectronApplication | undefined,
  runDir: string,
  videoTmp: string,
) => {
  const page = app?.windows()[0];
  const video = page?.video();
  await app?.close().catch(() => {});
  const recordedPath = await video?.path().catch(() => undefined);
  if (recordedPath) {
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
};

scenario(
  "Desktop packaged supervised daemon · server manifest is owner-only",
  { timeout: 180_000 },
  Effect.promise(async () => {
    requireBundle();
    const home = mkdtempSync(join(tmpdir(), "executor-pkg-manifest-mode-"));
    const dataDir = join(home, ".executor");
    const manifestPath = join(dataDir, "server-control", "server.json");
    const port = await freePort();
    let daemon: ChildProcess | undefined;
    const previousUmask = process.umask(0o022);
    try {
      const started = await startSupervisedDaemon({
        ...process.env,
        HOME: home,
        EXECUTOR_SUPERVISED: "1",
        EXECUTOR_DATA_DIR: dataDir,
        EXECUTOR_PORT: String(port),
        EXECUTOR_HOST: "127.0.0.1",
        EXECUTOR_AUTH_TOKEN: "manifest-mode-token",
        EXECUTOR_CLIENT_DIR: clientDir,
      });
      daemon = started.child;
      expect(started.ready, `supervised daemon became ready; stderr:\n${started.stderr}`).toBe(
        true,
      );
      await waitForHttp(`http://127.0.0.1:${port}/`, { timeoutMs: 30_000 });

      const mode = statSync(manifestPath).mode & 0o777;
      expect(
        mode.toString(8).padStart(3, "0"),
        "server.json embeds the bearer and must be owner read/write only",
      ).toBe("600");
    } finally {
      process.umask(previousUmask);
      daemon?.kill("SIGTERM");
      rmSync(home, { recursive: true, force: true });
    }
  }),
);

if (!guiAvailable() || !packagedSingleInstanceAvailable()) {
  it.skip("Desktop packaged supervised attach security (needs a GUI display and no already-running Executor.app)", () => {});
} else {
  scenario(
    "Desktop packaged supervised attach · stale manifest probe does not send the saved bearer",
    { timeout: 240_000 },
    Effect.gen(function* () {
      const runDir = yield* RunDir;
      yield* Effect.promise(() => runStaleManifestProbe(runDir));
    }),
  );

  scenario(
    "Desktop packaged supervised settings · changing the port moves the active daemon",
    { timeout: 300_000 },
    Effect.gen(function* () {
      const runDir = yield* RunDir;
      yield* Effect.promise(() => runSupervisedPortSetting(runDir));
    }),
  );
}

const launchPackaged = (home: string, videoTmp: string): Promise<ElectronApplication> => {
  const { app } = requireBundle();
  return _electron.launch({
    executablePath: app,
    env: { ...process.env, HOME: home },
    recordVideo: { dir: videoTmp, size: { width: 1280, height: 800 } },
    timeout: 120_000,
  });
};

const runStaleManifestProbe = async (runDir: string) => {
  const home = mkdtempSync(join(tmpdir(), "executor-pkg-stale-probe-"));
  const dataDir = join(home, ".executor");
  const controlDir = join(dataDir, "server-control");
  const videoTmp = join(runDir, ".video-tmp");
  const token = "stale-manifest-leaked-token";
  const requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];
  let resolveFirst!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const server = createServer((req: IncomingMessage, res) => {
    requests.push({
      url: req.url ?? "/",
      authorization: req.headers.authorization ?? null,
    });
    resolveFirst();
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>fake daemon</title><body>fake daemon</body>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  let app: ElectronApplication | undefined;

  try {
    mkdirSync(controlDir, { recursive: true });
    writeFileSync(
      join(controlDir, "server.json"),
      serializeExecutorLocalServerManifest({
        version: 1,
        kind: "cli-daemon",
        pid: process.pid,
        startedAt: new Date().toISOString(),
        dataDir,
        scopeDir: dataDir,
        connection: normalizeExecutorServerConnection({
          origin: `http://127.0.0.1:${port}`,
          displayName: "Stale daemon",
          auth: { kind: "bearer", token },
        }),
        owner: { client: "cli", version: null, executablePath: null },
      }),
      { mode: 0o600 },
    );

    app = await launchPackaged(home, videoTmp);
    const probed = await Promise.race([
      firstRequest.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 60_000)),
    ]);
    expect(probed, "packaged app probed the stale manifest endpoint").toBe(true);

    expect(
      requests[0]?.authorization ?? null,
      "the stale-manifest reachability probe must not disclose the saved bearer",
    ).toBeNull();
  } finally {
    await closeWithVideo(app, runDir, videoTmp);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
};

const runSupervisedPortSetting = async (runDir: string) => {
  const home = mkdtempSync(join(tmpdir(), "executor-pkg-port-setting-"));
  const dataDir = join(home, ".executor");
  const videoTmp = join(runDir, ".video-tmp");
  const oldPort = await freePort();
  const newPort = await freePort();
  let daemon: ChildProcess | undefined;
  let app: ElectronApplication | undefined;

  try {
    const started = await startSupervisedDaemon({
      ...process.env,
      HOME: home,
      EXECUTOR_SUPERVISED: "1",
      EXECUTOR_DATA_DIR: dataDir,
      EXECUTOR_PORT: String(oldPort),
      EXECUTOR_HOST: "127.0.0.1",
      EXECUTOR_AUTH_TOKEN: "port-setting-token",
      EXECUTOR_CLIENT_DIR: clientDir,
    });
    daemon = started.child;
    expect(started.ready, `supervised daemon became ready; stderr:\n${started.stderr}`).toBe(true);
    await waitForHttp(`http://127.0.0.1:${oldPort}/`, { timeoutMs: 30_000 });

    app = await launchPackaged(home, videoTmp);
    const page = await app.firstWindow({ timeout: 120_000 });
    await page.getByText("Settings").first().waitFor({ timeout: 120_000 });

    const before = await page.evaluate(async () => {
      return window.executor.getServerConnection();
    });
    expect(new URL(before!.origin).port, "test starts attached to the original port").toBe(
      String(oldPort),
    );

    await page.evaluate(async (port) => {
      await window.executor.updateSettings({ port });
    }, newPort);

    await page
      .evaluate(async () => {
        await window.executor.restartServer();
      })
      .catch(() => undefined);
    await page.getByText("Settings").first().waitFor({ timeout: 120_000 });

    const after = await page.evaluate(async () => {
      return {
        settings: await window.executor.getSettings(),
        connection: await window.executor.getServerConnection(),
      };
    });

    expect(after.settings.port, "the setting was persisted").toBe(newPort);
    expect(
      new URL(after.connection!.origin).port,
      "after restart, the active supervised daemon should be serving on the saved port",
    ).toBe(String(newPort));
  } finally {
    await closeWithVideo(app, runDir, videoTmp);
    daemon?.kill("SIGTERM");
    rmSync(home, { recursive: true, force: true });
  }
};
