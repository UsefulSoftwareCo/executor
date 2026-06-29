// Desktop project setup: make sure the bits the Electron app loads at
// runtime exist — the web UI bundle (served by the sidecar) and the
// electron-vite main/preload output. Always rebuilt so a run never tests
// stale code; both builds are incremental-fast. No server to boot: each
// scenario launches its own app process against a throwaway HOME.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const appsDesktop = fileURLToPath(new URL("../../apps/desktop/", import.meta.url));

export default function setup() {
  execFileSync("bun", ["run", "--filter", "@executor-js/local", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  execFileSync("bunx", ["--bun", "electron-vite", "build"], {
    cwd: appsDesktop,
    stdio: "inherit",
  });
}
