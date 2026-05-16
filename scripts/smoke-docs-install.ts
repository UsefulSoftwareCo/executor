#!/usr/bin/env bun
/**
 * Verifies the SDK install command shown in docs resolves to a package we can
 * actually publish and consume.
 *
 * This intentionally installs the packed tarball under the documented package
 * name (`@executor-js/sdk`) instead of relying on workspace resolution.
 */
import { $ } from "bun";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const documentedPackages = ["@executor-js/sdk", "@executor-js/plugin-openapi"] as const;
const publicPackageDirs = [
  "packages/core/fumadb",
  "packages/core/sdk",
  "packages/core/config",
  "packages/plugins/openapi",
] as const;

const readPackageName = async (pkgDir: string): Promise<string> => {
  const raw = await readFile(join(pkgDir, "package.json"), "utf8");
  return (JSON.parse(raw) as { name: string }).name;
};

const findTarball = (pkgDir: string, packageName: string): string => {
  const tarball = readdirSync(pkgDir).find((entry) => entry.endsWith(".tgz"));
  if (!tarball) {
    throw new Error(`No packed tarball found for ${packageName}`);
  }
  return join(pkgDir, tarball);
};

console.log(`[docs-smoke] packing documented SDK packages`);
await $`bun run scripts/publish-packages.ts --dry-run`.cwd(repoRoot);

const tarballs = new Map<string, string>();
for (const relDir of publicPackageDirs) {
  const pkgDir = join(repoRoot, relDir);
  const name = await readPackageName(pkgDir);
  tarballs.set(name, findTarball(pkgDir, name));
}

const tmp = await mkdtemp(join(tmpdir(), "executor-docs-install-"));

try {
  const dependencies: Record<string, string> = {};
  const overrides: Record<string, string> = {};
  for (const [name, tarball] of tarballs) {
    overrides[name] = `file:${tarball}`;
  }
  for (const name of documentedPackages) {
    const tarball = tarballs.get(name);
    if (!tarball) {
      throw new Error(`No packed tarball found for documented package ${name}`);
    }
    dependencies[name] = `file:${tarball}`;
  }

  const fixture = {
    name: "executor-docs-install-smoke",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies,
    overrides,
  };

  await writeFile(join(tmp, "package.json"), `${JSON.stringify(fixture, null, 2)}\n`);

  console.log(`[docs-smoke] npm install ${documentedPackages.join(" ")}`);
  await $`npm install --no-audit --no-fund --legacy-peer-deps`.cwd(tmp);

  for (const packageName of documentedPackages) {
    const installedManifest = join(tmp, "node_modules", ...packageName.split("/"), "package.json");
    if (!existsSync(installedManifest)) {
      throw new Error(`Expected ${packageName} to be installed at ${installedManifest}`);
    }
    const manifest = await import(installedManifest, { with: { type: "json" } });
    if (manifest.default.name !== packageName) {
      throw new Error(
        `Expected installed package name to be ${packageName}, got ${manifest.default.name}`,
      );
    }
  }

  console.log(`[docs-smoke] import documented SDK packages`);
  await $`node --input-type=module --eval ${`const sdk = await import("@executor-js/sdk"); const openapi = await import("@executor-js/plugin-openapi"); if (typeof sdk.createExecutor !== "function") throw new Error("missing createExecutor"); if (typeof openapi.openApiPlugin !== "function") throw new Error("missing openApiPlugin");`}`.cwd(
    tmp,
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}
