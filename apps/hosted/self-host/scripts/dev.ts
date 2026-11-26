import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { devOrigin, freePort } from "../../../../scripts/dev-host.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const web = fileURLToPath(new URL("../web/", import.meta.url));
const origin = devOrigin("self-host");

if (process.env.PORTLESS_URL !== origin) {
  console.error(`Start self-host development with \`bun run hosted:dev\`; it serves ${origin}.`);
  process.exit(2);
}

const children: ChildProcess[] = [];
const start = (command: string, args: string[], cwd: string, env: Record<string, string>) => {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
  children.push(child);
  child.on("exit", (code, signal) => {
    for (const other of children) if (other !== child) other.kill("SIGTERM");
    process.exitCode = signal === null ? (code ?? 1) : 1;
  });
  return child;
};
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
  });

if (!existsSync(new URL("../web/dist/server/server.js", import.meta.url))) {
  const [code] = await once(spawn("bun", ["run", "build"], { cwd: web, stdio: "inherit" }), "exit");
  if (code !== 0) process.exit(1);
}

const api = `http://127.0.0.1:${await freePort()}`;
start("bun", ["apps/hosted/self-host/src/main.ts"], root, {
  HOST: "127.0.0.1",
  PORT: new URL(api).port,
  BETTER_AUTH_URL: origin,
  EXECUTOR_APP_UI_BASE_URL: `http://localhost:${new URL(api).port}`,
});
start("node", ["apps/hosted/self-host/scripts/development-web.ts"], root, {
  HOSTED_API_URL: api,
  BETTER_AUTH_URL: origin,
});
console.log(`Executor self-host: ${origin} (API ${api})`);
