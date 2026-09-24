/**
 * Per-checkout development hostnames behind one shared Portless HTTPS proxy.
 *
 * Every checkout (the canonical one or any rift) gets its own names, so any
 * number of copies can run the same product at once without port or cookie
 * clashes: `<product>.executor.localhost:5394` in the canonical checkout and
 * `<product>.<checkout>.executor.localhost:5394` elsewhere.
 *
 * Usage: node scripts/dev-host.ts <product> <command...>
 * Portless assigns PORT/HOST and sets PORTLESS_URL to the public origin.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const proxyPort = 5394;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const canonical = new Set(["executor-next", "executor"]);

/** DNS-safe label for this checkout, or undefined in the canonical checkout. */
export const checkoutLabel = (directory = root) => {
  const name = basename(directory);
  if (canonical.has(name)) return undefined;
  const label = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return label === "" ? undefined : label;
};

/** Portless app name, e.g. `cloud.my-task.executor`. */
export const devAppName = (product: string) =>
  [product, checkoutLabel(), "executor"].filter((part) => part !== undefined).join(".");

/** Browser origin Portless serves for a product in this checkout. */
export const devOrigin = (product: string) =>
  `https://${devAppName(product)}.localhost:${proxyPort}`;

/** Environment that pins the shared proxy to named HTTPS routes on the development port. */
export const portlessEnvironment = {
  PORTLESS_PORT: String(proxyPort),
  PORTLESS_HTTPS: "1",
  PORTLESS_SHARED_PORT: "0",
  PORTLESS_MULTIPLEX: "0",
} as const;

export const portlessBin = join(root, "node_modules", ".bin", "portless");

/**
 * An unused loopback port for a process that sits behind a proxied one, chosen per run.
 * Never persist it: rifts copy `.local/`, so a saved port would collide between copies.
 */
export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("The OS did not assign a port")),
      );
    });
  });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [product, ...command] = process.argv.slice(2);
  if (product === undefined || command.length === 0) {
    console.error("Usage: node scripts/dev-host.ts <product> <command...>");
    process.exit(2);
  }
  const child = spawn(portlessBin, [devAppName(product), ...command], {
    cwd: process.cwd(),
    env: { ...process.env, ...portlessEnvironment },
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => {
    if (signal !== null) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}
