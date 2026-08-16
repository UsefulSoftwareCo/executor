#!/usr/bin/env bun
/** Verify that every root patched-dependency entry still names a real file. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

type Failure = { readonly package: string; readonly detail: string };
const failures: Failure[] = [];

const rootPkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
  patchedDependencies?: Record<string, string>;
};
for (const [dependency, patchPath] of Object.entries(rootPkg.patchedDependencies ?? {})) {
  if (existsSync(resolve(repoRoot, patchPath))) continue;
  failures.push({
    package: dependency,
    detail: `patchedDependencies references a missing patch file: ${patchPath}`,
  });
}

if (failures.length > 0) {
  const lines = failures.map((failure) => `  - ${failure.package}: ${failure.detail}`).join("\n");
  console.error(
    `\nPatched-dependency check FAILED (${failures.length} problem(s)):\n${lines}\n\n` +
      "Every patchedDependencies entry must reference a checked-in patch file.\n",
  );
  process.exit(1);
}

console.log(
  `Patched-dependency check passed: ${Object.keys(rootPkg.patchedDependencies ?? {}).length} patch file(s) present.`,
);
