/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: worker-pool test config prepares a Vite artifact before tests start */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const packageDir = dirname(fileURLToPath(import.meta.url));
const workerBundlerDist = join(packageDir, "node_modules", "@cloudflare", "worker-bundler", "dist");

const createWorkerBundlerArtifact = async (): Promise<{
  readonly source: string;
  readonly wasmBase64: string;
}> => {
  if (
    !existsSync(join(workerBundlerDist, "index.js")) ||
    !existsSync(join(workerBundlerDist, "esbuild.wasm"))
  ) {
    throw new Error(`@cloudflare/worker-bundler dist files not found at ${workerBundlerDist}`);
  }
  const { build } = await import("esbuild");
  const [result, wasm] = await Promise.all([
    build({
      entryPoints: [join(workerBundlerDist, "index.js")],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
      external: ["./esbuild.wasm"],
      logLevel: "silent",
    }),
    readFile(join(workerBundlerDist, "esbuild.wasm")),
  ]);
  const source = result.outputFiles[0]?.text;
  if (source === undefined) throw new Error("failed to bundle @cloudflare/worker-bundler");
  return { source, wasmBase64: wasm.toString("base64") };
};

const artifact = await createWorkerBundlerArtifact();

export default defineConfig({
  define: {
    __WORKER_BUNDLER_SOURCE__: JSON.stringify(artifact.source),
    __WORKER_BUNDLER_WASM_BASE64__: JSON.stringify(artifact.wasmBase64),
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.worker.jsonc" },
    }),
  ],
  test: {
    include: ["src/**/*.worker.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
