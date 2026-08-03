#!/usr/bin/env bun
/**
 * Asserts that every committed `routeTree.gen.ts` matches what its generator
 * produces from the current route contract.
 *
 * The route trees are GENERATED (`bun run routes:gen` in each package, from
 * `tsr.routes.ts` / `consoleRoutes()`) but COMMITTED, because the build and the
 * type-level `Link to=...` checking both read them off disk. That makes them a
 * classic drift surface: change the route contract, forget to regenerate, and
 * the committed tree still compiles — the routes it lacks simply don't exist at
 * runtime.
 *
 * Nothing else catches it. The generated files open with a suppression pragma
 * that opts them out of type checking entirely, so `typecheck` cannot see a
 * missing route; lint doesn't read them semantically; and unit tests import
 * the very tree they are drifting against. This bug class has already escaped
 * once and shipped a live 404 for a route that was in the contract but not in
 * the committed tree.
 *
 * So: regenerate every tree into place, diff against git, and restore. The
 * generators are pure functions of the checked-in route config, so a clean
 * checkout is a no-op and any diff is real drift.
 *
 * Usage:
 *   bun run scripts/check-route-trees.ts
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

/**
 * Every package with a committed route tree, as (workspace dir, tree path)
 * pairs. Each dir has a `routes:gen` script; the tree is the file it writes.
 */
const TREES = [
  { dir: "packages/react", tree: "packages/react/src/routes/routeTree.gen.ts" },
  { dir: "packages/app", tree: "packages/app/src/routeTree.gen.ts" },
  { dir: "apps/cloud", tree: "apps/cloud/src/routeTree.gen.ts" },
  { dir: "apps/host-selfhost", tree: "apps/host-selfhost/web/routeTree.gen.ts" },
  { dir: "apps/host-cloudflare", tree: "apps/host-cloudflare/web/routeTree.gen.ts" },
] as const;

const run = (command: string, args: readonly string[], cwd: string) =>
  spawnSync(command, [...args], { cwd, encoding: "utf8" });

/**
 * Compare on ROUTE CONTENT, not byte-for-byte.
 *
 * Two generators write these files: each package's `routes:gen` script, and the
 * TanStack vite plugin during `dev`. They agree on every route, import, and
 * type — they disagree only on blank lines in the trailing `declare module`
 * block. Comparing raw bytes would therefore fail on any checkout where a dev
 * server had run, which is a false alarm about formatting, not the drift this
 * guards (a route present in the contract and missing from the tree). Blank
 * lines cannot encode a route, so dropping them loses no signal.
 */
const routeContent = (source: string): string =>
  source
    .split("\n")
    .filter((line) => line.trim() !== "")
    .join("\n");

// Snapshot the committed content so a failed run leaves the checkout exactly as
// it found it — this script must be safe to run on a dirty working tree.
const before = new Map<string, string>();
for (const { tree } of TREES) {
  before.set(tree, readFileSync(resolve(repoRoot, tree), "utf8"));
}

const restore = () => {
  for (const [tree, content] of before) writeFileSync(resolve(repoRoot, tree), content);
};

/** The lines each side has and the other does not — enough to name the route
 *  that drifted, without pulling in a diff library for a CI guard. */
const lineDiff = (committed: string, regenerated: string): string => {
  const committedLines = new Set(committed.split("\n"));
  const regeneratedLines = new Set(regenerated.split("\n"));
  const missing = [...regeneratedLines].filter((line) => !committedLines.has(line));
  const extra = [...committedLines].filter((line) => !regeneratedLines.has(line));
  const show = (label: string, lines: readonly string[]) =>
    lines.length === 0
      ? []
      : [`    ${label}:`, ...lines.slice(0, 20).map((line) => `      ${line}`)];
  return [
    ...show("in the regenerated tree but NOT committed (missing routes)", missing),
    ...show("committed but NOT regenerated (stale routes)", extra),
  ].join("\n");
};

type Failure = { readonly tree: string; readonly detail: string };
const failures: Failure[] = [];

for (const { dir, tree } of TREES) {
  const generated = run("bun", ["run", "routes:gen"], resolve(repoRoot, dir));
  if (generated.status !== 0) {
    failures.push({
      tree,
      detail: `\`bun run routes:gen\` failed in ${dir}:\n${generated.stderr || generated.stdout}`,
    });
    continue;
  }
  const after = readFileSync(resolve(repoRoot, tree), "utf8");
  const committed = routeContent(before.get(tree) ?? "");
  const regenerated = routeContent(after);
  if (regenerated !== committed) {
    // Show the actual drift rather than just naming the file: what changed is
    // usually the whole answer (a route added to the contract, or removed).
    // Diffed against the SNAPSHOT rather than via `git diff`, so this reports
    // correctly even when the committed file was already dirty.
    failures.push({
      tree,
      detail: `regenerating produced a different tree:\n${lineDiff(committed, regenerated)}`,
    });
  }
}

restore();

if (failures.length > 0) {
  const lines = failures.map((f) => `  - ${f.tree}: ${f.detail}`).join("\n\n");
  console.error(
    `\nRoute-tree check FAILED (${failures.length} tree(s) out of date):\n${lines}\n\n` +
      "Cause: a committed routeTree.gen.ts does not match what its generator\n" +
      "produces from the current route contract — the contract changed and the\n" +
      "tree was not regenerated. These files opt out of type checking, so the\n" +
      "typecheck job cannot catch this; the app just serves a 404 for the\n" +
      "missing route.\n\n" +
      "Fix: regenerate and commit the trees:\n" +
      TREES.map(({ dir }) => `  bun run --cwd ${dir} routes:gen`).join("\n") +
      "\n",
  );
  process.exit(1);
}

console.log(`Route-tree check passed: ${TREES.length} generated tree(s) match their contract.`);
