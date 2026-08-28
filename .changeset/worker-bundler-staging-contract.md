---
"executor": patch
---

**The packed Worker toolchain is verified at build time, and an incomplete copy is now reported instead of silently ignored**

`@cloudflare/worker-bundler` cannot live inside the compiled binary: bunfs has no `node_modules`, so a bare specifier is unresolvable there by construction. The build instead copies the package's `dist/` next to the executable and `native-bindings.ts` publishes that path as `EXECUTOR_WORKER_BUNDLER_DIR` for consumers to load from.

That handoff was described in two places that were free to drift, and did. The build writes `dist/index.bundled.js` — the entry consumers actually load, packed so it has no bare imports of its own — while the runtime check only looked for `dist/index.js` and `dist/esbuild.wasm`. Nothing verified the staged copy after the compile, so a partial staging produced a binary that looked fine on the build machine and failed on the user's, at startup. Worse, the runtime check failed open: when a file was missing it silently declined to set the environment variable, leaving a consumer to fall through to the bare specifier and crash.

The required file list is now one shared contract used by both sides, so they cannot disagree. The build asserts the staged copy after compiling each target — every required file present, a size floor on the packed entry, and the `\0asm` magic on the wasm so a truncated copy cannot pass — turning a packaging slip into a failed build rather than a broken install. At runtime, a directory that is present but incomplete is reported on stderr naming the missing files, instead of being swallowed. An absent directory stays quiet, since that is the normal non-packaged path.
