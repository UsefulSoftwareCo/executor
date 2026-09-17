#!/usr/bin/env bun
/**
 * Verifies the SDK install command shown in docs resolves to a package we can
 * actually publish and consume.
 *
 * This intentionally installs the packed tarball under the documented package
 * name (`@executor-js/sdk`) instead of relying on workspace resolution.
 */
import { $ } from "bun";
import { Schema } from "effect";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const documentedPackages = [
  "@executor-js/sdk",
  "@executor-js/product-access",
  "@executor-js/plugin-openapi",
] as const;
const publicPackageDirs = [
  "packages/core/fumadb",
  "packages/core/sdk",
  "packages/core/product-access",
  "packages/core/config",
  "packages/plugins/openapi",
] as const;

const readPackageName = async (pkgDir: string): Promise<string> => {
  const raw = await readFile(join(pkgDir, "package.json"), "utf8");
  return (JSON.parse(raw) as { name: string }).name;
};

// `effect` is the SDK's (and product-access's) required peer, and the docs
// install command tells consumers to add it themselves. `npm install
// --legacy-peer-deps` below skips auto-installing peers, so the fixture must
// declare it like a real consumer would — pinned from the workspace catalog
// so it matches what the packed manifests resolved `catalog:` to.
const decodeCatalog = Schema.decodeUnknownSync(
  Schema.Struct({ catalog: Schema.Struct({ effect: Schema.NonEmptyString }) }),
);

const readCatalogEffectVersion = async (): Promise<string> => {
  const raw = await readFile(join(repoRoot, "package.json"), "utf8");
  const manifest = decodeCatalog(JSON.parse(raw));
  return manifest.catalog.effect;
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
  const dependencies: Record<string, string> = { effect: await readCatalogEffectVersion() };
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
  // The documented minimal embed: the SDK root export is the Promise façade
  // and ships no access posture of its own, so the probe constructs a
  // subject-less workspace-service executor with the posture from
  // `@executor-js/product-access` (ephemeral in-memory backend, nothing
  // invoked over the network) and closes it.
  const importProbe = [
    `const sdk = await import("@executor-js/sdk");`,
    `const access = await import("@executor-js/product-access");`,
    `const openapi = await import("@executor-js/plugin-openapi");`,
    `if (typeof sdk.createExecutor !== "function") throw new Error("missing createExecutor");`,
    `if (typeof access.workspaceServiceAccess !== "function") throw new Error("missing workspaceServiceAccess");`,
    `if (typeof openapi.openApiPlugin !== "function") throw new Error("missing openApiPlugin");`,
    `const executor = await sdk.createExecutor({ access: access.workspaceServiceAccess(), onElicitation: "accept-all" });`,
    `if (typeof executor.close !== "function") throw new Error("missing executor.close");`,
    `await executor.close();`,
  ].join("\n");
  await $`node --input-type=module --eval ${importProbe}`.cwd(tmp);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
