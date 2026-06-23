// Desktop regression: a local `executor daemon run` (the CLI's foreground
// daemon, or a daemon a prior session left behind) already owns ~/.executor
// when the app launches. The app must NOT try to spawn a second server on top
// of it — that dies on the scope lock ("already running ... owns the current
// data directory") and historically wedged the app onto the crash screen with
// no way back until the foreign daemon was killed by hand. The fix: when the
// data dir is owned by a healthy cli-daemon, the app attaches to it instead of
// spawning. This drives the dev app (dev boot always takes the managed-spawn
// path, so it exercises the spawn -> attach fallback directly) against a
// pre-running CLI daemon and proves the window comes up attached to it.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { _electron } from "playwright";

import { scenario } from "../src/scenario";
import { RunDir } from "../src/services";

const appDir = fileURLToPath(new URL("../../apps/desktop/", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliEntry = join(repoRoot, "apps/cli/src/main.ts");
const electronBinary = createRequire(join(appDir, "package.json"))("electron") as string;

interface Manifest {
  readonly kind: string;
  readonly pid: number;
}

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

// Start a plain CLI daemon owning `dataDir` — no EXECUTOR_SUPERVISED, owner
// "cli", exactly what `executor daemon run` writes when a user starts it by
// hand. Resolves once it announces readiness (or exits / times out).
const startCliDaemon = (dataDir: string, home: string, port: number): Promise<DaemonStart> =>
  new Promise((resolve) => {
    const child = spawn(
      "bun",
      [
        "run",
        cliEntry,
        "daemon",
        "run",
        "--foreground",
        "--port",
        String(port),
        "--hostname",
        "127.0.0.1",
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: home,
          EXECUTOR_DATA_DIR: dataDir,
          EXECUTOR_SCOPE_DIR: dataDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    const settle = (ready: boolean) => resolve({ child, ready, stderr });
    const timer = setTimeout(() => settle(false), 60_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (/Daemon ready on http:\/\//.test(chunk.toString())) {
        clearTimeout(timer);
        settle(true);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("exit", () => {
      clearTimeout(timer);
      settle(false);
    });
  });

const stopDaemon = async (child: ChildProcess | undefined): Promise<void> => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
};

scenario(
  "Desktop · attaches to a CLI daemon that already owns the data dir instead of wedging",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const runDir = yield* RunDir;
    yield* Effect.promise(() => run(runDir));
  }),
);

const run = async (runDir: string) => {
  const home = mkdtempSync(join(tmpdir(), "executor-desktop-attach-"));
  const dataDir = join(home, ".executor");
  const manifestPath = join(dataDir, "server-control", "server.json");
  const port = await freePort();

  let daemon: ChildProcess | undefined;
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;

  try {
    const started = await startCliDaemon(dataDir, home, port);
    daemon = started.child;
    expect(started.ready, `CLI daemon became ready; stderr:\n${started.stderr}`).toBe(true);

    const before = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    expect(before.kind, "the CLI daemon advertises itself as cli-daemon").toBe("cli-daemon");
    const daemonPid = before.pid;
    expect(daemonPid, "CLI daemon pid recorded in the manifest").toBeGreaterThan(0);

    // Launch the dev app against the SAME HOME. Boot has no supervised path in
    // dev, so it goes straight to managed-spawn — which collides with the
    // daemon already owning ~/.executor and must fall back to attaching.
    app = await _electron.launch({
      executablePath: electronBinary,
      args: [appDir],
      cwd: appDir,
      env: { ...process.env, HOME: home },
      timeout: 120_000,
    });

    // firstWindow resolves only once a connection was established and the window
    // was created with its URL. Pre-fix the spawn died on the scope lock, boot
    // surfaced a fatal dialog, and no window was ever created — so this wait IS
    // the regression assertion: it only resolves if the app attached.
    const page = await app.firstWindow({ timeout: 120_000 });
    await page.screenshot({ path: join(runDir, "01-attached-window.png") });

    // Proof it ATTACHED rather than spawned: the manifest is untouched — same
    // pid, still cli-daemon. A managed sidecar would have rewritten it to
    // "desktop-sidecar" with a fresh pid.
    const after = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    expect(after.kind, "still the CLI daemon (the app did not spawn its own sidecar)").toBe(
      "cli-daemon",
    );
    expect(after.pid, "the app attached to the running CLI daemon, not a new sidecar").toBe(
      daemonPid,
    );
  } finally {
    await app?.close().catch(() => {});
    await stopDaemon(daemon);
    rmSync(home, { recursive: true, force: true });
  }
};
