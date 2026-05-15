import { cp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { $ } from "bun";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliRoot = resolve(repoRoot, "apps/cli");
const webRoot = resolve(repoRoot, "apps/local");
const distDir = resolve(cliRoot, "dist");

const resolveQuickJsWasmPath = (): string => {
  const req = createRequire(join(repoRoot, "packages/kernel/runtime-quickjs/package.json"));
  const quickJsPkg = req.resolve("quickjs-emscripten/package.json");
  const wasmPath = resolve(
    dirname(quickJsPkg),
    "../@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm",
  );
  if (!existsSync(wasmPath)) throw new Error(`QuickJS WASM not found at ${wasmPath}`);
  return wasmPath;
};

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

const readMetadata = async () => {
  const rootPkg = await Bun.file(join(repoRoot, "package.json")).json();
  const cliPkg = await Bun.file(join(cliRoot, "package.json")).json();
  return {
    name: "executor",
    version: process.env.EXECUTOR_VERSION ?? cliPkg.version ?? rootPkg.version ?? "0.0.0",
    description:
      rootPkg.description ?? "Local AI executor with a CLI, local API server, and web UI.",
    keywords: rootPkg.keywords ?? [],
    homepage: rootPkg.homepage,
    bugs: rootPkg.bugs,
    repository: rootPkg.repository,
    license: rootPkg.license ?? "MIT",
  };
};

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

type Target = {
  os: "linux" | "darwin" | "win32";
  arch: "x64" | "arm64";
  abi?: "musl";
};

const ALL_TARGETS: Target[] = [
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "linux", arch: "arm64", abi: "musl" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "arm64" },
  { os: "win32", arch: "x64" },
  { os: "win32", arch: "arm64" },
];

const platformName = (t: Target) => (t.os === "win32" ? "windows" : t.os);

/** Per-platform suffix used in dist directory names, npm dist-tags, and the
 *  semver prerelease segment of variant package versions. e.g. "linux-x64",
 *  "linux-x64-musl", "darwin-arm64". */
const platformTag = (t: Target) => [platformName(t), t.arch, t.abi].filter(Boolean).join("-");

/** Dist directory name (e.g. dist/executor-linux-x64). Only used as a build
 *  artifact convention; the actual npm package name inside is `executor`. */
const targetPackageName = (t: Target) => `executor-${platformTag(t)}`;

const bunTargetKeys = [
  "linux-x64",
  "linux-arm64",
  "linux-x64-musl",
  "linux-arm64-musl",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "win32-arm64",
] as const;
type BunTargetKey = (typeof bunTargetKeys)[number];

const bunTargets = {
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "linux-x64-musl": "bun-linux-x64-musl",
  "linux-arm64-musl": "bun-linux-arm64-musl",
  "darwin-x64": "bun-darwin-x64",
  "darwin-arm64": "bun-darwin-arm64",
  "win32-x64": "bun-windows-x64",
  "win32-arm64": "bun-windows-arm64",
} satisfies Record<BunTargetKey, Bun.Build.CompileTarget>;

const isBunTargetKey = (key: string): key is BunTargetKey =>
  bunTargetKeys.includes(key as BunTargetKey);

const bunTarget = (t: Target): Bun.Build.CompileTarget => {
  const key = [t.os, t.arch, t.abi].filter(Boolean).join("-");
  if (!isBunTargetKey(key)) throw new Error(`Unsupported Bun compile target: ${key}`);
  const target = bunTargets[key];
  return target;
};

const binaryName = (t: Target) => (t.os === "win32" ? "executor.exe" : "executor");

const isCurrentPlatform = (t: Target) =>
  t.os === process.platform && t.arch === process.arch && !t.abi;

/**
 * Resolve the platform-specific @napi-rs/keyring native binding for a target.
 *
 * `bun build --compile` doesn't include `.node` modules in bunfs, so the
 * keyring loader's dynamic `require('@napi-rs/keyring-<plat>-<arch>')` fails
 * at runtime. We copy the `.node` file next to the executor and main.ts sets
 * `NAPI_RS_NATIVE_LIBRARY_PATH` so the loader's env-var escape hatch picks it
 * up instead of trying to walk node_modules.
 */
const resolveKeyringNative = (t: Target): string | null => {
  const platformMap: Record<string, { pkg: string; node: string }> = {
    "darwin-arm64": { pkg: "@napi-rs/keyring-darwin-arm64", node: "keyring.darwin-arm64.node" },
    "darwin-x64": { pkg: "@napi-rs/keyring-darwin-x64", node: "keyring.darwin-x64.node" },
    "linux-arm64": {
      pkg: "@napi-rs/keyring-linux-arm64-gnu",
      node: "keyring.linux-arm64-gnu.node",
    },
    "linux-x64": { pkg: "@napi-rs/keyring-linux-x64-gnu", node: "keyring.linux-x64-gnu.node" },
    "linux-arm64-musl": {
      pkg: "@napi-rs/keyring-linux-arm64-musl",
      node: "keyring.linux-arm64-musl.node",
    },
    "linux-x64-musl": {
      pkg: "@napi-rs/keyring-linux-x64-musl",
      node: "keyring.linux-x64-musl.node",
    },
    "win32-arm64": {
      pkg: "@napi-rs/keyring-win32-arm64-msvc",
      node: "keyring.win32-arm64-msvc.node",
    },
    "win32-x64": { pkg: "@napi-rs/keyring-win32-x64-msvc", node: "keyring.win32-x64-msvc.node" },
  };
  const key = [t.os, t.arch, t.abi].filter(Boolean).join("-");
  const entry = platformMap[key];
  if (!entry) return null;
  try {
    const req = createRequire(join(repoRoot, "node_modules", "@napi-rs/keyring", "package.json"));
    const pkgJson = req.resolve(`${entry.pkg}/package.json`);
    return join(dirname(pkgJson), entry.node);
  } catch {
    const bunPath = join(
      repoRoot,
      `node_modules/.bun/${entry.pkg.replace("/", "+")}@1.2.0/node_modules/${entry.pkg}/${entry.node}`,
    );
    if (existsSync(bunPath)) return bunPath;
    return null;
  }
};

// ---------------------------------------------------------------------------
// Build mode
// ---------------------------------------------------------------------------

type BuildMode = "production" | "development";

// ---------------------------------------------------------------------------
// Build web app
// ---------------------------------------------------------------------------

const buildWeb = async (mode: BuildMode) => {
  const webDist = join(webRoot, "dist");
  await rm(webDist, { recursive: true, force: true });

  console.log(`Building web app (${mode})...`);
  const proc = Bun.spawn(["bun", "run", "build", "--mode", mode], {
    cwd: webRoot,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, NODE_ENV: mode },
  });
  if ((await proc.exited) !== 0) throw new Error("Web build failed");
  return webDist;
};

// ---------------------------------------------------------------------------
// Embedded web UI — generates a virtual module that imports all web assets
// using `with { type: "file" }` so Bun bakes them into the compiled binary.
// ---------------------------------------------------------------------------

const createEmbeddedWebUISource = async (mode: BuildMode) => {
  const webDist = await buildWeb(mode);
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: webDist })))
    .map((f) => f.replaceAll("\\", "/"))
    .sort();

  const imports = files.map((file, i) => {
    const spec = join(webDist, file).replaceAll("\\", "/");
    return `import file_${i} from ${JSON.stringify(spec)} with { type: "file" };`;
  });

  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`);

  return [
    "// Auto-generated — maps web UI paths to embedded file references",
    ...imports,
    "export default {",
    ...entries,
    "} as Record<string, string>;",
  ].join("\n");
};

// ---------------------------------------------------------------------------
// Embedded drizzle migrations — inlined as text imports so drizzle's
// `migrate()` (which reads a folder from disk) can be given a tmpdir
// populated from the inlined contents at runtime.
// ---------------------------------------------------------------------------

const createEmbeddedMigrationsSource = async () => {
  const migrationsDir = resolve(webRoot, "drizzle");
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: migrationsDir })))
    .map((f) => f.replaceAll("\\", "/"))
    .sort();

  const imports = files.map((file, i) => {
    const spec = join(migrationsDir, file).replaceAll("\\", "/");
    return `import file_${i} from ${JSON.stringify(spec)} with { type: "text" };`;
  });

  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`);

  return [
    "// Auto-generated — maps migration paths to inlined file contents",
    ...imports,
    "export default {",
    ...entries,
    "} as Record<string, string>;",
  ].join("\n");
};

// ---------------------------------------------------------------------------
// Build platform binaries
// ---------------------------------------------------------------------------

const EMBEDDED_WEB_UI_STUB = `const files: Record<string, string> | null = null;\n\nexport default files;\n`;
const EMBEDDED_MIGRATIONS_STUB = `const migrations: Record<string, string> | null = null;\n\nexport default migrations;\n`;

const buildBinaries = async (targets: Target[], mode: BuildMode) => {
  const meta = await readMetadata();
  const binaries: Record<string, string> = {};
  const embeddedWebUIPath = join(cliRoot, "src/embedded-web-ui.gen.ts");
  const embeddedMigrationsPath = join(webRoot, "src/server/embedded-migrations.gen.ts");

  await rm(distDir, { recursive: true, force: true });

  // Cross-platform builds need every target's optional native packages
  // (e.g. @napi-rs/keyring-darwin-arm64) so we can copy the right .node next
  // to each target's executor. `bun install --frozen-lockfile --cpu=* --os=*`
  // extracts them all without modifying the lockfile.
  const needsCrossPlatform = targets.some((t) => !isCurrentPlatform(t));
  if (needsCrossPlatform) {
    console.log("Installing optional native deps for all platforms...");
    const proc = Bun.spawn(["bun", "install", "--frozen-lockfile", "--cpu=*", "--os=*"], {
      cwd: repoRoot,
      stdio: ["ignore", "inherit", "inherit"],
    });
    if ((await proc.exited) !== 0) {
      throw new Error("bun install --cpu=* --os=* failed");
    }
  }

  console.log(`Generating embedded web UI bundle (${mode})...`);
  const embeddedWebUI = await createEmbeddedWebUISource(mode);
  await writeFile(embeddedWebUIPath, `${embeddedWebUI}\n`);

  console.log("Generating embedded drizzle migrations...");
  const embeddedMigrations = await createEmbeddedMigrationsSource();
  await writeFile(embeddedMigrationsPath, `${embeddedMigrations}\n`);

  const quickJsWasmPath = resolveQuickJsWasmPath();

  try {
    for (const target of targets) {
      const name = targetPackageName(target);
      const outDir = join(distDir, name);
      const binDir = join(outDir, "bin");
      await mkdir(binDir, { recursive: true });

      console.log(`Building ${name}...`);

      await Bun.build({
        entrypoints: [join(cliRoot, "src/main.ts")],
        minify: mode === "production",
        compile: {
          target: bunTarget(target),
          outfile: join(binDir, binaryName(target)),
        },
      });

      // Copy QuickJS WASM next to binary — loaded at runtime by the server
      await cp(quickJsWasmPath, join(binDir, "emscripten-module.wasm"));

      // Copy @napi-rs/keyring native binding next to executor — bun --compile
      // doesn't bundle .node files, so the loader needs to find it on disk
      // via NAPI_RS_NATIVE_LIBRARY_PATH (set in main.ts).
      const keyringNative = resolveKeyringNative(target);
      if (keyringNative && existsSync(keyringNative)) {
        await cp(keyringNative, join(binDir, "keyring.node"));
      }

      // Smoke test on current platform
      if (isCurrentPlatform(target)) {
        const bin = join(binDir, binaryName(target));
        console.log(`  Smoke test: ${bin} --version`);
        const version = await $`${bin} --version`.text();
        console.log(`  OK: ${version.trim()}`);
      }

      // Variant package.json. All variants publish to the SAME npm package
      // name (`executor`) under platform-tagged versions (e.g.
      // `1.4.14-linux-x64`). The wrapper references each variant via an
      // `npm:` alias in its optionalDependencies. This mirrors codex's
      // pattern and avoids ever having to claim a new npm package name when
      // a new platform is added — a single trusted-publishing config on the
      // `executor` package covers everything.
      //
      // No `bin` field on purpose — the wrapper's launcher resolves the
      // platform binary via require.resolve on the alias name and execs it.
      const tag = platformTag(target);
      const variantVersion = `${meta.version}-${tag}`;
      await writeFile(
        join(outDir, "package.json"),
        JSON.stringify(
          {
            name: meta.name,
            version: variantVersion,
            description: `${meta.description} (${tag})`,
            os: [target.os],
            cpu: [target.arch],
            homepage: meta.homepage,
            bugs: meta.bugs,
            repository: meta.repository,
            license: meta.license,
          },
          null,
          2,
        ) + "\n",
      );

      // The local alias name (`executor-linux-x64`, ...) is what the
      // wrapper's launcher passes to require.resolve at runtime. It's
      // bound at install time by npm's `npm:executor@<variant-version>`
      // alias spec in optionalDependencies.
      const aliasName = `${meta.name}-${tag}`;
      binaries[aliasName] = `npm:${meta.name}@${variantVersion}`;
    }

    return binaries;
  } finally {
    await writeFile(embeddedWebUIPath, EMBEDDED_WEB_UI_STUB);
    await writeFile(embeddedMigrationsPath, EMBEDDED_MIGRATIONS_STUB);
  }
};

// ---------------------------------------------------------------------------
// Build wrapper npm package
// ---------------------------------------------------------------------------

const buildWrapperPackage = async (binaries: Record<string, string>) => {
  const meta = await readMetadata();
  const wrapperDir = join(distDir, meta.name);
  const binDir = join(wrapperDir, "bin");

  await mkdir(binDir, { recursive: true });

  // Node.js launcher — resolves the platform binary via require.resolve
  // against optionalDependencies and execs it. No postinstall: the binary
  // ships as an os/cpu-filtered optional dep, the launcher resolves it at
  // runtime. This works whether or not the package manager runs postinstalls
  // (bun blocks them by default).
  await writeFile(join(binDir, "executor"), NODE_SHIM);
  await chmod(join(binDir, "executor"), 0o755);

  await writeFile(
    join(wrapperDir, "package.json"),
    JSON.stringify(
      {
        name: meta.name,
        version: meta.version,
        description: meta.description,
        keywords: meta.keywords,
        homepage: meta.homepage,
        bugs: meta.bugs,
        repository: meta.repository,
        license: meta.license,
        bin: { executor: "bin/executor" },
        // Per-platform compiled binaries published as platform-tagged
        // versions of `executor` itself, referenced via npm:alias specs:
        //   "executor-linux-x64": "npm:executor@1.4.14-linux-x64"
        // npm/bun fetch only the variant matching the current os/cpu (set
        // on each variant's package.json); everything else is a no-op.
        // The local alias name on the left is what the launcher passes to
        // require.resolve at runtime — npm puts the variant at
        // `node_modules/executor-<plat>-<arch>/` so resolution just works.
        optionalDependencies: binaries,
        engines: {
          node: ">=20",
        },
      },
      null,
      2,
    ) + "\n",
  );

  const readmePath = join(repoRoot, "README.md");
  if (existsSync(readmePath)) {
    await cp(readmePath, join(wrapperDir, "README.md"));
  }

  console.log(`\nWrapper package: ${wrapperDir}`);
  console.log(`  ${meta.name}@${meta.version}`);
  console.log(`  optionalDependencies: ${Object.keys(binaries).join(", ")}`);
};

// ---------------------------------------------------------------------------
// Preview wrapper — a slim npm package for pkg.pr.new previews that fetches
// the platform binary from our R2 bucket at install time.
//
// The release wrapper points postinstall at GitHub Releases. For previews
// there's no release, so we upload per-PR tarballs to R2 (keyed by commit
// SHA) and have a dedicated postinstall download from there.
//
// CI splits this in two:
//   1. A matrix job per platform runs `buildPreviewTarballs` to produce
//      dist/previews/<platform>.tar.gz, which it uploads to R2.
//   2. A single publish job runs `buildPreviewWrapperPackage` with an
//      explicit list of platforms and hands the wrapper to pkg.pr.new.
//
// Both paths require EXECUTOR_PREVIEW_CDN_URL and EXECUTOR_PREVIEW_SHA so
// the postinstall URL embeds the right commit.
// ---------------------------------------------------------------------------

const buildPreviewTarballs = async (binaries: Record<string, string>) => {
  const previewDir = join(distDir, "previews");
  await mkdir(previewDir, { recursive: true });
  for (const platformPkg of Object.keys(binaries)) {
    const srcBinDir = join(distDir, platformPkg, "bin");
    const tarPath = join(previewDir, `${platformPkg}.tar.gz`);
    await $`tar -czf ${tarPath} .`.cwd(srcBinDir).quiet();
    console.log(`Preview tarball: ${tarPath}`);
  }
};

const resolveTargetsFromEnv = (env: string | undefined): Target[] => {
  if (!env) throw new Error("EXECUTOR_PREVIEW_TARGETS must be set (comma-separated package names)");
  const names = env
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const resolved = names.map((name) => {
    const match = ALL_TARGETS.find((t) => targetPackageName(t) === name);
    if (!match) throw new Error(`Unknown preview target: ${name}`);
    return match;
  });
  if (resolved.length === 0) throw new Error("EXECUTOR_PREVIEW_TARGETS resolved to an empty list");
  return resolved;
};

const buildPreviewWrapperPackage = async (targets: Target[]) => {
  const meta = await readMetadata();
  const cdnUrl = process.env.EXECUTOR_PREVIEW_CDN_URL?.replace(/\/+$/, "");
  const sha = process.env.EXECUTOR_PREVIEW_SHA;
  if (!cdnUrl || !sha) {
    throw new Error(
      "preview build requires EXECUTOR_PREVIEW_CDN_URL and EXECUTOR_PREVIEW_SHA to be set",
    );
  }

  const wrapperDir = join(distDir, meta.name);
  const binDir = join(wrapperDir, "bin");
  await mkdir(binDir, { recursive: true });

  await writeFile(join(binDir, "executor"), NODE_SHIM);
  await chmod(join(binDir, "executor"), 0o755);

  const postinstall = PREVIEW_POSTINSTALL_SCRIPT.replaceAll("__CDN_BASE_URL__", `${cdnUrl}/${sha}`);
  await writeFile(join(wrapperDir, "postinstall.cjs"), postinstall);

  // Restrict os/cpu to platforms we actually built this run so npm refuses
  // the install on anything else — a clear error beats a cryptic 404 from
  // postinstall on an unbuilt platform.
  const osList = Array.from(new Set(targets.map((t) => t.os)));
  const cpuList = Array.from(new Set(targets.map((t) => t.arch)));

  await writeFile(
    join(wrapperDir, "package.json"),
    JSON.stringify(
      {
        name: meta.name,
        version: meta.version,
        description: meta.description,
        keywords: meta.keywords,
        homepage: meta.homepage,
        bugs: meta.bugs,
        repository: meta.repository,
        license: meta.license,
        bin: { executor: "bin/executor" },
        files: ["bin", "postinstall.cjs", "README.md"],
        scripts: { postinstall: "node ./postinstall.cjs" },
        os: osList,
        cpu: cpuList,
        engines: { node: ">=20" },
      },
      null,
      2,
    ) + "\n",
  );

  const readmePath = join(repoRoot, "README.md");
  if (existsSync(readmePath)) {
    await cp(readmePath, join(wrapperDir, "README.md"));
  }

  console.log(`\nPreview wrapper: ${wrapperDir}`);
  console.log(`  ${meta.name}@${meta.version} — CDN ${cdnUrl}/${sha}`);
  console.log(`  targets: ${targets.map(targetPackageName).join(", ")}`);
};

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

const packageAlreadyPublished = async (pkgDir: string) => {
  const pkg = (await Bun.file(join(pkgDir, "package.json")).json()) as {
    name?: string;
    version?: string;
  };

  if (!pkg.name || !pkg.version) {
    throw new Error(`Missing name/version in ${join(pkgDir, "package.json")}`);
  }

  const proc = Bun.spawn(["npm", "view", `${pkg.name}@${pkg.version}`, "version"], {
    cwd: pkgDir,
    stdio: ["ignore", "ignore", "ignore"],
  });

  return (await proc.exited) === 0;
};

/** Recognize npm error output for "this version already exists." Used to
 *  make publish retries idempotent — if a previous workflow run got partway
 *  through and crashed, we should skip what's already on the registry and
 *  push the rest. Mirrors codex's `rust-release.yml` skip pattern. */
const ALREADY_PUBLISHED_RE = /previously published|cannot publish over|version already exists/i;

const publishPackedPackage = async (pkgDir: string, channel: string) => {
  if (await packageAlreadyPublished(pkgDir)) {
    console.log(`Skipping ${pkgDir}; package version already exists on npm.`);
    return;
  }

  await $`bun pm pack`.cwd(pkgDir);

  const provenance = process.env.GITHUB_ACTIONS === "true" ? ["--provenance"] : [];
  const result = await $`npm publish *.tgz --access public --tag ${channel} ${provenance}`
    .cwd(pkgDir)
    .nothrow()
    .quiet();

  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  process.stdout.write(stdout);
  process.stderr.write(stderr);

  if (result.exitCode === 0) return;

  // The pre-check via `npm view` has a propagation race — even when an
  // earlier publish in this same run committed, `npm view` may 404 for a few
  // seconds. Treat "already published" errors as success on retry.
  if (ALREADY_PUBLISHED_RE.test(stderr) || ALREADY_PUBLISHED_RE.test(stdout)) {
    console.log(`Skipping ${pkgDir}; npm reported version already published.`);
    return;
  }

  throw new Error(`npm publish failed for ${pkgDir} (exit ${result.exitCode})`);
};

/** Extract the platform-tag suffix from a variant version string.
 *  e.g. "1.4.14-linux-x64" -> "linux-x64".
 *  Variants get a per-platform npm dist-tag (not `latest` or `beta`) so
 *  publishing them doesn't move the channel pointer. The wrapper alone
 *  drives `latest`/`beta`. */
const variantTagFromVersion = (version: string): string => {
  const idx = version.indexOf("-");
  if (idx === -1) {
    throw new Error(
      `Variant version missing platform-tag suffix (expected '<base>-<tag>'): ${version}`,
    );
  }
  return version.slice(idx + 1);
};

const publish = async (channel: string) => {
  const meta = await readMetadata();

  // Variants publish first so the wrapper's optionalDependencies resolve.
  // All variants and the wrapper publish to the same npm package
  // (`executor`) — variants under platform-tagged versions, wrapper under
  // the channel tag. Single trusted-publishing config covers everything.
  const platformDirs: string[] = [];
  for (const entry of new Bun.Glob("executor-*/package.json").scanSync({ cwd: distDir })) {
    platformDirs.push(join(distDir, dirname(entry)));
  }
  platformDirs.sort();

  // Publish variants sequentially. They all PUT to the same npm package
  // (`executor`), and the registry rejects concurrent packument updates with
  // 409 Conflict ("Failed to save packument. A common cause is if you try to
  // publish a new package before the previous package has been fully
  // processed.") — that's exactly what happened on v1.4.14's first attempt,
  // where 3 of 8 raced through and the rest 409'd. Serial is plenty fast
  // (~5s per variant × 8 ≈ 40s).
  console.log(`Publishing ${platformDirs.length} platform variant(s)...`);
  for (const dir of platformDirs) {
    const pkg = (await Bun.file(join(dir, "package.json")).json()) as { version: string };
    const tag = variantTagFromVersion(pkg.version);
    await publishPackedPackage(dir, tag);
  }

  const wrapperDir = join(distDir, meta.name);
  console.log(`Publishing wrapper ${wrapperDir} under @${channel}...`);
  await publishPackedPackage(wrapperDir, channel);
};

// ---------------------------------------------------------------------------
// GitHub release assets
// ---------------------------------------------------------------------------

const ZIP_ASSET_SCRIPT = [
  "import pathlib, sys, zipfile",
  "output = pathlib.Path(sys.argv[1])",
  "with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:",
  "    for path in pathlib.Path('.').rglob('*'):",
  "        if path.is_file():",
  "            archive.write(path, path.as_posix())",
].join("\n");

const createReleaseAssets = async () => {
  // The dir name (e.g. "executor-linux-x64") still encodes the platform tag.
  // Don't read `pkg.name` here — under the npm:alias pattern every variant's
  // package.json has the same `name: "executor"`, so all assets would collide
  // on the same filename.
  for (const entry of new Bun.Glob("executor-*/package.json").scanSync({ cwd: distDir })) {
    const dirName = dirname(entry);
    const pkgDir = join(distDir, dirName);

    if (dirName.includes("linux")) {
      await $`tar -czf ${join(distDir, `${dirName}.tar.gz`)} *`.cwd(join(pkgDir, "bin"));
    } else {
      await $`python3 -c ${ZIP_ASSET_SCRIPT} ${join(distDir, `${dirName}.zip`)}`.cwd(
        join(pkgDir, "bin"),
      );
    }

    console.log(`Created release asset: ${dirName}`);
  }
};

// ---------------------------------------------------------------------------
// Node.js launcher — resolves the platform binary shipped as an
// optionalDependency and execs it. Resolution order:
//   1. EXECUTOR_BIN_PATH override
//   2. require.resolve("executor-<platform>-<arch>/package.json")
//   3. bin/runtime/<binary> (preview wrapper compat — pkg.pr.new previews
//      download the binary here at install time instead of via
//      optionalDependencies)
//
// Signals (SIGINT/SIGTERM/SIGHUP) are forwarded to the child so long-running
// commands like `executor web` shut down cleanly under Ctrl-C.
// ---------------------------------------------------------------------------

const NODE_SHIM = `#!/usr/bin/env node
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

function spawnAndExit(target) {
  const child = childProcess.spawn(target, process.argv.slice(2), { stdio: "inherit" });
  child.on("error", (err) => { console.error(err.message); process.exit(1); });
  const forward = (signal) => { if (!child.killed) { try { child.kill(signal); } catch {} } };
  ["SIGINT", "SIGTERM", "SIGHUP"].forEach((sig) => process.on(sig, () => forward(sig)));
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(typeof code === "number" ? code : 0);
  });
}

if (process.env.EXECUTOR_BIN_PATH) {
  spawnAndExit(process.env.EXECUTOR_BIN_PATH);
  return;
}

const isWin = process.platform === "win32";
const binary = isWin ? "executor.exe" : "executor";

// Package names use "windows" (not "win32") to match what the build script emits.
const platformMap = { darwin: "darwin", linux: "linux", win32: "windows" };
const archMap = { x64: "x64", arm64: "arm64" };
const platform = platformMap[os.platform()] || os.platform();
const arch = archMap[os.arch()] || os.arch();

const isMusl = (() => {
  if (platform !== "linux") return false;
  try { if (fs.existsSync("/etc/alpine-release")) return true; } catch {}
  try {
    const r = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" });
    if (((r.stdout || "") + (r.stderr || "")).toLowerCase().includes("musl")) return true;
  } catch {}
  return false;
})();

// Candidate package names in preference order. On linux a system might match
// glibc or musl; try musl first if detected, glibc first otherwise.
const candidates = (() => {
  const base = "executor-" + platform + "-" + arch;
  if (platform === "linux") {
    return isMusl ? [base + "-musl", base] : [base, base + "-musl"];
  }
  return [base];
})();

function detectPackageManager() {
  const ua = process.env.npm_config_user_agent || "";
  if (/\\bbun\\//.test(ua)) return "bun";
  const execPath = process.env.npm_execpath || "";
  if (execPath.includes("bun")) return "bun";
  if (__dirname.includes(".bun/install/global") || __dirname.includes(".bun\\\\install\\\\global")) {
    return "bun";
  }
  return ua ? "npm" : null;
}

for (const name of candidates) {
  try {
    const pkgJson = require.resolve(name + "/package.json");
    const candidate = path.join(path.dirname(pkgJson), "bin", binary);
    if (fs.existsSync(candidate)) {
      spawnAndExit(candidate);
      return;
    }
  } catch {
    // package not installed for this platform; try next candidate
  }
}

// Preview wrapper compat: pkg.pr.new previews download the platform binary
// to bin/runtime/ rather than via optionalDependencies.
const scriptDir = path.dirname(fs.realpathSync(__filename));
const previewBinary = path.join(scriptDir, "runtime", binary);
if (fs.existsSync(previewBinary)) {
  spawnAndExit(previewBinary);
  return;
}

const pm = detectPackageManager();
const reinstall = pm === "bun"
  ? "bun install -g executor"
  : pm === "npm"
    ? "npm install -g executor"
    : "reinstall executor";
console.error(
  "executor: could not locate a platform binary for " + os.platform() + "-" + os.arch() + ".\\n" +
    "Tried optionalDependencies: " + candidates.map((n) => '"' + n + '"').join(", ") + "\\n" +
    "To fix: " + reinstall
);
process.exit(1);
`;

// ---------------------------------------------------------------------------
// Preview postinstall — download per-PR tarballs from our R2 CDN instead of
// GitHub Releases. The __CDN_BASE_URL__ placeholder is replaced at build time
// with `${cdnBase}/${sha}` so each preview fetches its own commit's binary.
// ---------------------------------------------------------------------------

const PREVIEW_POSTINSTALL_SCRIPT = `#!/usr/bin/env node
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CDN_BASE = "__CDN_BASE_URL__";
const packageDir = path.dirname(fs.realpathSync(__filename));
const binDir = path.join(packageDir, "bin");
const runtimeDir = path.join(binDir, "runtime");

const platformMap = { darwin: "darwin", linux: "linux", win32: "windows" };
const platform = platformMap[os.platform()] || os.platform();
const arch = os.arch() === "arm64" ? "arm64" : "x64";
const binary = platform === "windows" ? "executor.exe" : "executor";
const cachedBinary = path.join(runtimeDir, binary);

const isMusl = (() => {
  if (platform !== "linux") return false;
  try { if (fs.existsSync("/etc/alpine-release")) return true; } catch {}
  try {
    const r = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" });
    if (((r.stdout || "") + (r.stderr || "")).toLowerCase().includes("musl")) return true;
  } catch {}
  return false;
})();

const assetBase = (() => {
  const base = "executor-" + platform + "-" + arch;
  return platform === "linux" && isMusl ? base + "-musl" : base;
})();
const archiveName = assetBase + ".tar.gz";
const downloadUrl = CDN_BASE + "/" + archiveName;
const archivePath = path.join(packageDir, archiveName);

const run = (command, args) => {
  const result = childProcess.spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(command + " exited with code " + result.status);
  }
};

const download = async () => {
  const response = await fetch(downloadUrl, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(
      "Failed to download " + downloadUrl + " (status " + response.status + "). " +
      "This preview build may not cover your platform (" + assetBase + ")."
    );
  }
  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(archivePath, Buffer.from(arrayBuffer));
};

(async () => {
  try {
    await download();

    fs.mkdirSync(binDir, { recursive: true });
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    fs.mkdirSync(runtimeDir, { recursive: true });
    run("tar", ["-xzf", archivePath, "-C", runtimeDir]);

    if (!fs.existsSync(cachedBinary)) {
      throw new Error("Expected extracted binary at " + cachedBinary);
    }
    if (platform !== "windows") fs.chmodSync(cachedBinary, 0o755);
    fs.rmSync(archivePath, { force: true });
    console.log("executor: installed preview " + assetBase + " from " + CDN_BASE);
  } catch (error) {
    console.error("executor preview postinstall failed:", error && error.message ? error.message : error);
    process.exit(1);
  }
})();
`;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    single: { type: "boolean", default: false },
    mode: { type: "string", default: "production" },
  },
  allowPositionals: true,
  strict: true,
});

const command = positionals[0];
const mode = values.mode as BuildMode;
if (mode !== "production" && mode !== "development") {
  throw new Error(`Invalid --mode: ${mode}. Must be "production" or "development".`);
}

if (command === "binary") {
  const targets = values.single ? ALL_TARGETS.filter(isCurrentPlatform) : ALL_TARGETS;
  const binaries = await buildBinaries(targets, mode);
  await buildWrapperPackage(binaries);
} else if (command === "preview") {
  // End-to-end preview build for local testing: binary for the current
  // platform + tarball + wrapper, all in one step.
  const targets = ALL_TARGETS.filter(isCurrentPlatform);
  const binaries = await buildBinaries(targets, mode);
  await buildPreviewTarballs(binaries);
  await buildPreviewWrapperPackage(targets);
} else if (command === "preview-tarball") {
  // CI matrix job: build the current runner's binary + tarball only.
  // The wrapper is built separately once all matrix entries have uploaded.
  const targets = ALL_TARGETS.filter(isCurrentPlatform);
  const binaries = await buildBinaries(targets, mode);
  await buildPreviewTarballs(binaries);
} else if (command === "preview-wrapper") {
  // CI publish job: build just the npm wrapper, with os/cpu restricted to
  // the platforms listed in EXECUTOR_PREVIEW_TARGETS (comma-separated).
  const targets = resolveTargetsFromEnv(process.env.EXECUTOR_PREVIEW_TARGETS);
  await buildPreviewWrapperPackage(targets);
} else if (command === "release-assets") {
  await createReleaseAssets();
} else if (command === "publish") {
  const channel = positionals[1] ?? "latest";
  await publish(channel);
} else {
  console.log(`Usage:
  bun run build.ts binary [--single] [--mode production|development]
  bun run build.ts preview [--mode production|development]
  bun run build.ts preview-tarball [--mode production|development]
  bun run build.ts preview-wrapper
  bun run build.ts release-assets
  bun run build.ts publish [channel]`);
  process.exit(1);
}
