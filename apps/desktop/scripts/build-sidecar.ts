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

// Drizzle's migrator takes a folder path at runtime. The compiled sidecar
// cannot rely on apps/local/drizzle existing on disk, so inline every migration
// as text and let apps/local extract them to a temp folder during startup.
const createEmbeddedMigrationsSource = async () => {
  const migrationsDir = resolve(APPS_LOCAL, "drizzle");
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

  console.log(`[build-sidecar] staging web UI → ${WEB_UI_OUT_DIR}`);
  await cp(APPS_LOCAL_DIST, WEB_UI_OUT_DIR, { recursive: true });
} finally {
  await writeFile(EMBEDDED_MIGRATIONS_PATH, EMBEDDED_MIGRATIONS_STUB);
}

console.log("[build-sidecar] done");
