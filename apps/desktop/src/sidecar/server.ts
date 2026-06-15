/**
 * Bun-side sidecar entry. Spawned by the Electron main process in dev via
 * `bun run ...`. Packaged desktop uses the bundled `executor` CLI binary
 * instead.
 *
 * Reads connection parameters from env, boots the executor server, then
 * announces readiness with the resolved port on stdout so the Electron
 * main process can attach a BrowserWindow to it.
 */
// MUST stay the first import — points libSQL/keyring at the `.node` bindings
// staged next to the compiled binary before `@executor-js/local` loads them.
import "./native-bindings";
import { dirname, join } from "node:path";

// Pre-load QuickJS WASM for manually compiled sidecar binaries. Packaged
// desktop no longer ships this entrypoint, but keeping the preload here lets
// direct sidecar smoke/debug runs behave like the CLI binary.
const wasmOnDisk = join(dirname(process.execPath), "emscripten-module.wasm");
if (typeof Bun !== "undefined" && (await Bun.file(wasmOnDisk).exists())) {
  const { setQuickJSModule } = await import("@executor-js/runtime-quickjs");
  const { newQuickJSWASMModule } = await import("quickjs-emscripten");
  type QuickJSSyncVariant = import("quickjs-emscripten").QuickJSSyncVariant;
  const wasmBinary = await Bun.file(wasmOnDisk).arrayBuffer();
  const importFFI: QuickJSSyncVariant["importFFI"] = () =>
    import("@jitl/quickjs-wasmfile-release-sync/ffi").then((m) => m.QuickJSFFI);
  const importModuleLoader: QuickJSSyncVariant["importModuleLoader"] = async () => {
    const { default: original } =
      await import("@jitl/quickjs-wasmfile-release-sync/emscripten-module");
    return (moduleArg = {}) => original({ ...moduleArg, wasmBinary });
  };
  const variant: QuickJSSyncVariant = {
    type: "sync" as const,
    importFFI,
    importModuleLoader,
  };
  const mod = await newQuickJSWASMModule(variant);
  setQuickJSModule(mod);
}

// Crash reporting — only when the Electron main process handed us a DSN
// (desktop builds with DESKTOP_SENTRY_DSN baked in). `executor web` and self-host
// never set these env vars, so this stays inert everywhere else. Captures
// uncaught exceptions / unhandled rejections in the server process; the
// shared runId ties events to the main process and diagnostics zip.
const sentryDsn = process.env.EXECUTOR_SENTRY_DSN;
if (sentryDsn) {
  const Sentry = await import("@sentry/bun");
  Sentry.init({
    dsn: sentryDsn,
    release: process.env.EXECUTOR_SENTRY_RELEASE,
    environment: process.env.EXECUTOR_SENTRY_ENVIRONMENT ?? "production",
    tracesSampleRate: 0,
    initialScope: {
      tags: {
        process: "sidecar",
        platform: process.platform,
        arch: process.arch,
        ...(process.env.EXECUTOR_RUN_ID ? { runId: process.env.EXECUTOR_RUN_ID } : {}),
      },
    },
  });
}

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  normalizeExecutorServerConnection,
  parseExecutorLocalServerManifest,
  serializeExecutorLocalServerManifest,
} from "@executor-js/sdk/shared";
import { startServer } from "@executor-js/local";

const requestedPort = parseInt(process.env.EXECUTOR_PORT ?? "0", 10);
const hostname = process.env.EXECUTOR_HOST ?? "127.0.0.1";
// The main process mints/loads the bearer token and threads it in via env so it
// can inject the same token into the webview. When absent (e.g. supervised boot
// under launchd, or a standalone sidecar), startServer mints/loads auth.json.
const authToken = process.env.EXECUTOR_AUTH_TOKEN;
const clientDir = process.env.EXECUTOR_CLIENT_DIR;

// Supervised mode: launchd/systemd runs this binary directly (no Electron
// parent). Two things the parent normally does, this process must do itself:
// (1) get the bearer token (EXECUTOR_AUTH_TOKEN, else startServer mints/loads
// auth.json — the unit never carries the secret), and (2) write server.json so
// clients can discover us.
const supervised = process.env.EXECUTOR_SUPERVISED === "1";
const dataDir = process.env.EXECUTOR_DATA_DIR ?? join(homedir(), ".executor");
const serverControlDir = join(dataDir, "server-control");
const manifestPath = join(serverControlDir, "server.json");

const writeSupervisedManifest = (port: number, token: string) => {
  const connection = normalizeExecutorServerConnection({
    origin: `http://${hostname}:${port}`,
    displayName: "Supervised daemon",
    auth: { kind: "bearer" as const, token },
  });
  mkdirSync(serverControlDir, { recursive: true });
  writeFileSync(
    manifestPath,
    serializeExecutorLocalServerManifest({
      version: 1,
      // "cli-daemon" marks an OS-supervised gateway that thin views (the
      // desktop app, CLI) attach to rather than spawn — see the desktop's
      // attachToSupervisedDaemon.
      kind: "cli-daemon",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      dataDir,
      scopeDir: process.env.EXECUTOR_SCOPE_DIR ?? dataDir,
      connection,
      owner: {
        client: "desktop",
        version: process.env.EXECUTOR_SERVICE_VERSION ?? null,
        executablePath: process.execPath || null,
      },
    }),
    { mode: 0o600 },
  );
  chmodSync(manifestPath, 0o600);
};

const removeOwnManifest = () => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: best-effort cleanup on shutdown
  try {
    if (!existsSync(manifestPath)) return;
    const parsed = parseExecutorLocalServerManifest(readFileSync(manifestPath, "utf8"));
    if (parsed?.pid === process.pid) rmSync(manifestPath, { force: true });
  } catch {
    // ignore
  }
};

const server = await startServer({
  port: requestedPort,
  hostname,
  ...(authToken ? { authToken } : {}),
  clientDir,
});

if (supervised) writeSupervisedManifest(server.port, server.authToken);

// Sentinel parsed by the main process to learn the bound port (harmless under
// launchd, where stdout goes to the daemon log).
console.log(`EXECUTOR_READY:${server.port}`);

const stop = async (code: number) => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: shutdown path must terminate even when stop() throws
  try {
    await server.stop();
    if (supervised) removeOwnManifest();
  } finally {
    process.exit(code);
  }
};

process.on("SIGTERM", () => void stop(0));
process.on("SIGINT", () => void stop(0));
process.on("disconnect", () => void stop(0));
