// Vendors the QuickJS engine WASM into src/ so wrangler's CompiledWasm module
// rule (rooted at the app dir) can statically compile it at build time. Workers
// forbid runtime WASM compilation, and the rule's glob won't reach the
// monorepo-root node_modules, so the bytes must live inside this app.
//
// Re-run after bumping @jitl/quickjs-wasmfile-release-sync:
//   bun run scripts/vendor-quickjs-wasm.ts
import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const source = require.resolve("@jitl/quickjs-wasmfile-release-sync/wasm");
const dest = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "quickjs-engine.wasm");

copyFileSync(source, dest);
console.log(`vendored ${source} -> ${dest}`);
