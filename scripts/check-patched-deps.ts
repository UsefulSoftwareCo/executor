#!/usr/bin/env bun
/**
 * Asserts that patched dependencies are actually installed in patched form.
 *
 * We patch several npm packages via `bun patch` (see `patchedDependencies` in
 * package.json and the `patches/*.patch` files). At least one of these patches
 * is load-bearing at runtime, not just a build-time convenience: the
 * `agents@0.17.3` patch carries the MCP transport persist/replay fix (the SSE
 * "hang" fix that preserves tool results across dropped connections). If the
 * installed `agents` dist is the STALE, unpatched upstream build, everything
 * still compiles and tests mostly pass while the deployed transport silently
 * lacks the fix, so prod ships the pre-fix transport with zero signal.
 *
 * This has actually happened: a bun cache edge case left a checkout with an
 * unpatched `agents` dist in node_modules even though the lockfile and
 * package.json recorded the patch. `bun install` reported no changes because
 * the store entry it wanted was already present; it just wasn't the patched
 * content.
 *
 * So we don't trust the lockfile — we read the installed dist off disk and
 * assert the post-patch sentinel strings are present. The check is a couple of
 * file reads plus greps, so it adds ~zero wall-clock time and is safe to run in
 * CI before the test job and in `bootstrap` on every fresh checkout.
 *
 * Usage:
 *   bun run scripts/check-patched-deps.ts
 *
 * Env overrides (used by the self-test):
 *   CHECK_PATCHED_DEPS_AGENTS_MCP=/abs/path/to/agents/dist/mcp/index.js
 *     Force the agents MCP entry path instead of resolving it, so the self-test
 *     can point the check at a deliberately-corrupted copy.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

type Failure = { readonly package: string; readonly detail: string };
const failures: Failure[] = [];

/**
 * Each patched package whose *runtime content* we assert against. Sentinels are
 * identifiers that exist only in the patched dist (added by the patch), so
 * their presence proves the installed file is the patched one, not a stale
 * upstream build. Keep sentinels to a couple of stable, patch-unique symbols.
 */
type RuntimeCheck = {
  readonly package: string;
  /** Resolve the installed entry file we assert against. */
  readonly resolveEntry: () => string;
  /** Strings that only appear post-patch. All must be present. */
  readonly sentinels: readonly string[];
  /** Human hint for what the patch does, shown on failure. */
  readonly purpose: string;
};

/**
 * Resolve a subpath export of a dependency robustly, without hardcoding the
 * bun store hash in `node_modules/.bun/<pkg>@<version>+<hash>/…`. We resolve
 * from a workspace package that actually depends on it so the module graph is
 * the real one; `require.resolve` then walks bun's store for us.
 */
const resolveFrom = (specifier: string, fromPackageDir: string): string => {
  const fromDir = resolve(repoRoot, fromPackageDir);
  return require.resolve(specifier, { paths: [fromDir] });
};

const runtimeChecks: readonly RuntimeCheck[] = [
  {
    package: "agents@0.17.3 (agents/mcp)",
    purpose:
      "MCP transport persist/replay fix (preserves tool results across dropped SSE connections)",
    resolveEntry: () => {
      const override = process.env.CHECK_PATCHED_DEPS_AGENTS_MCP;
      if (override && override.length > 0) return resolve(override);
      // `packages/hosts/cloudflare` is the workspace package that depends on
      // `agents`, so resolve the `agents/mcp` export from there.
      return resolveFrom("agents/mcp", "packages/hosts/cloudflare");
    },
    // These identifiers are introduced by patches/agents@0.17.3.patch and do
    // not exist in the upstream 0.17.3 dist.
    sentinels: ["markStreamUndelivered", "replayUndeliveredResponses", "mcpBridgeIsUnknownFrame"],
  },
];

for (const check of runtimeChecks) {
  let entry: string;
  try {
    entry = check.resolveEntry();
  } catch (err) {
    failures.push({
      package: check.package,
      detail: `could not resolve installed entry: ${(err as Error).message.split("\n")[0]}`,
    });
    continue;
  }

  if (!existsSync(entry)) {
    failures.push({ package: check.package, detail: `installed entry does not exist: ${entry}` });
    continue;
  }

  const contents = readFileSync(entry, "utf8");
  const missing = check.sentinels.filter((s) => !contents.includes(s));
  if (missing.length > 0) {
    failures.push({
      package: check.package,
      detail:
        `installed dist is missing post-patch sentinel(s): ${missing.join(", ")}\n` +
        `      entry: ${entry}\n` +
        `      patch purpose: ${check.purpose}`,
    });
  }
}

/**
 * Lightweight generalized layer: every package listed in `patchedDependencies`
 * must still have its referenced patch file on disk. This does not verify the
 * installed *content* for packages without a dedicated runtime check above
 * (that requires per-package sentinels), but it catches a patch entry pointing
 * at a missing file, which would make `bun install` silently skip patching.
 */
const rootPkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
  patchedDependencies?: Record<string, string>;
};
for (const [dep, patchPath] of Object.entries(rootPkg.patchedDependencies ?? {})) {
  const abs = resolve(repoRoot, patchPath);
  if (!existsSync(abs)) {
    failures.push({
      package: dep,
      detail: `patchedDependencies references a missing patch file: ${patchPath}`,
    });
  }
}

if (failures.length > 0) {
  const lines = failures.map((f) => `  - ${f.package}: ${f.detail}`).join("\n");
  console.error(
    `\nPatched-dependency check FAILED (${failures.length} problem(s)):\n${lines}\n\n` +
      "Cause: the installed dependency content does not match the patch we ship.\n" +
      "This is usually a stale bun store entry: bun kept an unpatched build of the\n" +
      "package in its cache and `bun install` reported no changes without applying\n" +
      "the patch. The deployed/tested code then silently lacks the patched behavior\n" +
      "(for `agents`, the MCP transport hang fix), with no other signal.\n\n" +
      "Fix: force a clean reinstall of the affected package's store entry, e.g.\n" +
      "  rm -rf node_modules/.bun/agents@* node_modules/agents\n" +
      "  bun install\n" +
      "If that does not take, clear bun's global cache for it:\n" +
      "  bun pm cache rm\n" +
      "  bun install\n",
  );
  process.exit(1);
}

console.log(
  `Patched-dependency check passed: ${runtimeChecks.length} runtime sentinel check(s), ` +
    `${Object.keys(rootPkg.patchedDependencies ?? {}).length} patch file(s) present.`,
);
