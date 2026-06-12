// One-command setup for a fresh checkout or agent worktree: dependencies
// (whose prepare hook builds the internal packages dev servers need) and the
// Playwright browser the e2e suite drives. Idempotent and safe to re-run;
// each step prints what it is doing.
//
// The vendor/ submodules are intentionally NOT initialized: nothing imports
// from vendor/ at runtime — those forks are consumed as published npm
// packages (see vendor/README.md). Pass --forks only when deliberately
// developing a fork.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const run = (label: string, cmd: string, args: ReadonlyArray<string>) => {
  console.log(`\n[bootstrap] ${label}: ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, [...args], { cwd: repoRoot, stdio: "inherit" });
};

if (process.argv.includes("--forks")) {
  run("vendor fork submodules", "git", ["submodule", "update", "--init", "--recursive"]);
}

// `bun install` runs the workspace prepare hook, which builds
// @executor-js/vite-plugin and @executor-js/react — the two artifacts the
// apps' vite dev servers fail without in a fresh worktree.
run("dependencies (+ prepare builds)", "bun", ["install"]);

// e2e browser scenarios need Playwright's chromium; the cache is shared
// per-machine so this is a fast no-op when already present.
run("playwright chromium", "bunx", ["playwright", "install", "chromium"]);

if (!existsSync(resolve(repoRoot, "node_modules/.bin/vitest"))) {
  throw new Error("bootstrap: vitest missing after install — bun install likely failed");
}

console.log("\n[bootstrap] done — `cd e2e && bun run test` runs the full suite.");
