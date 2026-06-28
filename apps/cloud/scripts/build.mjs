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
import { readFileSync, rmSync, writeFileSync } from "node:fs";

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

// Preview (non-production) Cloudflare Workers Builds deploy via `wrangler versions
// upload`, which REJECTS any config containing an unapplied Durable Object
// migration (error 10211 — "migrations must be applied via a non-versioned
// deployment"). Preview versions share production's already-applied DO state, so
// they neither need nor can apply migrations. Strip `migrations` from the
// generated deploy config on non-`main` CI branches so PR preview builds stop
// failing. Production (`main`) keeps migrations and applies them on the real,
// non-versioned deploy. Fail-safe: only triggers on a confirmed non-`main` CI
// branch, so it can never drop migrations from a production deploy.
const ciBranch = process.env.WORKERS_CI_BRANCH;
if (process.env.WORKERS_CI === "1" && ciBranch && ciBranch !== "main") {
  const cfgUrl = new URL("../dist/server/wrangler.json", import.meta.url);
  // oxlint-disable-next-line executor/no-json-parse -- build script, not domain code; wrangler emits plain JSON
  const cfg = JSON.parse(readFileSync(cfgUrl, "utf8"));
  if (Array.isArray(cfg.migrations) && cfg.migrations.length > 0) {
    delete cfg.migrations;
    writeFileSync(cfgUrl, JSON.stringify(cfg));
    console.log(
      `[build] preview branch '${ciBranch}': stripped Durable Object migrations from ` +
        `dist/server/wrangler.json (versions upload cannot apply migrations)`,
    );
  }
}
