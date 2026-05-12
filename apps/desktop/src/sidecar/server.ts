/**
 * Bun-side sidecar entry. Spawned by the Electron main process as a child
 * process (either via `bun run ...` in dev or as a Bun-compiled binary in
 * production).
 *
 * Reads connection parameters from env, boots the executor server, then
 * announces readiness with the resolved port on stdout so the Electron
 * main process can attach a BrowserWindow to it.
 */
import { startServer } from "@executor-js/local";

const requestedPort = parseInt(process.env.EXECUTOR_PORT ?? "0", 10);
const hostname = process.env.EXECUTOR_HOST ?? "127.0.0.1";
const authPassword = process.env.EXECUTOR_AUTH_PASSWORD;
const clientDir = process.env.EXECUTOR_CLIENT_DIR;

if (!authPassword) {
  // oxlint-disable-next-line executor/no-error-constructor -- boundary: misconfiguration at sidecar boot is fatal
  throw new Error("EXECUTOR_AUTH_PASSWORD must be set when running the desktop sidecar.");
}

const server = await startServer({
  port: requestedPort,
  hostname,
  authPassword,
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
