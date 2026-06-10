/**
 * Build the production sidecar binary using `bun build --compile`.
 *
 * Produces a fully self-contained executable that includes the Bun runtime
 * plus the entire @executor-js/local server graph (including bun:sqlite,
 * FumaDB, MCP, etc.). The Electron main process exec's this binary at
 * runtime instead of relying on a `bun` install on the user's machine.
 *
 * Also stages the apps/local Vite build output as `resources/web-ui/` so
 * electron-builder picks it up via extraResources.
 *
 */
import { mkdir, rm, cp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { $ } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(ROOT, "../..");
const APPS_LOCAL = resolve(REPO_ROOT, "apps/local");
const SIDECAR_ENTRY = resolve(ROOT, "src/sidecar/server.ts");
const SIDECAR_OUT_DIR = resolve(ROOT, "resources/sidecar");
const WEB_UI_OUT_DIR = resolve(ROOT, "resources/web-ui");
const APPS_LOCAL_DIST = resolve(APPS_LOCAL, "dist");
const EMBEDDED_MIGRATIONS_PATH = resolve(APPS_LOCAL, "src/db/embedded-migrations.gen.ts");
const EMBEDDED_MIGRATIONS_STUB = `const migrations: Record<string, string> | null = null;\n\nexport default migrations;\n`;

/**
 * Cross-compile target for `bun build --compile`. When unset we use Bun's
 * default `bun` target (the runner's own platform). CI passes a specific
 * value like `bun-darwin-x64` to produce binaries for other platforms from
 * a single matrix entry.
 */
const BUN_TARGET = process.env.BUN_TARGET ?? "bun";
const targetIsWindows = BUN_TARGET.includes("windows") || process.platform === "win32";
const binaryName = targetIsWindows ? "executor-sidecar.exe" : "executor-sidecar";
const sidecarBinary = resolve(SIDECAR_OUT_DIR, binaryName);

/**
 * Normalized `<os>-<arch>[-<abi>]` key for the compile target, derived from
 * BUN_TARGET (`bun` = the runner's own platform). Matches the keys used by
 * apps/cli/src/build.ts's native-binding maps.
 */
const targetKey =
  BUN_TARGET === "bun"
    ? `${process.platform}-${process.arch}`
    : BUN_TARGET.replace(/^bun-/, "").replace(/^windows-/, "win32-");

const targetIsCurrentPlatform = targetKey === `${process.platform}-${process.arch}`;

// `bun build --compile` does not bundle `.node` native addons into bunfs, so
// the sidecar's eager `require('@libsql/<plat>')` (and the keychain plugin's
// lazy keyring load) would fail at runtime. We stage each binding next to the
// binary; src/sidecar/native-bindings.ts (the sidecar's first import) points
// the loaders at them via EXECUTOR_LIBSQL_NATIVE_PATH /
// EXECUTOR_KEYRING_NATIVE_PATH. Mirrors apps/cli/src/build.ts.
const LIBSQL_NATIVE_VERSION = "0.5.29";
const resolveLibsqlNative = (): string => {
  const platformMap: Record<string, string> = {
    "darwin-arm64": "darwin-arm64",
    "darwin-x64": "darwin-x64",
    // The compiled binary runs on Bun, which libSQL's loader treats as glibc
    // (its musl->gnu workaround), so non-musl linux targets need the -gnu binding.
    "linux-arm64": "linux-arm64-gnu",
    "linux-x64": "linux-x64-gnu",
    "win32-arm64": "win32-arm64-msvc",
    "win32-x64": "win32-x64-msvc",
  };
  const target = platformMap[targetKey];
  if (!target) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: build-time fatal
    throw new Error(`No @libsql native binding mapping for target ${targetKey}`);
  }
  const pkg = `@libsql/${target}`;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: build-time resolution falls back to bun's store layout
  try {
    const req = createRequire(join(APPS_LOCAL, "package.json"));
    return join(dirname(req.resolve(`${pkg}/package.json`)), "index.node");
  } catch {
    const bunPath = join(
      REPO_ROOT,
      `node_modules/.bun/${pkg.replace("/", "+")}@${LIBSQL_NATIVE_VERSION}/node_modules/${pkg}/index.node`,
    );
    if (!existsSync(bunPath)) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: build-time fatal
      throw new Error(
        `Cannot resolve ${pkg} for the sidecar. Run \`bun install --cpu=* --os=*\` so cross-target native bindings are present.`,
      );
    }
    return bunPath;
  }
};

const resolveKeyringNative = (): string => {
  const platformMap: Record<string, { pkg: string; node: string }> = {
    "darwin-arm64": {
      pkg: "@napi-rs/keyring-darwin-arm64",
      node: "keyring.darwin-arm64.node",
    },
    "darwin-x64": {
      pkg: "@napi-rs/keyring-darwin-x64",
      node: "keyring.darwin-x64.node",
    },
    "linux-arm64": {
      pkg: "@napi-rs/keyring-linux-arm64-gnu",
      node: "keyring.linux-arm64-gnu.node",
    },
    "linux-x64": {
      pkg: "@napi-rs/keyring-linux-x64-gnu",
      node: "keyring.linux-x64-gnu.node",
    },
    "win32-arm64": {
      pkg: "@napi-rs/keyring-win32-arm64-msvc",
      node: "keyring.win32-arm64-msvc.node",
    },
    "win32-x64": {
      pkg: "@napi-rs/keyring-win32-x64-msvc",
      node: "keyring.win32-x64-msvc.node",
    },
  };
  const entry = platformMap[targetKey];
  if (!entry) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: build-time fatal
    throw new Error(`No @napi-rs/keyring native binding mapping for target ${targetKey}`);
  }
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: build-time resolution falls back to bun's store layout
  try {
    const req = createRequire(join(REPO_ROOT, "node_modules", "@napi-rs/keyring", "package.json"));
    return join(dirname(req.resolve(`${entry.pkg}/package.json`)), entry.node);
  } catch {
    const bunPath = join(
      REPO_ROOT,
      `node_modules/.bun/${entry.pkg.replace("/", "+")}@1.2.0/node_modules/${entry.pkg}/${entry.node}`,
    );
    if (!existsSync(bunPath)) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: build-time fatal
      throw new Error(
        `Cannot resolve ${entry.pkg} for the sidecar. Run \`bun install --cpu=* --os=*\` so cross-target native bindings are present.`,
      );
    }
    return bunPath;
  }
};

// QuickJS ships its WASM as a side asset; `bun build --compile` can't pull
// it into bunfs, so we stage it next to the binary and the sidecar entry
// preloads it via `setQuickJSModule` before any server import.
const resolveQuickJsWasmPath = (): string => {
  const req = createRequire(join(REPO_ROOT, "packages/kernel/runtime-quickjs/package.json"));
  const quickJsPkg = req.resolve("quickjs-emscripten/package.json");
  const wasmPath = resolve(
    dirname(quickJsPkg),
    "../@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm",
  );
  if (!existsSync(wasmPath)) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: build-time fatal
    throw new Error(`QuickJS WASM not found at ${wasmPath}`);
  }
  return wasmPath;
};

// The v1→v2 data migration replays the legacy v1 drizzle chain
// (apps/local/drizzle-legacy-v1) before reading a legacy database. The
// compiled sidecar cannot rely on that folder existing on disk, so inline
// every migration as text and let apps/local extract them to a temp folder
// during startup. Mirrors apps/cli/src/build.ts — embedding the wrong dir
// (e.g. the v2 chain in drizzle/) makes the sidecar treat every real legacy
// database as "history does not match" and skip the replay.
const createEmbeddedMigrationsSource = async () => {
  const migrationsDir = resolve(APPS_LOCAL, "drizzle-legacy-v1");
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: migrationsDir })))
    .map((file) => file.replaceAll("\\", "/"))
    .sort();

  const imports = files.map((file, index) => {
    const spec = join(migrationsDir, file).replaceAll("\\", "/");
    return `import file_${index} from ${JSON.stringify(spec)} with { type: "text" };`;
  });

  const entries = files.map((file, index) => `  ${JSON.stringify(file)}: file_${index},`);

  return [
    "// Auto-generated - maps migration paths to inlined file contents",
    ...imports,
    "export default {",
    ...entries,
    "} as Record<string, string>;",
  ].join("\n");
};

if (!existsSync(APPS_LOCAL_DIST)) {
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: build-time fatal
  throw new Error(
    `apps/local/dist not found. Run \`bun run --filter @executor-js/local build\` first.`,
  );
}

// Cross-target builds (e.g. the mac x64 leg on an arm64 runner) need the other
// platform's optional native packages on disk before we can stage them.
// `--cpu=* --os=*` extracts them all without modifying the lockfile. Mirrors
// apps/cli/src/build.ts.
if (!targetIsCurrentPlatform) {
  console.log("[build-sidecar] installing optional native deps for all platforms...");
  await $`bun install --frozen-lockfile --cpu=* --os=*`.cwd(REPO_ROOT);
}

// Resolve the native bindings up front so a missing platform package fails the
// build before the (slow) compile, and cross-target builds get a clear message.
const libsqlNativePath = resolveLibsqlNative();
const keyringNativePath = resolveKeyringNative();

await rm(SIDECAR_OUT_DIR, { recursive: true, force: true });
await rm(WEB_UI_OUT_DIR, { recursive: true, force: true });
await mkdir(SIDECAR_OUT_DIR, { recursive: true });
await mkdir(WEB_UI_OUT_DIR, { recursive: true });

console.log(
  `[build-sidecar] bun build --compile --target=${BUN_TARGET} ${SIDECAR_ENTRY} → ${sidecarBinary}`,
);

console.log("[build-sidecar] generating embedded drizzle migrations");
const embeddedMigrations = await createEmbeddedMigrationsSource();
await writeFile(EMBEDDED_MIGRATIONS_PATH, `${embeddedMigrations}\n`);

// oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: build-time script must restore the checked-in migration stub after compile failure
try {
  await $`bun build --compile --minify --sourcemap --target=${BUN_TARGET} --outfile ${sidecarBinary} ${SIDECAR_ENTRY}`.cwd(
    REPO_ROOT,
  );

  console.log(`[build-sidecar] staging QuickJS WASM → ${SIDECAR_OUT_DIR}`);
  await cp(resolveQuickJsWasmPath(), join(SIDECAR_OUT_DIR, "emscripten-module.wasm"));

  console.log(`[build-sidecar] staging native bindings (${targetKey}) → ${SIDECAR_OUT_DIR}`);
  await cp(libsqlNativePath, join(SIDECAR_OUT_DIR, "libsql.node"));
  await cp(keyringNativePath, join(SIDECAR_OUT_DIR, "keyring.node"));

  console.log(`[build-sidecar] staging web UI → ${WEB_UI_OUT_DIR}`);
  await cp(APPS_LOCAL_DIST, WEB_UI_OUT_DIR, { recursive: true });
} finally {
  await writeFile(EMBEDDED_MIGRATIONS_PATH, EMBEDDED_MIGRATIONS_STUB);
}

console.log("[build-sidecar] done");
