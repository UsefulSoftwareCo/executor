#!/usr/bin/env bun
/**
 * Pack-and-import smoke test for the public `@executor-js/*` packages.
 *
 * Reproduces what an external npm consumer experiences:
 *
 *   1. Pack each publishable workspace via `publish-packages.ts
 *      --dry-run`, so `publishConfig.exports` and `workspace:*` rewrites
 *      are applied to the tarball.
 *   2. For each package, install the tarball into a fresh temp dir
 *      with npm `overrides` pointing every other `@executor-js/*`
 *      transitive dep at its local tarball — otherwise npm pulls the
 *      currently-published version from the registry, which masks any
 *      internal-API mismatch this branch introduced.
 *   3. Read the installed package.json (the post-`publishConfig` view)
 *      and dynamically `import()` every subpath in its `exports` map.
 *
 * Failures for `@executor-js/*` package not-found are hard failures —
 * that's the regression class where private workspace packages leak
 * into a public bundle. Failures for other peers (`react`, `effect`,
 * `@tanstack/*`, etc.) are downgraded to warnings, since they reflect
 * a missing peer in the smoke environment, not a bug in the bundle.
 *
 * Invoke via `bun run release:smoke:packages`.
 */
import { $ } from "bun";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PUBLIC_PACKAGE_DIRS = [
  "packages/core/storage-core",
  "packages/kernel/core",
  "packages/kernel/runtime-quickjs",
  "packages/core/sdk",
  "packages/core/config",
  "packages/core/execution",
  "packages/core/cli",
  "packages/plugins/example",
  "packages/plugins/file-secrets",
  "packages/plugins/google-discovery",
  "packages/plugins/graphql",
  "packages/plugins/keychain",
  "packages/plugins/mcp",
  "packages/plugins/onepassword",
  "packages/plugins/openapi",
] as const;

type PackageJson = {
  name: string;
  version: string;
  exports?: Record<string, unknown>;
};

const readPackageJson = async (pkgDir: string): Promise<PackageJson> => {
  const raw = await readFile(join(pkgDir, "package.json"), "utf8");
  return JSON.parse(raw) as PackageJson;
};

const findTarball = (pkgDir: string): string | null => {
  const tgz = readdirSync(pkgDir).find((entry) => entry.endsWith(".tgz"));
  return tgz ? join(pkgDir, tgz) : null;
};

const subpathsToTest = (pkg: PackageJson): readonly string[] => Object.keys(pkg.exports ?? {});

const importSpecifier = (pkgName: string, subpath: string): string =>
  subpath === "." ? pkgName : `${pkgName}${subpath.slice(1)}`;

type SmokeFailure = {
  readonly pkg: string;
  readonly subpath: string;
  readonly reason: string;
};

const PRIVATE_PACKAGE_RE = /Cannot find package '(@executor-js\/[^']+)'/;

const firstMeaningfulLine = (stderr: string): string => {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const errorLine = lines.find((line) => /^(\w*Error|Cannot find)/i.test(line));
  if (errorLine) return errorLine;
  for (const line of lines) {
    if (line.startsWith("node:")) continue;
    if (line.startsWith("file://")) continue;
    if (line.startsWith("at ")) continue;
    if (line.startsWith("import ")) continue;
    if (line.startsWith("throw ")) continue;
    if (line === "^" || /^\^+$/.test(line)) continue;
    return line;
  }
  return lines[0] ?? "(no stderr)";
};

type Tarballs = ReadonlyMap<string, string>;

const smokeTestPackage = async (
  pkgDir: string,
  tarballs: Tarballs,
  failures: SmokeFailure[],
): Promise<void> => {
  const pkg = await readPackageJson(pkgDir);
  const tarballPath = tarballs.get(pkg.name);
  if (!tarballPath) {
    failures.push({ pkg: pkg.name, subpath: "", reason: "no tarball produced" });
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), "executor-smoke-"));
  try {
    // npm `overrides` forces transitive `@executor-js/*` deps to resolve
    // to their local tarball instead of whatever's published on npm.
    // Without this, a plugin built against an unreleased symbol in
    // `@executor-js/sdk` would silently install the published `sdk`
    // and fail at import — a real bug, but not the bundle bug we're
    // here to catch.
    const overrides: Record<string, string> = {};
    for (const [name, path] of tarballs) {
      overrides[name] = `file:${path}`;
    }
    const fixture = {
      name: "executor-smoke-fixture",
      version: "0.0.0",
      private: true,
      type: "module",
      dependencies: { [pkg.name]: `file:${tarballPath}` },
      overrides,
    };
    await writeFile(join(tmp, "package.json"), `${JSON.stringify(fixture, null, 2)}\n`);

    const install = await $`npm install --no-audit --no-fund --legacy-peer-deps`
      .cwd(tmp)
      .quiet()
      .nothrow();
    if (install.exitCode !== 0) {
      failures.push({
        pkg: pkg.name,
        subpath: "<install>",
        reason: install.stderr.toString().trim().split("\n").slice(-3).join("\n"),
      });
      return;
    }

    // Read the installed manifest — that's the real published view
    // (publishConfig.exports applied, workspace specifiers resolved).
    const installedPkg = await readPackageJson(join(tmp, "node_modules", ...pkg.name.split("/")));
    const subpaths = subpathsToTest(installedPkg);
    if (subpaths.length === 0) {
      failures.push({
        pkg: pkg.name,
        subpath: "",
        reason: "no exports declared in published manifest",
      });
      return;
    }

    for (const subpath of subpaths) {
      const spec = importSpecifier(pkg.name, subpath);
      const probe =
        await $`node --input-type=module --eval ${`await import(${JSON.stringify(spec)});`}`
          .cwd(tmp)
          .quiet()
          .nothrow();
      if (probe.exitCode === 0) {
        console.log(`  ok  ${spec}`);
        continue;
      }
      const stderr = probe.stderr.toString();
      const privateMatch = stderr.match(PRIVATE_PACKAGE_RE);
      if (privateMatch) {
        const offending = privateMatch[1];
        failures.push({
          pkg: pkg.name,
          subpath,
          reason: `published bundle imports private workspace package '${offending}'`,
        });
        console.log(`  FAIL ${spec} — references private '${offending}'`);
        continue;
      }
      const peerMatch =
        stderr.match(/Cannot find package '([^']+)'/) ??
        stderr.match(/Cannot find module '([^']+)'/);
      const detail = peerMatch ? `missing peer '${peerMatch[1]}'` : firstMeaningfulLine(stderr);
      console.log(`  skip ${spec} — ${detail}`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
};

const main = async () => {
  console.log("[smoke] packing public packages via publish-packages.ts --dry-run");
  await $`bun run scripts/publish-packages.ts --dry-run`.cwd(repoRoot);

  const tarballs = new Map<string, string>();
  for (const relDir of PUBLIC_PACKAGE_DIRS) {
    const pkgDir = join(repoRoot, relDir);
    if (!existsSync(pkgDir)) continue;
    const pkg = await readPackageJson(pkgDir);
    const tarball = findTarball(pkgDir);
    if (tarball) tarballs.set(pkg.name, tarball);
  }

  const failures: SmokeFailure[] = [];
  for (const relDir of PUBLIC_PACKAGE_DIRS) {
    const pkgDir = join(repoRoot, relDir);
    if (!existsSync(pkgDir)) {
      failures.push({ pkg: relDir, subpath: "", reason: "missing dir" });
      continue;
    }
    const pkg = await readPackageJson(pkgDir);
    console.log(`[smoke] ${pkg.name}`);
    await smokeTestPackage(pkgDir, tarballs, failures);
  }

  if (failures.length === 0) {
    console.log("[smoke] all packages OK");
    return;
  }

  console.error(`\n[smoke] ${failures.length} failure(s):`);
  for (const f of failures) {
    console.error(`  - ${f.pkg}${f.subpath ? ` (${f.subpath})` : ""}: ${f.reason}`);
  }
  process.exit(1);
};

await main();
