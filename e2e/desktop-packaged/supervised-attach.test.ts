// Packaged desktop, on camera: the REAL electron-builder bundle (app.isPackaged
// === true) attaches to an already-running OS-supervised daemon instead of
// spawning its own sidecar. This is the production-only path — dev electron skips
// ensureSupervisedConnection entirely and always spawns a desktop-sidecar, so the
// attach behavior can ONLY be proven against the packaged artifact.
//
// We start the daemon as the bundle's OWN compiled `executor` binary (the exact
// binary a supervised install runs) in EXECUTOR_SUPERVISED mode. It publishes a
// manifest of kind "cli-daemon". Then we launch the packaged app
// pointed at the same HOME and prove it attached: the manifest still names the
// daemon's pid (a spawned sidecar would rewrite it to "desktop-sidecar" with a
// fresh pid), and the console — served by the bearer-gated daemon — renders,
// which only happens if the app injected the bearer it read from the manifest.
// The recording (session.mp4 + screenshots) is the artifact; the waits assert.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { RunDir } from "../src/services";
import { waitForHttp } from "../setup/boot";

// Driving the packaged Electron app needs a real window-server session: Aqua on
// macOS, an X/Wayland display on Linux. An SSH/CI shell runs in the background
// (non-GUI) session where Electron can't open a window — so this scenario runs
// only where a display is reachable (a logged-in console, or a guest under
// autologin/Xvfb) and skips honestly elsewhere rather than hanging on launch.
const guiAvailable = (): boolean => {
  if (process.platform === "darwin") {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: probing the session manager; absence = no GUI
    try {
      return execFileSync("launchctl", ["managername"], { encoding: "utf8" }).trim() === "Aqua";
    } catch {
      return false;
    }
  }
  if (process.platform === "linux") {
    return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  }
  return true; // windows: the runner places this in an interactive session
};

const SCENARIO_NAME = "Desktop (packaged) · the real bundle attaches to the OS-supervised daemon";

const appExe = process.env.E2E_DESKTOP_APP_EXE;
const executorBin = process.env.E2E_DESKTOP_EXECUTOR_BIN;

interface PackagedApp {
  readonly child: ChildProcess;
  readonly debugPort: string;
  cdp: CdpPage;
}

interface CdpResponse<T> {
  readonly id: number;
  readonly result?: T;
  readonly error?: { readonly message?: string };
}

interface CdpEvaluateResult {
  readonly result: { readonly value?: unknown };
  readonly exceptionDetails?: unknown;
}

interface CdpTarget {
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl?: string;
}

class CdpPage {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
    }
  >();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const data = event.data;
      if (typeof data !== "string") return;
      const message = JSON.parse(data) as CdpResponse<unknown>;
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "CDP command failed"));
        return;
      }
      pending.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const [, pending] of this.pending) {
        pending.reject(new Error("CDP socket closed"));
      }
      this.pending.clear();
    });
  }

  static connect = (url: string): Promise<CdpPage> =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: WebSocket connection promise adapter
        reject(new Error(`Timed out connecting to page CDP target ${url}`));
      }, 30_000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve(new CdpPage(socket));
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: WebSocket connection promise adapter
          reject(new Error(`Failed to connect to page CDP target ${url}`));
        },
        { once: true },
      );
    });

  command = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const id = this.nextId;
    this.nextId += 1;
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  };

  evaluate = async <T>(expression: string): Promise<T> => {
    const result = await this.command<CdpEvaluateResult>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`CDP evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result.value as T;
  };

  waitForText = async (text: string, timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    const expression = `document.body?.innerText.includes(${JSON.stringify(text)}) ?? false`;
    for (;;) {
      if (await this.evaluate<boolean>(expression).catch(() => false)) return;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for text: ${text}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  screenshot = async (path: string): Promise<void> => {
    const result = await this.command<{ readonly data: string }>("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    writeFileSync(path, Buffer.from(result.data, "base64"));
  };

  close = (): void => {
    this.socket.close();
  };
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

interface Manifest {
  readonly kind: string;
  readonly pid: number;
}

interface DaemonStart {
  readonly child: ChildProcess;
  readonly ready: boolean;
  readonly stderr: string;
}

/** Spawn the bundle's compiled executor as a supervised daemon; resolves once it
 *  announces readiness (or times out / exits early, ready:false). */
const startSupervisedDaemon = (env: NodeJS.ProcessEnv, port: number): Promise<DaemonStart> =>
  new Promise((resolve) => {
    const child = spawn(
      executorBin as string,
      ["daemon", "run", "--foreground", "--port", String(port), "--hostname", "127.0.0.1"],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    const settle = (ready: boolean) => resolve({ child, ready, stderr });
    const timer = setTimeout(() => settle(false), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (/Daemon ready on http:\/\//.test(chunk.toString())) {
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

const waitForPageWebSocket = async (debugPort: string): Promise<string> => {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const targets = (await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      .then((response) => (response.ok ? response.json() : []))
      .catch(() => [])) as ReadonlyArray<CdpTarget>;
    const page = targets.find(
      (target) =>
        target.type === "page" &&
        target.webSocketDebuggerUrl &&
        !target.url.startsWith("devtools://"),
    );
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for packaged app page CDP target");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const launchPackaged = async (home: string): Promise<PackagedApp> => {
  let output = "";
  let settled = false;
  const child = spawn(appExe as string, ["--remote-debugging-port=0"], {
    env: { ...process.env, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const browserCdpUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: packaged-app launch promise adapter
      reject(new Error(`Timed out waiting for packaged app CDP URL\n${output}`));
    }, 120_000);
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const collectOutput = (chunk: Buffer) => {
      const text = chunk.toString();
      output = (output + text).slice(-16_384);
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) settle(() => resolve(match[1]!));
    };
    child.stdout?.on("data", collectOutput);
    child.stderr?.on("data", collectOutput);
    // oxlint-disable-next-line executor/no-promise-reject -- boundary: packaged-app launch promise adapter
    child.once("error", (error) => settle(() => reject(error)));
    child.once("exit", (code, signal) =>
      settle(() =>
        // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: packaged-app launch promise adapter
        reject(
          new Error(`Packaged app exited before CDP (code=${code} signal=${signal})\n${output}`),
        ),
      ),
    );
  });

  const debugPort = new URL(browserCdpUrl).port;
  const pageCdpUrl = await waitForPageWebSocket(debugPort);
  const cdp = await CdpPage.connect(pageCdpUrl);
  await cdp.command("Runtime.enable");
  await cdp.command("Page.enable");
  return { child, cdp, debugPort };
};

const stopProcess = async (child: ChildProcess | undefined): Promise<void> => {
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

const closePackaged = async (app: PackagedApp | undefined): Promise<void> => {
  app?.cdp.close();
  await stopProcess(app?.child);
};

if (!guiAvailable() || !packagedSingleInstanceAvailable()) {
  it.skip(`${SCENARIO_NAME} (needs a GUI display and no already-running Executor.app)`, () => {});
} else {
  scenario(
    SCENARIO_NAME,
    { timeout: 240_000 },
    Effect.gen(function* () {
      if (!appExe || !executorBin) {
        return yield* Effect.die(
          "E2E_DESKTOP_APP_EXE / E2E_DESKTOP_EXECUTOR_BIN not set — did desktop-packaged.globalsetup run?",
        );
      }
      const runDir = yield* RunDir;
      yield* Effect.promise(() => run(runDir));
    }),
  );
}

const run = async (runDir: string) => {
  const home = mkdtempSync(join(tmpdir(), "executor-pkg-attach-"));
  const dataDir = join(home, ".executor");
  const manifestPath = join(dataDir, "server-control", "server.json");
  const port = await freePort();

  let daemon: ChildProcess | undefined;
  let app: PackagedApp | undefined;
  let stepIndex = 0;

  try {
    const started = await startSupervisedDaemon(
      {
        ...process.env,
        HOME: home,
        EXECUTOR_SUPERVISED: "1",
        EXECUTOR_DATA_DIR: dataDir,
        EXECUTOR_AUTH_TOKEN: "packaged-attach-film",
        EXECUTOR_CLIENT: "desktop",
      },
      port,
    );
    daemon = started.child;
    expect(started.ready, `supervised daemon became ready; stderr:\n${started.stderr}`).toBe(true);
    await waitForHttp(`http://127.0.0.1:${port}/`, { timeoutMs: 30_000 });

    const daemonManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    expect(daemonManifest.kind, "the bundled executor advertises itself as cli-daemon").toBe(
      "cli-daemon",
    );
    const daemonPid = daemonManifest.pid;

    // Launch the PACKAGED bundle directly. `app.isPackaged` is true, so boot()
    // runs the supervised attach path; CDP drives the real renderer.
    app = await launchPackaged(home);
    const page = app.cdp;
    const step = async (label: string, body: () => Promise<void>) => {
      await body();
      stepIndex += 1;
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      await page.screenshot(join(runDir, `${String(stepIndex).padStart(2, "0")}-${slug}.png`));
    };

    // The console only renders once the app has a live connection AND the bearer
    // it injects is accepted by the gated daemon — so reaching it proves both the
    // attach and the bearer wiring through the packaged session layer.
    await step("packaged app boots into the bearer-gated console", async () => {
      await page.waitForText("Settings", 120_000);
    });

    // Proof it ATTACHED, not spawned: the manifest is untouched — same pid, still
    // cli-daemon. A managed sidecar would have rewritten it to "desktop-sidecar".
    await step("server manifest still names the supervised daemon", async () => {
      const after = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
      expect(after.kind, "still the supervised daemon (not a desktop sidecar)").toBe("cli-daemon");
      expect(after.pid, "the packaged app attached to our daemon, not a new sidecar").toBe(
        daemonPid,
      );
    });
  } finally {
    await closePackaged(app);
    await stopProcess(daemon);
    rmSync(home, { recursive: true, force: true });
  }
};
