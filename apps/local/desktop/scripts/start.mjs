/** Workspace launcher: build Electron main, retain the explicit host environment, forward shutdown. */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildDesktop } from "./build.mjs";
import { resolveLauncher } from "./launcher.mjs";

const root = fileURLToPath(new URL("../../../..", import.meta.url));
const desktop = fileURLToPath(new URL("..", import.meta.url));
await mkdir(`${root}/.local/desktop-shell`, { recursive: true });
await buildDesktop();
const { executable } = await resolveLauncher();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [desktop, ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: "inherit",
});
const stop = () => {
  child.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.once("error", () => {
  console.error("Electron could not start. Run bun install and retry.");
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  process.exitCode = code ?? 1;
});
