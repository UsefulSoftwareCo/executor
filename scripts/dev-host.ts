import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const proxyPort = 5394;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const canonical = new Set(["executor-next", "executor"]);

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

export const devAppName = (product: string) =>
  [product, checkoutLabel(), "executor"].filter((part) => part !== undefined).join(".");

export const devOrigin = (product: string) =>
  `https://${devAppName(product)}.localhost:${proxyPort}`;

export const portlessEnvironment = {
  PORTLESS_PORT: String(proxyPort),
  PORTLESS_HTTPS: "1",
  PORTLESS_SHARED_PORT: "0",
  PORTLESS_MULTIPLEX: "0",
} as const;

export const portlessBin = join(root, "node_modules", ".bin", "portless");

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
