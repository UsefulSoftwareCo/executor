// Rebuild the viewer over the existing run data without rerunning a single
// test: refresh runs/manifest.json + vite-build the SPA into runs/.
// Usage: bun e2e/scripts/rebuild-viewer.ts
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildManifest } from "../src/viewer/manifest";

const e2eDir = fileURLToPath(new URL("..", import.meta.url));
const runsDir = join(e2eDir, "runs");

buildManifest(runsDir);
rmSync(join(runsDir, "assets"), { recursive: true, force: true });
execFileSync("bunx", ["vite", "build", "--config", "viewer/vite.config.ts"], {
  cwd: e2eDir,
  stdio: "inherit",
});
console.log(`viewer rebuilt at ${runsDir}`);
