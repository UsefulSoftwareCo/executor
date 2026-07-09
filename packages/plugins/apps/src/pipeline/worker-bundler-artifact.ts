/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: Node-side build helper reports missing worker-bundler artifacts */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved through the module graph rather than a path relative to this file:
// this module runs both from src/ (bun) and bundled into dist/ chunks (node
// loading the built vite plugin), where directory-counting breaks. The package
// only declares an `import` export condition, so resolve with
// import.meta.resolve (ESM conditions) and take the entry's parent dir.
const workerBundlerDistDir = (): string => {
  const override = process.env.EXECUTOR_WORKER_BUNDLER_DIR;
  if (override) return join(override, "dist");
  return dirname(fileURLToPath(import.meta.resolve("@cloudflare/worker-bundler")));
};

export const bundledWorkerBundler = async (): Promise<{
  readonly source: string;
  readonly wasm: Uint8Array;
}> => {
  const distDir = workerBundlerDistDir();
  const bundledEntry = join(distDir, "index.bundled.js");
  const [sourceFromDisk, wasm] = await Promise.all([
    existsSync(bundledEntry) ? readFile(bundledEntry, "utf8") : Promise.resolve(null),
    readFile(join(distDir, "esbuild.wasm")),
  ]);
  if (sourceFromDisk !== null) return { source: sourceFromDisk, wasm };

  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: [join(distDir, "index.js")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    external: ["./esbuild.wasm"],
    logLevel: "silent",
  });
  const source = result.outputFiles[0]?.text;
  if (source === undefined) throw new Error("failed to bundle @cloudflare/worker-bundler");
  return { source, wasm };
};
