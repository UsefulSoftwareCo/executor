import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "vite";

import { bundledWorkerBundler } from "./pipeline/worker-bundler-artifact";

const virtualId = "virtual:executor/worker-bundler-artifact";
const resolvedVirtualId = `\0${virtualId}`;
const clientAssetsDir = "dist/client/assets";

const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

const artifactPaths = (artifact: {
  readonly source: string;
  readonly wasm: Uint8Array;
}): {
  readonly sourcePath: string;
  readonly wasmPath: string;
} => ({
  sourcePath: `/assets/worker-bundler-source-${digest(artifact.source)}.js`,
  wasmPath: `/assets/worker-bundler-esbuild-wasm-${digest(artifact.wasm)}.wasm`,
});

export const workerBundlerArtifact = (): Plugin => {
  let command: "build" | "serve" = "build";

  return {
    name: "executor-worker-bundler-artifact",
    configResolved(config) {
      command = config.command;
    },
    resolveId(id) {
      return id === virtualId ? resolvedVirtualId : null;
    },
    async load(id) {
      if (id !== resolvedVirtualId) return null;
      const artifact = await bundledWorkerBundler();
      const paths = artifactPaths(artifact);
      const output = [
        `export const sourcePath = ${JSON.stringify(paths.sourcePath)};`,
        `export const wasmPath = ${JSON.stringify(paths.wasmPath)};`,
      ];

      if (command === "serve") {
        output.push(
          `export const source = ${JSON.stringify(artifact.source)};`,
          `export const wasmBase64 = ${JSON.stringify(Buffer.from(artifact.wasm).toString("base64"))};`,
          "export default { sourcePath, wasmPath, source, wasmBase64 };",
        );
      } else {
        output.push(
          "export const source = undefined;",
          "export const wasmBase64 = undefined;",
          "export default { sourcePath, wasmPath, source, wasmBase64 };",
        );
      }

      return output.join("\n");
    },
    async closeBundle() {
      if (command !== "build") return;
      const artifact = await bundledWorkerBundler();
      const paths = artifactPaths(artifact);
      const outputDir = join(process.cwd(), clientAssetsDir);
      await mkdir(outputDir, { recursive: true });
      await Promise.all([
        writeFile(join(process.cwd(), "dist/client", paths.sourcePath), artifact.source),
        writeFile(join(process.cwd(), "dist/client", paths.wasmPath), artifact.wasm),
      ]);
    },
  };
};
