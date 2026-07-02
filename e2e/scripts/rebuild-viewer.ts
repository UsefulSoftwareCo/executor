// Rebuild the viewer over the existing run data without rerunning a single
// test: refresh runs/manifest.json + vite-build the SPA into runs/.
// Usage: bun e2e/scripts/rebuild-viewer.ts
import { execFileSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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

// Self-host Playwright's trace viewer (a static PWA shipped inside
// playwright-core) next to the runs. trace.playwright.dev is HTTPS and
// browsers refuse to let it fetch a trace.zip from a plain-HTTP server
// (mixed content) — which is exactly how this viewer is reached over
// tailscale. Same-origin, the restriction disappears.
// playwright-core isn't a direct dependency — resolve it through
// playwright (which is), then walk from its entry to the package root.
const require = createRequire(import.meta.url);
const playwrightCoreEntry = createRequire(require.resolve("playwright")).resolve("playwright-core");
const traceViewerSrc = join(dirname(playwrightCoreEntry), "lib/vite/traceViewer");
rmSync(join(runsDir, "trace-viewer"), { recursive: true, force: true });
cpSync(traceViewerSrc, join(runsDir, "trace-viewer"), { recursive: true });

console.log(`viewer rebuilt at ${runsDir}`);
