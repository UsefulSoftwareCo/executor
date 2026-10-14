# Patched Bun runtime

The standalone CLI is a `bun build --compile` executable, which we sign. Stock
Bun reads several environment variables before the app's first line runs, and
some of them make the signed executable run code it does not contain. Any local
process that can start the CLI could use them to run its own code inside our
signed binary. We therefore compile the CLI with a Bun runtime that we patch
and build ourselves.

`lockdown.patch` applies to Bun `bun-v1.4.2` (commit `744846f8`) with
`git apply`. At startup, `main` checks once whether the executable embeds a
standalone module graph and stores the answer in a process-wide flag. Rust reads
it through `bun_core::is_standalone_executable()` and C++ through
`Bun__isStandaloneExecutable()`. When the flag is set, Bun ignores the
following:

| Vector                                                                                                   | Effect in stock Bun                                                                                                              | Where the patch closes it                                                             |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `BUN_BE_BUN`                                                                                             | The executable becomes the full `bun` CLI (`-e`, `run`, `x`, ...)                                                                | `src/runtime/cli/mod.rs`, graph dispatch                                              |
| `BUN_INTERNAL_WEBVIEW_HOST`                                                                              | Before the graph is checked, the process becomes a WebView host that talks to an inherited fd (macOS)                            | `src/runtime/cli/mod.rs`                                                              |
| `BUN_OPTIONS`                                                                                            | Spliced into argv: `--preload`, `--require`, `--import`, `--config`, `--cwd`, `--env-file`, `--inspect`, ...                     | `src/bun_core/util.rs`, `argv_view_init`                                              |
| `BUN_INSPECT`, `BUN_INSPECT_CONNECT_TO`                                                                  | Starts the inspector, either listening or connecting out, which gives full JS control                                            | `src/runtime/jsc_hooks.rs`, `configure_debugger`                                      |
| `BUN_INSPECT_PRELOAD`                                                                                    | Preloads a module                                                                                                                | `src/runtime/cli/Arguments.rs`                                                        |
| `BUN_JSC_*`                                                                                              | Sets any JavaScriptCore option, including JIT, memory-safety and internal-API switches                                           | `src/jsc/bindings/ZigGlobalObject.cpp`, `JSCInitialize`                               |
| `NODE_PATH`                                                                                              | Adds module search roots, which can satisfy optional `require()`s in packages loaded from disk (for example `ws` → `bufferutil`) | `src/resolver/resolver.rs`                                                            |
| Runtime transpiler cache (`BUN_RUNTIME_TRANSPILER_CACHE_PATH`, `XDG_CACHE_HOME`, `~/Library/Caches/bun`) | Transpiled output for files loaded from disk is read from a user-writable cache                                                  | `src/jsc/RuntimeTranspilerCache.rs`, `src/bundler/cache.rs`: always off when compiled |

Plain `bun`, without an embedded graph, behaves exactly as upstream.

Code already covers these, so the patch leaves them alone:

- `JSC_*`: Bun calls `JSC::Config::disableEnvironmentOptions()`.
- `NODE_COMPILE_CACHE`: disabled in standalone executables, unless the app itself calls `module.enableCompileCache()`.
- `.env` and `bunfig.toml` autoloading: we compile with `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`.
- Debugger: Bun has no SIGUSR1 handler that starts it.

Compiled executables ignore `BUN_INTERNAL_WEBVIEW_HOST`, so `Bun.WebView` cannot
use its WebKit host process from a compiled executable. The CLI does not use
`Bun.WebView`.

## Building

`.github/workflows/bun-runtime.yml` runs on `workflow_dispatch` and when this
directory changes on `main`. It checks out `oven-sh/bun` at the pinned tag,
verifies the commit and applies the patch. It then builds
`--profile=release --ci=on --lto=on --canary=off` for each target, using the
same build model as Bun's release CI:

- `linux-x64` and `linux-arm64` build on runners of their own architecture
  against Bun's ubuntu:20.04 glibc sysroot (`setup-linux.sh`). Like the
  official binaries, they need GLIBC_2.17 at most; the job checks this.
- `darwin-arm64`, `darwin-x64` and `windows-x64` are cross-compiled from Linux
  arm64, as upstream does. Bun's build cannot target x64 from a macOS host. All
  x64 targets are built for `-march=nehalem` (`--baseline=on`, no AVX), so
  `darwin-x64` runs under Rosetta.
- `smoke.sh` runs each binary on its own OS. It compiles a probe app and checks
  that the app ignores the vectors above while plain `bun` still honours them.
  `darwin-x64` runs under Rosetta on Apple silicon.

The binaries and a `SHA256SUMS` file are published to the release
`bun-runtime-1.4.2-<first 12 hex of sha256(lockdown.patch + build.patch)>`. An existing
release is never overwritten.

To build locally on macOS (arm64), use LLVM 21, rustup and Bun 1.4.2:

```sh
git clone --depth 1 --branch bun-v1.4.2 https://github.com/oven-sh/bun.git bun-src
cd bun-src && git apply ../scripts/releases/bun-runtime/lockdown.patch ../scripts/releases/bun-runtime/build.patch
export PATH="$(brew --prefix llvm@21)/bin:$PATH"
# clang 21 rejects headers in newer SDKs (Xcode betas); the 26.5 CLT SDK works.
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
bun scripts/build.ts --profile=release --canary=off   # -> build/release/bun
bash ../scripts/releases/bun-runtime/smoke.sh build/release/bun
```

## Updating Bun

1. Change `BUN_VERSION`, `BUN_TAG` and `BUN_COMMIT` in the workflow.
2. Check out the new tag and run `git apply --3way lockdown.patch`. Resolve any
   conflicts.
3. Audit the new version again. Search for new environment variables
   (`src/bun_core/env_var.rs`, `getenv`, `env.get(b"...")`, `process.env` in
   `src/js`) that load code, attach a debugger, change argv, or choose a
   different entry point before the graph runs. Check every new one against
   `is_standalone_executable()`.
4. Regenerate the patch with `git diff > lockdown.patch`, build, and run
   `smoke.sh`.
5. Merge to `main`. The new patch hash produces a new release name.

`build.patch` changes only Bun's build scripts. Release CI builds with `--ci=on`, which sets the
macOS deployment target, fetches the Windows sysroot and strips checkout paths, but upstream
also skips the precompiled header in that mode, which its own pipeline never uses, and the C++
sources then miss declarations the header provides. The patch keeps the precompiled header on.
