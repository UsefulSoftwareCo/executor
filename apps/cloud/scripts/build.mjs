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
import { rmSync } from "node:fs";

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
