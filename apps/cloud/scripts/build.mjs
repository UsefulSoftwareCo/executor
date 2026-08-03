// Build wrapper that pins VITE_PUBLIC_ANALYTICS_PATH for the whole build.
//
// Vite reloads vite.config.ts separately for the client and SSR/Cloudflare
// environments, so a module-scoped randomUUID() ends up running twice and
// the two bundles bake different values. The browser SDK then targets a
// path the worker middleware never matches, and PostHog requests 404. By
// generating once here and putting it in process.env before vite starts,
// every environment build sees the same value.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";

if (!process.env.VITE_PUBLIC_ANALYTICS_PATH) {
  process.env.VITE_PUBLIC_ANALYTICS_PATH = randomBytes(4).toString("hex");
}
console.log(`[build] VITE_PUBLIC_ANALYTICS_PATH=${process.env.VITE_PUBLIC_ANALYTICS_PATH}`);

rmSync(new URL("../dist/", import.meta.url), { force: true, recursive: true });

const steps = [
  // Workspace packages whose exports app code (or this very vite config)
  // resolves from dist under Node — vite's config loader externalizes bare
  // imports, so they must be built before vite starts.
  "turbo run build --filter @executor-js/vite-plugin --filter @executor-js/react",
  "vite build",
];

for (const step of steps) {
  const result = spawnSync(step, { stdio: "inherit", shell: true });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// The deployed Worker serves the MCP-Apps shell (`ui://executor/shell.html`)
// by fetching this stable-named asset through the ASSETS binding — it has no
// filesystem to read the shell from. A build that failed to emit it would
// deploy a Worker whose artifact resource reads all fail, so make the miss a
// build failure here instead of a production incident. Same shape as the
// worker-bundler asset assertion from #1378.
const shellAsset = new URL(
  "../dist/client/assets/executor-mcp-apps-shell-stable.html",
  import.meta.url,
);
if (!existsSync(shellAsset)) {
  console.error(`[build] missing MCP-Apps shell asset at ${shellAsset.pathname}`);
  process.exit(1);
}
if (!readFileSync(shellAsset, "utf8").includes('name="executor-mcp-apps-shell"')) {
  console.error(`[build] ${shellAsset.pathname} is not the MCP-Apps shell document`);
  process.exit(1);
}
