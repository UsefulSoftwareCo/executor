// Headless Linux reproduction of the desktop daemon attach/spawn wedge against
// the REAL packaged app. Replays the production incident exactly:
//
//   1. The app boots and spawns its OWN managed sidecar (no daemon present).
//   2. That sidecar dies (SIGKILL) — in production a `Ctrl-C`/SIGINT from a
//      concurrently started CLI daemon; here we kill it deterministically.
//   3. A separate `executor daemon run` (the CLI daemon a user starts by hand)
//      takes over ownership of ~/.executor.
//   4. The user hits "Restart server" on the crash screen.
//
// Pre-fix: step 4 re-spawns a second server, which dies on the scope lock
// ("already running ... owns the current data directory"), and the app stays
// wedged on the crash screen. Post-fix: the restart adopts the running CLI
// daemon instead, and the console comes back.
//
// Runs with only Node + the mounted linux bundle (no vitest, no repo). Drives
// the app over the Chrome DevTools Protocol. Exit 0 = recovered (fixed),
// non-zero = wedged (the bug) or harness failure.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP_DIR = process.env.APP_DIR ?? "/app";
const appExe = join(APP_DIR, "executor-desktop");
const executorBin = join(APP_DIR, "resources", "executor", "executor");

const log = (msg) => {
  process.stdout.write(`[repro] ${msg}\n`);
};
const fail = (msg) => {
  process.stdout.write(`[repro] FAIL: ${msg}\n`);
  process.exit(1);
};

// Hard watchdog: nothing below should take more than a few minutes. If it does,
// bail loudly rather than let the container hang (Electron spawns detached
// children that can keep a PID namespace alive).
const WATCHDOG_MS = Number(process.env.REPRO_WATCHDOG_MS ?? 240_000);
setTimeout(
  () => fail(`watchdog fired after ${WATCHDOG_MS}ms — something hung`),
  WATCHDOG_MS,
).unref();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const readManifest = (dataDir) => {
  const path = join(dataDir, "server-control", "server.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
};

const waitFor = async (label, fn, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(250);
  }
};

// --- minimal CDP page client over the built-in WebSocket -------------------
class Cdp {
  #ws;
  #id = 1;
  #pending = new Map();
  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (!m.id) return;
      const p = this.#pending.get(m.id);
      if (!p) return;
      this.#pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    });
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error(`CDP connect failed ${url}`)), {
        once: true,
      });
    });
  }
  cmd(method, params = {}) {
    const id = this.#id++;
    const p = new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.#ws.send(JSON.stringify({ id, method, params }));
    return p;
  }
  async eval(expression) {
    const r = await this.cmd("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    return r?.result?.value;
  }
}

const pageWsFor = async (debugPort) => {
  const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json());
  const page = targets.find(
    (t) => t.type === "page" && t.webSocketDebuggerUrl && !t.url.startsWith("devtools://"),
  );
  return page?.webSocketDebuggerUrl ?? null;
};

const launchApp = async (home, extraEnv = {}) => {
  const child = spawn(appExe, ["--no-sandbox", "--remote-debugging-port=0"], {
    env: {
      ...process.env,
      HOME: home,
      EXECUTOR_TEST_SKIP_BACKGROUND_SERVICE: "1",
      ...extraEnv,
    },
    // Own process group so cleanup can SIGKILL the whole Electron tree (main,
    // helpers, and the sidecar it spawns) via the negative pid.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const debugPort = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no CDP URL\n${out}`)), 120_000);
    const onData = (b) => {
      out = (out + b.toString()).slice(-16_384);
      const m = out.match(/DevTools listening on ws:\/\/[^/]+:(\d+)\//);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (c, s) =>
      reject(new Error(`app exited before CDP (code=${c} sig=${s})\n${out}`)),
    );
  });
  const wsUrl = await waitFor("page CDP target", () => pageWsFor(debugPort), 60_000);
  const cdp = await Cdp.connect(wsUrl);
  await cdp.cmd("Runtime.enable");
  await cdp.cmd("Page.enable");
  return { child, cdp, debugPort };
};

const bodyHas = (cdp, text) =>
  cdp.eval(`document.body && document.body.innerText.includes(${JSON.stringify(text)})`);

const startForeignDaemon = (home, dataDir, port) =>
  new Promise((resolve) => {
    const child = spawn(
      executorBin,
      ["daemon", "run", "--foreground", "--port", String(port), "--hostname", "127.0.0.1"],
      {
        env: {
          ...process.env,
          HOME: home,
          EXECUTOR_DATA_DIR: dataDir,
          EXECUTOR_SCOPE_DIR: dataDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let err = "";
    const timer = setTimeout(() => resolve({ child, ready: false, err }), 60_000);
    child.stdout.on("data", (b) => {
      if (/Daemon ready on http:\/\//.test(b.toString())) {
        clearTimeout(timer);
        resolve({ child, ready: true, err });
      }
    });
    child.stderr.on("data", (b) => (err += b.toString()));
    child.once("exit", () => {
      clearTimeout(timer);
      resolve({ child, ready: false, err });
    });
  });

const main = async () => {
  if (!existsSync(appExe)) fail(`app binary not found at ${appExe}`);
  if (!existsSync(executorBin)) fail(`bundled executor not found at ${executorBin}`);

  const home = mkdtempSync(join(tmpdir(), "executor-repro-"));
  const dataDir = join(home, ".executor");
  let app, foreign;

  try {
    // 1. Boot: no daemon present, so the app spawns its OWN managed sidecar.
    log("launching app (cold) — expect it to spawn its own sidecar");
    app = await launchApp(home);
    await waitFor("console (Settings)", () => bodyHas(app.cdp, "Settings"), 120_000);
    // Packaged mode spawns the bundled `executor daemon run` as its managed
    // sidecar, so the manifest is kind "cli-daemon" — the app's own daemon is
    // distinguished from a foreign one by owner.client ("desktop" vs "cli").
    const own = readManifest(dataDir);
    if (!own || own.owner?.client !== "desktop")
      fail(
        `expected the app's own managed daemon (owner.client=desktop) after cold boot, got ${JSON.stringify(own)}`,
      );
    log(`app booted on its own managed sidecar (pid ${own.pid}, owner ${own.owner.client})`);

    // 2. The app's sidecar dies out from under it -> crash screen.
    log(`killing the app's own sidecar (pid ${own.pid})`);
    process.kill(own.pid, "SIGKILL");
    await waitFor("crash screen", () => bodyHas(app.cdp, "stopped unexpectedly"), 30_000);
    log("crash screen shown");

    // 3. A CLI daemon takes over ownership of the data dir.
    const port = await freePort();
    log(`starting a foreign CLI daemon on :${port} (takes over ${dataDir})`);
    foreign = await startForeignDaemon(home, dataDir, port);
    if (!foreign.ready) fail(`foreign daemon never became ready:\n${foreign.err}`);
    const foreignManifest = readManifest(dataDir);
    if (
      !foreignManifest ||
      foreignManifest.owner?.client !== "cli" ||
      foreignManifest.pid === own.pid
    )
      fail(
        `expected a foreign cli daemon (owner.client=cli, new pid), got ${JSON.stringify(foreignManifest)}`,
      );
    const foreignPid = foreignManifest.pid;
    log(
      `foreign cli daemon owns the scope (pid ${foreignPid}, owner ${foreignManifest.owner.client})`,
    );

    // 4. User hits "Restart server". THIS is the wedge: pre-fix it re-spawns and
    //    dies on the scope lock; post-fix it adopts the running cli-daemon.
    log('clicking "Restart server" on the crash screen');
    await app.cdp.eval(`document.querySelector("#restart")?.click(); true`);

    const recovered = await waitFor(
      "console to come back after restart",
      () => bodyHas(app.cdp, "Settings"),
      90_000,
    ).then(
      () => true,
      () => false,
    );
    if (!recovered)
      fail(
        "app stayed wedged on the crash screen after restart — it re-spawned into the scope lock instead of attaching to the running cli-daemon (THE BUG)",
      );

    const after = readManifest(dataDir);
    if (!after || after.owner?.client !== "cli" || after.pid !== foreignPid)
      fail(
        `app did not attach to the foreign cli daemon: manifest=${JSON.stringify(after)} (expected owner.client=cli pid ${foreignPid})`,
      );

    log(
      `PASS: app recovered by ATTACHING to the foreign cli daemon (pid ${foreignPid}), no second server spawned`,
    );
    process.exit(0);
  } finally {
    // Kill the whole Electron process group (negative pid) plus the foreign
    // daemon, so no detached child keeps the container's PID namespace alive.
    if (app?.child?.pid) {
      try {
        process.kill(-app.child.pid, "SIGKILL");
      } catch {}
      try {
        app.child.kill("SIGKILL");
      } catch {}
    }
    try {
      foreign?.child.kill("SIGKILL");
    } catch {}
  }
};

main().catch((e) => fail(e?.stack ?? String(e)));
