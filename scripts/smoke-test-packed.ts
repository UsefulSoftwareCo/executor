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
  "packages/core/fumadb",
  "packages/kernel/core",
  "packages/kernel/runtime-quickjs",
  "packages/core/sdk",
  "packages/core/api",
  "packages/core/config",
  "packages/core/execution",
  "packages/core/cli",
  "packages/plugins/example",
  "packages/plugins/file-secrets",
  "packages/plugins/graphql",
  "packages/plugins/keychain",
  "packages/plugins/mcp",
  "packages/plugins/onepassword",
  "packages/plugins/openapi",
] as const;

type PackageJson = {
  name: string;
  version: string;
  catalog?: Record<string, string>;
  dependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
  peerDependencies?: Record<string, string>;
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

// `import { X } from "@executor-js/sdk"` where the published entry doesn't
// export `X` — the packed bundle references a symbol that only exists on a
// different subpath (or in the dev-time workspace view). This is a bundle
// bug, never a missing-peer environment issue, so it's a hard failure.
const MISSING_EXPORT_RE =
  /The requested module '([^']+)' does not provide an export named '([^']+)'/;

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
  catalog: Readonly<Record<string, string>>,
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
      dependencies: {
        [pkg.name]: `file:${tarballPath}`,
        ...(pkg.name === "@executor-js/api" && pkg.peerDependencies?.effect
          ? {
              effect:
                pkg.peerDependencies.effect === "catalog:"
                  ? catalog.effect
                  : pkg.peerDependencies.effect,
            }
          : {}),
      },
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
    if (pkg.name === "@executor-js/api") {
      if (installedPkg.dependencies?.["@executor-js/host-mcp"] !== undefined) {
        failures.push({
          pkg: pkg.name,
          subpath: "<install>",
          reason: "published client manifest retains private @executor-js/host-mcp",
        });
        return;
      }
      const publishedSubpaths = Object.keys(installedPkg.exports ?? {});
      if (publishedSubpaths.length !== 1 || publishedSubpaths[0] !== "./client") {
        failures.push({
          pkg: pkg.name,
          subpath: "<install>",
          reason: `published API surface is ${publishedSubpaths.join(", ") || "empty"}`,
        });
        return;
      }
    }
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
      const missingExportMatch = stderr.match(MISSING_EXPORT_RE);
      if (missingExportMatch) {
        const [, module, symbol] = missingExportMatch;
        failures.push({
          pkg: pkg.name,
          subpath,
          reason: `published '${module}' does not export '${symbol}'`,
        });
        console.log(`  FAIL ${spec} — '${module}' does not export '${symbol}'`);
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

/**
 * Exercise the API tarball as an external consumer actually receives it: the
 * API itself is the only local tarball, and npm resolves every encoded runtime
 * dependency from the registry. The batch smoke above intentionally replaces
 * the full workspace graph with local tarballs; that is useful, but it can hide
 * a client import that relies on an SDK export which has not been published.
 */
const smokeTestApiCleanDependencyGraph = async (
  tarballs: Tarballs,
  catalog: Readonly<Record<string, string>>,
  failures: SmokeFailure[],
): Promise<void> => {
  const packageName = "@executor-js/api";
  const tarballPath = tarballs.get(packageName);
  if (!tarballPath) {
    failures.push({ pkg: packageName, subpath: "<clean-install>", reason: "no tarball produced" });
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), "executor-api-clean-smoke-"));
  try {
    const fixture = {
      name: "executor-api-clean-smoke-fixture",
      version: "0.0.0",
      private: true,
      type: "module",
      dependencies: {
        [packageName]: `file:${tarballPath}`,
        effect: catalog.effect,
        typescript: catalog.typescript,
      },
    };
    await writeFile(join(tmp, "package.json"), `${JSON.stringify(fixture, null, 2)}\n`);
    await writeFile(
      join(tmp, "consumer.ts"),
      [
        'import { makeExecutorApiClient } from "@executor-js/api/client";',
        'import type { ExecutorApiClient } from "@executor-js/api/client";',
        "void makeExecutorApiClient;",
        "const client: ExecutorApiClient | undefined = undefined;",
        "void client;",
        "",
      ].join("\n"),
    );

    const install = await $`npm install --no-audit --no-fund --legacy-peer-deps`
      .cwd(tmp)
      .quiet()
      .nothrow();
    if (install.exitCode !== 0) {
      failures.push({
        pkg: packageName,
        subpath: "<clean-install>",
        reason: install.stderr.toString().trim().split("\n").slice(-3).join("\n"),
      });
      return;
    }

    const installedApi = await readPackageJson(
      join(tmp, "node_modules", ...packageName.split("/")),
    );
    const sdkVersion = installedApi.dependencies?.["@executor-js/sdk"];
    if (!sdkVersion) {
      failures.push({
        pkg: packageName,
        subpath: "<clean-install>",
        reason: "packed manifest has no encoded @executor-js/sdk dependency",
      });
      return;
    }

    const lock = JSON.parse(await readFile(join(tmp, "package-lock.json"), "utf8")) as {
      readonly packages?: Readonly<Record<string, { readonly resolved?: string }>>;
    };
    const sdkResolution = lock.packages?.["node_modules/@executor-js/sdk"]?.resolved;
    if (!sdkResolution?.startsWith("https://registry.npmjs.org/")) {
      failures.push({
        pkg: packageName,
        subpath: "<clean-install>",
        reason: `SDK did not resolve from the public registry: ${sdkResolution ?? "missing"}`,
      });
      return;
    }

    const installedApiRoot = join(tmp, "node_modules", ...packageName.split("/"));
    const clientSource = await readFile(join(installedApiRoot, "dist", "client.js"), "utf8");
    if (/\bfrom\s+["']@executor-js\//u.test(clientSource)) {
      failures.push({
        pkg: packageName,
        subpath: "<clean-import>",
        reason: "runtime client still imports a workspace package instead of its bundled schemas",
      });
      return;
    }

    const probe =
      await $`node --input-type=module --eval ${`await import(${JSON.stringify(`${packageName}/client`)});`}`
        .cwd(tmp)
        .quiet()
        .nothrow();
    if (probe.exitCode !== 0) {
      const stderr = probe.stderr.toString();
      const missingExportMatch = stderr.match(MISSING_EXPORT_RE);
      const reason = missingExportMatch
        ? `published '${missingExportMatch[1]}' does not export '${missingExportMatch[2]}'`
        : firstMeaningfulLine(stderr);
      failures.push({ pkg: packageName, subpath: "<clean-import>", reason });
      console.log(`  FAIL ${packageName}/client — ${reason}`);
      return;
    }

    const typecheck =
      await $`npm exec --no -- tsc --noEmit --module ESNext --moduleResolution Bundler --target ESNext --skipLibCheck consumer.ts`
        .cwd(tmp)
        .quiet()
        .nothrow();
    if (typecheck.exitCode !== 0) {
      failures.push({
        pkg: packageName,
        subpath: "<clean-types>",
        reason: firstMeaningfulLine(
          `${typecheck.stdout.toString()}\n${typecheck.stderr.toString()}`,
        ),
      });
      return;
    }

    console.log(`  ok  ${packageName}/client (clean registry graph + types, SDK ${sdkVersion})`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
};

const main = async () => {
  const rootPackage = await readPackageJson(repoRoot);
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
    await smokeTestPackage(pkgDir, tarballs, rootPackage.catalog ?? {}, failures);
  }
  console.log("[smoke] @executor-js/api clean dependency graph");
  await smokeTestApiCleanDependencyGraph(tarballs, rootPackage.catalog ?? {}, failures);

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
