// ---------------------------------------------------------------------------
// The packed `@cloudflare/worker-bundler` artifact that ships NEXT TO the
// compiled binary.
//
// `bun build --compile` cannot embed a package that is only ever addressed by
// bare specifier at runtime: bunfs has no `node_modules`, so an
// `import("@cloudflare/worker-bundler")` evaluated inside the binary resolves
// against the virtual root and throws
//   ResolveMessage: Cannot find module '@cloudflare/worker-bundler'
// The build therefore copies the package's `dist/` next to the executable and
// `native-bindings.ts` publishes its absolute path as
// EXECUTOR_WORKER_BUNDLER_DIR. Consumers must load from that directory; a bare
// specifier is unresolvable in the packaged daemon by construction.
//
// This module is the single source of truth for which files that contract
// needs, so the build-time staging check and the runtime lookup cannot drift.
// They previously did: the build wrote `dist/index.bundled.js` (the file
// consumers actually load) while the runtime check only looked for
// `dist/index.js` and `dist/esbuild.wasm`. That drift fails OPEN — an
// incomplete staged copy passes the build, the runtime silently declines to
// publish the env var, and the consumer falls through to the bare specifier.
// ---------------------------------------------------------------------------

import { join } from "node:path";

/** Directory name staged beside the executable, and looked up from execDir. */
export const WORKER_BUNDLER_DIRNAME = "worker-bundler";

/**
 * Files the colocated copy must contain to be usable.
 *
 * `index.bundled.js` is the entrypoint consumers load (the build packs it with
 * esbuild so it has no bare-specifier imports of its own); `esbuild.wasm` is
 * read at runtime beside it; `index.js` is the package's own entry, kept so the
 * staged directory stays a faithful copy rather than a lookalike.
 */
export const WORKER_BUNDLER_RUNTIME_FILES = [
  "dist/index.js",
  "dist/index.bundled.js",
  "dist/esbuild.wasm",
] as const;

/**
 * Which required files are absent from a staged worker-bundler directory.
 *
 * Takes the existence probe as a parameter so the build script, the runtime
 * bootstrap, and tests all agree on the requirement without touching a real
 * filesystem. Returns the POSIX-relative names, which is what error messages
 * should quote.
 */
export const missingWorkerBundlerFiles = (
  dir: string,
  exists: (path: string) => boolean,
): readonly string[] =>
  WORKER_BUNDLER_RUNTIME_FILES.filter((relative) => !exists(join(dir, ...relative.split("/"))));
