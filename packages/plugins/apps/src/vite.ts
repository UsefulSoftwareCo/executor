import type { Plugin } from "vite";

import { bundledWorkerBundler } from "./pipeline/worker-bundler-artifact";

const virtualId = "virtual:executor/worker-bundler-artifact";
const resolvedVirtualId = `\0${virtualId}`;

export const workerBundlerArtifact = (): Plugin => ({
  name: "executor-worker-bundler-artifact",
  resolveId(id) {
    return id === virtualId ? resolvedVirtualId : null;
  },
  async load(id) {
    if (id !== resolvedVirtualId) return null;
    const artifact = await bundledWorkerBundler();
    return [
      `export const source = ${JSON.stringify(artifact.source)};`,
      `export const wasmBase64 = ${JSON.stringify(Buffer.from(artifact.wasm).toString("base64"))};`,
      "export default { source, wasmBase64 };",
    ].join("\n");
  },
});
