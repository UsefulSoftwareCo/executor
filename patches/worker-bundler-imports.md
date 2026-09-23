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

Live Cloud checks cover direct npm imports, importing the original manifest,
unused declarations, a public MCP import and tool call, a WASM round trip, and a
React browser build. Timing comparisons are in `notes/install-latency.md`.
