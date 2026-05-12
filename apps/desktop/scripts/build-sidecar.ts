/**
 * Build the production sidecar binary using `bun build --compile`.
 *
 * Produces a fully self-contained executable that includes the Bun runtime
 * plus the entire @executor-js/local server graph (including bun:sqlite,
 * drizzle, MCP, etc.). The Electron main process exec's this binary at
 * runtime instead of relying on a `bun` install on the user's machine.
 *
 * Also stages the apps/local Vite build output as `resources/web-ui/` so
 * electron-builder picks it up via extraResources.
 *
 * Like apps/cli/src/build.ts, this script generates
 * apps/local/src/server/embedded-migrations.gen.ts with drizzle migration
 * files inlined via `with { type: "text" }` before compiling, then restores
 * the stub afterwards. The compiled binary unpacks migrations to a tmpdir
 * at boot so drizzle's `migrate()` (which only accepts folder paths) works.
 */
import { mkdir, rm, cp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(ROOT, "../..");
const APPS_LOCAL = resolve(REPO_ROOT, "apps/local");
const SIDECAR_ENTRY = resolve(ROOT, "src/sidecar/server.ts");
const SIDECAR_OUT_DIR = resolve(ROOT, "resources/sidecar");
const WEB_UI_OUT_DIR = resolve(ROOT, "resources/web-ui");
const APPS_LOCAL_DIST = resolve(APPS_LOCAL, "dist");

const EMBEDDED_MIGRATIONS_PATH = join(APPS_LOCAL, "src/server/embedded-migrations.gen.ts");
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

const createEmbeddedMigrationsSource = async (): Promise<string> => {
  const migrationsDir = resolve(APPS_LOCAL, "drizzle");
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

console.log("[build-sidecar] inlining drizzle migrations...");
const embeddedMigrations = await createEmbeddedMigrationsSource();
await writeFile(EMBEDDED_MIGRATIONS_PATH, `${embeddedMigrations}\n`);

// oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: ensure the gen stub is restored even if compile fails
try {
  console.log(
    `[build-sidecar] bun build --compile --target=${BUN_TARGET} ${SIDECAR_ENTRY} → ${sidecarBinary}`,
  );
  await $`bun build --compile --minify --sourcemap --target=${BUN_TARGET} --outfile ${sidecarBinary} ${SIDECAR_ENTRY}`.cwd(
    REPO_ROOT,
  );
} finally {
  await writeFile(EMBEDDED_MIGRATIONS_PATH, EMBEDDED_MIGRATIONS_STUB);
}

console.log(`[build-sidecar] staging web UI → ${WEB_UI_OUT_DIR}`);
await cp(APPS_LOCAL_DIST, WEB_UI_OUT_DIR, { recursive: true });

console.log("[build-sidecar] done");
