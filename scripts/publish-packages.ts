#!/usr/bin/env bun
/**
 * Publishes the public @executor-js/* workspace packages to npm.
 *
 * Walks a hard-coded list of publishable package directories, determines the
 * dist-tag from the version string (anything containing `-` is treated as beta),
 * and packs + publishes each package whose current version is not already on npm.
 *
 * Invoked from `.github/workflows/release.yml` via the `publish:` input on
 * changesets/action after the Version Packages PR has been merged, and locally
 * via `bun run release:publish:packages` (or `--dry-run`).
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Channel = "latest" | "beta";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGE_SCOPE = "@executor-js";

/**
 * Workspace-relative paths of the public packages. Kept explicit so a new
 * directory under `packages/plugins/` does not accidentally ship to npm.
 */
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

const parseArgs = (argv: ReadonlyArray<string>): { dryRun: boolean; prepareOnly: boolean } => {
  let dryRun = false;
  let prepareOnly = false;
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--prepare-only") {
      prepareOnly = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { dryRun, prepareOnly };
};

const resolveChannel = (version: string): Channel => (version.includes("-") ? "beta" : "latest");

const readPackageMeta = async (pkgDir: string) => {
  const pkgJsonPath = join(pkgDir, "package.json");
  const pkg = (await Bun.file(pkgJsonPath).json()) as {
    name?: string;
    version?: string;
    private?: boolean;
  };

  if (!pkg.name || !pkg.version) {
    throw new Error(`Missing name/version in ${pkgJsonPath}`);
  }
  if (pkg.private === true) {
    throw new Error(`${pkg.name} is marked private and cannot be published`);
  }

  return { name: pkg.name, version: pkg.version };
};

const packageAlreadyPublished = async (name: string, version: string): Promise<boolean> => {
  const proc = Bun.spawn(["npm", "view", `${name}@${version}`, "version"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return (await proc.exited) === 0;
};

type DependencyBlock = Record<string, string>;
type PeerDependenciesMeta = Record<string, { optional?: boolean }>;
type MutablePackageJson = {
  name?: string;
  dependencies?: DependencyBlock;
  devDependencies?: DependencyBlock;
  peerDependencies?: DependencyBlock;
  peerDependenciesMeta?: PeerDependenciesMeta;
  optionalDependencies?: DependencyBlock;
  [key: string]: unknown;
};

/**
 * Resolves `workspace:*` dependencies between public packages to concrete
 * versions before packing. Returns a restore function that reverts package.json.
 *
 * Workspace-only `@executor-js/*` peer deps (e.g. `@executor-js/api`,
 * `@executor-js/react`) that aren't in `publishable` are stripped from
 * `peerDependencies` (and `peerDependenciesMeta`) entirely — they don't
 * exist on npm, so leaving them in the packed manifest would emit
 * install-time warnings for unresolvable packages.
 */
const applyWorkspaceVersions = async (
  pkgDir: string,
  publishable: ReadonlySet<string>,
  publishableVersions: ReadonlyMap<string, string>,
): Promise<() => Promise<void>> => {
  const isInternalScope = (key: string): boolean => key.startsWith(`${PACKAGE_SCOPE}/`);

  const renameDepBlock = (block: DependencyBlock | undefined): DependencyBlock | undefined => {
    if (!block) return block;
    const next: DependencyBlock = {};
    let mutated = false;
    for (const [key, value] of Object.entries(block)) {
      if (publishable.has(key) && value.startsWith("workspace:")) {
        next[key] = publishableVersions.get(key) ?? value;
        mutated = true;
      } else if (isInternalScope(key) && !publishable.has(key)) {
        // Workspace-only `@executor-js/*` regular dep that we don't
        // publish (e.g. `@executor-js/api`). Strip it: it's not in the
        // shipped runtime entries (those imports live in
        // `src/api/*` / `src/react/*` which don't make it into the
        // packed dist), and leaving it in would 404 at install time.
        mutated = true;
      } else {
        next[key] = value;
      }
    }
    return mutated ? next : block;
  };

  /**
   * Peer-deps variant of `renameDepBlock`: resolve workspace specifiers for
   * publishable peers, but DROP non-publishable `@executor-js/*` peers.
   * They reference workspace-only packages (`@executor-js/api`,
   * `@executor-js/react`) that don't exist on npm, so leaving them in
   * the packed manifest emits install-time warnings for unresolvable
   * packages. Non-`@executor-js` peers (`react`, `@tanstack/*`,
   * `@effect-atom/*`, etc.) are real npm packages and pass through
   * unchanged.
   */
  const renamePeerDepBlock = (block: DependencyBlock | undefined): DependencyBlock | undefined => {
    if (!block) return block;
    const next: DependencyBlock = {};
    let mutated = false;
    for (const [key, value] of Object.entries(block)) {
      if (publishable.has(key)) {
        next[key] = value.startsWith("workspace:")
          ? (publishableVersions.get(key) ?? value)
          : value;
        if (next[key] !== value) mutated = true;
      } else if (isInternalScope(key)) {
        // Workspace-only `@executor-js/*` peer that we don't publish —
        // strip it so the packed tarball doesn't reference an
        // npm package that doesn't exist.
        mutated = true;
      } else {
        next[key] = value;
      }
    }
    return mutated ? next : block;
  };

  /**
   * Strips `peerDependenciesMeta` entries that target an
   * `@executor-js/*` peer we don't publish, mirroring `renamePeerDepBlock`
   * so the meta block can't drift out of sync with the deps block.
   */
  const renamePeerMetaBlock = (
    block: PeerDependenciesMeta | undefined,
  ): PeerDependenciesMeta | undefined => {
    if (!block) return block;
    const next: PeerDependenciesMeta = {};
    let mutated = false;
    for (const [key, value] of Object.entries(block)) {
      if (publishable.has(key)) {
        next[key] = value;
      } else if (isInternalScope(key)) {
        mutated = true;
      } else {
        next[key] = value;
      }
    }
    return mutated ? next : block;
  };

  const pkgJsonPath = join(pkgDir, "package.json");
  const original = await readFile(pkgJsonPath, "utf8");
  const pkg = JSON.parse(original) as MutablePackageJson;
  pkg.dependencies = renameDepBlock(pkg.dependencies);
  pkg.devDependencies = renameDepBlock(pkg.devDependencies);
  pkg.peerDependencies = renamePeerDepBlock(pkg.peerDependencies);
  pkg.peerDependenciesMeta = renamePeerMetaBlock(pkg.peerDependenciesMeta);
  pkg.optionalDependencies = renameDepBlock(pkg.optionalDependencies);
  const pkgNext = `${JSON.stringify(pkg, null, 2)}\n`;
  if (pkgNext !== original) {
    await writeFile(pkgJsonPath, pkgNext);
    return async () => {
      await writeFile(pkgJsonPath, original);
    };
  }
  return async () => {};
};

/**
 * Applies `publishConfig` field overrides to package.json in place, returning a
 * function that restores the original file. `bun pm pack` does not substitute
 * `publishConfig.exports` / `publishConfig.main` etc at pack time (npm does,
 * but only for a subset of fields and only for `npm pack`), so we rewrite the
 * file ourselves so the packed tarball has the correct `exports` pointing at
 * `dist/` instead of the dev-time `src/index.ts`.
 */
const applyPublishConfig = async (pkgDir: string): Promise<() => Promise<void>> => {
  const pkgJsonPath = join(pkgDir, "package.json");
  const original = await readFile(pkgJsonPath, "utf8");
  const parsed = JSON.parse(original) as {
    publishConfig?: Record<string, unknown>;
    [key: string]: unknown;
  };

  const publishConfig = parsed.publishConfig;
  if (!publishConfig || typeof publishConfig !== "object") {
    return async () => {};
  }

  // Fields we allow publishConfig to override. `access`/`tag`/`registry` are
  // real npm publish-time config keys — they must NOT be hoisted into the
  // top-level manifest.
  const overridable = new Set([
    "exports",
    "main",
    "module",
    "types",
    "typings",
    "bin",
    "browser",
    "files",
  ]);

  const nextPublishConfig: Record<string, unknown> = {};
  let mutated = false;
  for (const [key, value] of Object.entries(publishConfig)) {
    if (overridable.has(key)) {
      parsed[key] = value;
      mutated = true;
    } else {
      nextPublishConfig[key] = value;
    }
  }

  if (!mutated) {
    return async () => {};
  }

  if (Object.keys(nextPublishConfig).length === 0) {
    delete parsed.publishConfig;
  } else {
    parsed.publishConfig = nextPublishConfig;
  }

  await writeFile(pkgJsonPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return async () => {
    await writeFile(pkgJsonPath, original);
  };
};

const publishPackage = async (
  pkgDir: string,
  dryRun: boolean,
  publishable: ReadonlySet<string>,
  publishableVersions: ReadonlyMap<string, string>,
) => {
  const { name, version } = await readPackageMeta(pkgDir);
  const channel = resolveChannel(version);

  if (!existsSync(join(pkgDir, "dist"))) {
    throw new Error(`Missing dist/ in ${pkgDir}. Did you run 'bun run build:packages'?`);
  }

  console.log(`[pack] ${name}@${version} (${channel})${dryRun ? " [dry-run]" : ""}`);

  // Clean any stale tarballs from previous runs so our readdir finds exactly
  // the archive produced by the pack below.
  const stale = (await readdir(pkgDir)).filter((entry) => entry.endsWith(".tgz"));
  for (const entry of stale) {
    await rm(join(pkgDir, entry), { force: true });
  }

  const restoreWorkspaceVersions = await applyWorkspaceVersions(
    pkgDir,
    publishable,
    publishableVersions,
  );
  const restorePublishConfig = await applyPublishConfig(pkgDir);
  try {
    await $`bun pm pack`.cwd(pkgDir);
  } finally {
    await restorePublishConfig();
    await restoreWorkspaceVersions();
  }

  const produced = (await readdir(pkgDir)).filter((entry) => entry.endsWith(".tgz"));
  if (produced.length !== 1) {
    throw new Error(
      `Expected exactly 1 .tgz in ${pkgDir}, found ${produced.length}: ${produced.join(", ")}`,
    );
  }
  const tarball = produced[0]!;

  if (dryRun) {
    return;
  }

  // Skip publishing already-shipped versions. The pack still ran above so
  // smoke tests / pkg-pr-new previews always have a fresh tarball.
  if (await packageAlreadyPublished(name, version)) {
    console.log(`[skip] ${name}@${version} already on npm`);
    return;
  }

  console.log(`[publish] ${name}@${version} (${channel})`);

  const args = ["publish", tarball, "--access", "public", "--tag", channel];
  if (process.env.GITHUB_ACTIONS === "true") {
    args.push("--provenance");
  }
  await $`npm ${args}`.cwd(pkgDir);
};

/**
 * Rewrite-in-place mode for the pkg.pr.new preview workflow. pkg-pr-new runs
 * `bun pm pack` against each workspace package directly, which can't see our
 * `publishConfig.exports` overrides or resolve `workspace:*` references. This
 * walks every public package, applies the same rewrites `publishPackage`
 * does, and intentionally leaves them mutated — the CI job is ephemeral and
 * the workflow tears down right after pkg-pr-new finishes.
 */
const prepareOnePackage = async (
  pkgDir: string,
  publishable: ReadonlySet<string>,
  publishableVersions: ReadonlyMap<string, string>,
) => {
  const { name, version } = await readPackageMeta(pkgDir);
  if (!existsSync(join(pkgDir, "dist"))) {
    throw new Error(`Missing dist/ in ${pkgDir}. Did you run 'bun run build:packages'?`);
  }
  console.log(`[prepare] ${name}@${version}`);
  await applyWorkspaceVersions(pkgDir, publishable, publishableVersions);
  await applyPublishConfig(pkgDir);
};

const main = async () => {
  const { dryRun, prepareOnly } = parseArgs(process.argv.slice(2));

  // Each package's own version determines its dist-tag (pre-release versions
  // with `-` publish to `beta`, everything else to `latest`). Packages are
  // only skipped when their current version is already on npm.
  const mode = prepareOnly ? " [prepare-only]" : dryRun ? " [dry-run]" : "";
  console.log(`Publishing ${PACKAGE_SCOPE} packages${mode}`);

  await $`bun run build:packages`.cwd(repoRoot);

  // Snapshot the public package names and versions up front so public
  // workspace dependencies can be written as exact versions in packed tarballs.
  const publishable = new Set<string>();
  const publishableVersions = new Map<string, string>();
  for (const relDir of PUBLIC_PACKAGE_DIRS) {
    const pkg = await readPackageMeta(join(repoRoot, relDir));
    publishable.add(pkg.name);
    publishableVersions.set(pkg.name, pkg.version);
  }

  if (prepareOnly) {
    for (const relDir of PUBLIC_PACKAGE_DIRS) {
      await prepareOnePackage(join(repoRoot, relDir), publishable, publishableVersions);
    }
    return;
  }

  for (const relDir of PUBLIC_PACKAGE_DIRS) {
    await publishPackage(join(repoRoot, relDir), dryRun, publishable, publishableVersions);
  }
};

await main();
