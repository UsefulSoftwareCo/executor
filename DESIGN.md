# Executor apps — self-hosted build (DESIGN.md)

Status: in progress. Durable record of the architecture, seam signatures,
package layout, key decisions, verification commands, and known gaps for the
executor apps subsystem built into the self-hosted deployment.

Note: the tracked design-system doc is `design.md` (lowercase). This uppercase
`DESIGN.md` is the apps-subsystem architecture record required by the build
brief.

## What this is

User-authored, git-backed, published units — **custom tools**, **durable
workflows**, **UI views**, **skills** — published into a per-scope store and
served/executed by the self-hosted platform. Identity is the file path
(`tools/issues-sync.ts` IS the tool `issues-sync`). Publish is the compiler
(FDI): catalog entries, schedules, ui resources and the skills index are
projections of a versioned descriptor extracted from source at publish.

The subsystem lives in one package, `@executor-js/plugin-apps`, wired into the
self-host app the same way every other plugin is (a source plugin in
`executor.config.ts`, HTTP routes as an extension, MCP tools/resources through
the MCP build hook). Everything substrate-specific sits behind a **seam** with
a substrate-neutral interface and a conformance suite that runs against the
interface, so future Cloudflare backings drop in without touching the
subsystem's logic.

## The five seams

Each seam is a substrate-neutral interface. Self-hosted backings are built now;
cloud backings are future. Everything crossing `ToolSandbox` is serializable
(the cloud version is RPC).

| Seam | Self-hosted backing (built) | Cloud backing (future) |
|---|---|---|
| `ArtifactStore` | bare git repo per scope on disk (git CLI subprocess); `SnapshotId` = commit hash | Cloudflare Artifacts |
| `ScopeDb` | one libSQL/SQLite file per scope + per-table version counters | DO facets |
| `ToolSandbox` | QuickJS kernel (collect + invoke via the `SandboxToolInvoker` bridge) | Worker Loaders |
| `WorkflowRunner` | SQLite event-sourced journal replay runner + in-process scheduler | CF Workflows + dynamic-workflows |
| `LiveChannel` | in-process emitter + SSE | DO/facet socket owner |

See `src/seams/*.ts` for the exact interfaces and `src/seams/*.conformance.ts`
for the suite each backing must pass.

## Decisions (and why)

- **Sandbox = QuickJS** (`packages/kernel/runtime-quickjs`). Its
  `CodeExecutor.execute(code, toolInvoker)` already gives the serializable
  handle bridge: `SandboxToolInvoker.invoke({path, args})` crosses as JSON,
  `tools.<...>()` is a Proxy in the sandbox, `fetch` is disabled, there is a
  deadline interrupt and a memory cap. secure-exec evaluated and rejected
  (pre-1.0, per-arch native sidecar, flat string bridge fighting the Proxy
  pattern); the Deno subprocess kernel is the documented harder-isolation
  escalation behind the same seam. Because QuickJS evaluates a *string*, the
  collect/invoke wrappers own the module shape: the published bundle is a
  self-executing script that either records `define*()` descriptors (collect)
  or calls one handler with injected clients (invoke).
- **Storage via host facades, not new tables.** Executor plugins deliberately
  do not contribute FumaDB tables (`collectTables()` is fixed and
  plugin-independent). App metadata (descriptors, snapshot pointers, schedules,
  workflow journal, ui metadata) lives in `pluginStorage` collections; large
  opaque blobs (compiled bundles, snapshot manifests) live in the `blobs`
  facade, content-addressed by SHA-256.
- **ScopeDb is separate from the executor DB.** App *data* (the `issues` table
  authors read/write) is one libSQL file per scope, independent of the
  executor's own DB. Per-table version counters live alongside it and drive
  `LiveChannel`.
- **Apps are a plugin source.** A published app maps to one executor
  *integration* per scope (`apps`); a *connection* to it makes the published
  tools catalog citizens through `resolveTools`/`invokeTool`, so
  policy/approval/audit/toolkits/tools.list all apply unchanged.
- **No @effect/workflow.** The local runner is a purpose-built SQLite
  event-sourced journal modeled on vercel/workflow's `World` Storage contract
  (append-only events, materialized run/step views, replay-on-resume).

## Package layout

```
packages/plugins/apps/
  src/
    seams/        ArtifactStore, ScopeDb, ToolSandbox, WorkflowRunner, LiveChannel
                  + one <seam>.conformance.ts per seam
    pipeline/     discover -> bundle -> collect -> project (publish = the compiler)
    plugin/       the apps source plugin (resolveTools/invokeTool), descriptor store
    workflow/     journal runner + scheduler (over WorkflowRunner seam)
    http/         publish + invoke + ui-bundle + SSE routes (HttpApiGroup + handlers)
    mcp/          publish tool, ui:// resources, skills list/read over MCP
    ui/           widget shell (browser render, tools/query bridge, SSE refetch)
    testing/      test harness helpers + the daily-brief fixture set + e2e
```

## Verification gates — exact commands

Run from the workspace root
(`usefulsoftwareco/.rifts/executor/apps-build-b`):

- Typecheck (repo root): `bun run typecheck`
- Package tests (conformance + integration + e2e):
  `bun run --filter='@executor-js/plugin-apps' test`

Outputs pasted in the final report.

## Known gaps

Tracked here as the build proceeds; honest list in the final report.
