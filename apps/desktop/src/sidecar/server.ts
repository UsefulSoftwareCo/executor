/**
 * Bun-side sidecar entry. Spawned by the Electron main process as a child
 * process (either via `bun run ...` in dev or as a Bun-compiled binary in
 * production).
 *
 * Reads connection parameters from env, boots the executor server, then
 * announces readiness with the resolved port on stdout so the Electron
 * main process can attach a BrowserWindow to it.
 */
// MUST stay the first import — points libSQL/keyring at the `.node` bindings
// staged next to the compiled binary before `@executor-js/local` loads them.
import "./native-bindings";
import { dirname, join } from "node:path";

// Pre-load QuickJS WASM for compiled binaries. `bun build --compile` can't
// embed the side-asset WASM that `quickjs-emscripten` ships with, so
// build-sidecar.ts stages it next to this binary and we feed the bytes in
// via `setQuickJSModule` before any server import touches QuickJS. Mirrors
// the CLI's preload in apps/cli/src/main.ts.
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

import { startServer } from "@executor-js/local";

const requestedPort = parseInt(process.env.EXECUTOR_PORT ?? "0", 10);
const hostname = process.env.EXECUTOR_HOST ?? "127.0.0.1";
const authPassword = process.env.EXECUTOR_AUTH_PASSWORD;
const clientDir = process.env.EXECUTOR_CLIENT_DIR;

const server = await startServer({
  port: requestedPort,
  hostname,
  ...(authPassword ? { authPassword } : {}),
  clientDir,
});

// Sentinel parsed by the main process to learn the bound port.
console.log(`EXECUTOR_READY:${server.port}`);

const stop = async (code: number) => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: shutdown path must terminate even when stop() throws
  try {
    await server.stop();
  } finally {
    process.exit(code);
  }
};

process.on("SIGTERM", () => void stop(0));
process.on("SIGINT", () => void stop(0));
process.on("disconnect", () => void stop(0));
