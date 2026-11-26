#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

type Pkg = { name?: string; private?: boolean };

const findWorkspacePackages = (): string[] => {
  const root = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
    workspaces?: string[];
  };
  const patterns = root.workspaces ?? [];
  const dirs = new Set<string>();
  for (const pattern of patterns) {
    for (const match of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: repoRoot })) {
      dirs.add(dirname(resolve(repoRoot, match)));
    }
  }
  return [...dirs].sort();
};

const STUB_TEMPLATE = (name: string) => `# ${name}\n`;

const fix = process.argv.includes("--fix");
const missing: string[] = [];

for (const pkgDir of findWorkspacePackages()) {
  const changelogPath = resolve(pkgDir, "CHANGELOG.md");
  if (existsSync(changelogPath)) continue;

  const pkg = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8")) as Pkg;
  const name = pkg.name ?? relative(repoRoot, pkgDir);

  if (fix) {
    writeFileSync(changelogPath, STUB_TEMPLATE(name));
    console.log(`Created stub: ${relative(repoRoot, changelogPath)}`);
  } else {
    missing.push(`${relative(repoRoot, pkgDir)} (${name})`);
  }
}

if (!fix && missing.length > 0) {
  console.error(
    `\nMissing CHANGELOG.md in ${missing.length} workspace package(s):\n  - ${missing.join("\n  - ")}\n\n` +
      "These seed files are required so Changesets can update every affected\n" +
      "workspace changelog during the Version Packages PR.\n\n" +
      "Run `bun run scripts/check-changelog-stubs.ts --fix` to create stubs.\n",
  );
  process.exit(1);
}
