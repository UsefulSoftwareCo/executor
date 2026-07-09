import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const appRoot = new URL("..", import.meta.url);
const serverAssetsDir = new URL("dist/server/assets/", appRoot);
const clientAssetsDir = new URL("dist/client/assets/", appRoot);
const largeFileLimit = 3 * 1024 * 1024;
const sourceAssetMinimum = 512 * 1024;

const fail = (message) => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: build assertion script reports a failed artifact contract
  throw new Error(message);
};

const fileSize = (dir, name) => statSync(join(dir.pathname, name)).size;

const serverAssets = readdirSync(serverAssetsDir);
for (const name of serverAssets) {
  const path = join(serverAssetsDir.pathname, name);
  const size = statSync(path).size;
  if (size <= largeFileLimit) continue;
  if (name.includes("worker-bundler")) {
    fail(`server assets include oversized worker-bundler chunk ${name}`);
  }
  const sample = readFileSync(path, "utf8");
  if (sample.includes("worker-bundler")) {
    fail(`server assets include worker-bundler content in oversized chunk ${name}`);
  }
}

const clientAssets = readdirSync(clientAssetsDir);
const source = clientAssets.find((name) => /^worker-bundler-source-[a-f0-9]{12}\.js$/.test(name));
const wasm = clientAssets.find((name) =>
  /^worker-bundler-esbuild-wasm-[a-f0-9]{12}\.wasm$/.test(name),
);

if (source === undefined) fail("missing worker-bundler source asset");
if (wasm === undefined) fail("missing worker-bundler esbuild wasm asset");

const sourceSize = fileSize(clientAssetsDir, source);
const wasmSize = fileSize(clientAssetsDir, wasm);
if (sourceSize <= sourceAssetMinimum) {
  fail(`worker-bundler source asset is unexpectedly small: ${source}`);
}
if (wasmSize <= largeFileLimit) fail(`worker-bundler wasm asset is unexpectedly small: ${wasm}`);

const wasmMagic = readFileSync(join(clientAssetsDir.pathname, wasm)).subarray(0, 4);
if (!wasmMagic.equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) {
  fail(`worker-bundler wasm asset does not start with wasm magic bytes: ${wasm}`);
}

console.log(
  `[assert-worker-bundler-assets] ${source} (${sourceSize} bytes), ${wasm} (${wasmSize} bytes)`,
);
