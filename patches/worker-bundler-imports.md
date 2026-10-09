# Import-driven Worker dependencies

Executor links `apps/*` from the selected package's Worker snapshot, or the host
snapshot when the app does not declare a framework version.
Generated portable app manifests also declare optional framework peers for the
Node runtime. Installing all those declarations before a Cloud compile fetched
and unpacked packages the compiler never imported.

The pinned worker-bundler patch adds `CreateAppOptions.installDependencies`,
which defaults to the previous eager behavior. Executor sets it to false and
supplies an esbuild resolver that installs declared npm packages when a reachable
import needs them. The existing installer still resolves package versions,
transitive dependencies and binary assets. The existing resolver still handles
package exports and build conditions. Installation is serialized per build;
there is no cross-request dependency or credential cache.

The installer receives a narrow view of the root manifest for the selected
package. The compiler and retained source receive the original manifest, so an
app that imports its own package.json sees its original declarations. Framework
imports use that selected snapshot. Browser dependencies and bare WASM imports go
through the same resolver before the existing browser/WASM plugins.

`installDependencies` also accepts `transitive: false` for a selected `apps`
archive whose Worker runtime is self-contained. It still resolves and downloads
that exact package through the normal registry or HTTP tarball path. Ordinary
imports retain recursive dependency installation. Both options default to the
previous behavior for other consumers. The patch retains binary-WASM support.
Recheck these options and the pinned plugin hook when updating worker-bundler.

## Build memory

The compiler is a Worker isolate with Cloudflare's memory limit, shared by two
admitted builds. The patch reduces what a build holds:

- Tarballs stream through gunzip and the tar reader one entry at a time; neither
  the compressed nor the unpacked archive is held whole.
- Installs keep only files a bundle can read. Source maps, `.d.ts`/`.d.mts`/`.d.cts`,
  Markdown and README/CHANGELOG/LICENSE files are skipped. `fetchPackageFiles`
  keeps everything for its other caller, the TypeScript language service, which
  reads `.d.ts` libraries.
- One install unpacks at most three tarballs at once.
- esbuild's Go heap grows to its largest build and never shrinks. The bundler
  stops the esbuild service whenever no bundle is running and starts a fresh
  instance from the compiled module for the next one.

Outside the patch, UI chunks built only from installed packages ship without
source maps (`worker-browser-build.ts`), and the API retries a compile once after
a memory failure, which a fresh isolate then runs alone (`runtime.ts`).

On a test stage, a borderline build (a React UI with a 4 MB prebuilt bundle) failed
after earlier large builds and alongside a concurrent one; with the fresh esbuild
instance and the retry it passed every run. Builds that need far more memory, such
as `@pierre/diffs` with Shiki's full grammar set or TypeScript with
`lucide-react`, still exceed the limit: most of their memory is esbuild's own
parse of hundreds of modules. Lowering Go's `GOGC` saved little, and storing the
filesystem as bytes would save about 14% of its 31 MB.

Live Cloud checks cover direct npm imports, importing the original manifest,
unused declarations, a public MCP import and tool call, a WASM round trip, and a
React browser build. Timing comparisons are in `notes/install-latency.md`.

The resolver also stops falling back to a package's `main` entry for a subpath
import. Without an `exports` field, `ajv/dist/compile/codegen` otherwise loaded
`ajv/dist/ajv.js`, so `ajv-formats`, and with it direct imports of the MCP
SDK client, failed while the Worker loaded. A subpath now resolves to its own
file or directory index. 0.2.5 still has the fallback.
