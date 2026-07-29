# Artifacts — revive PR #263 as a first-party capability

Decision (Rhys, 2026-07-27): revive the generative UI shell from PR #263
("Add generative UI shell for interactive React components", branch
`claude/generative-ui-mcp-apps-BG4vy`, last pushed 2026-06-30) as a
**persistent artifacts feature** — but re-lifted first-party, not rebased.
The PR was built as `packages/plugins/dynamic-ui`; every plugin touchpoint it
added is on the Phase 2 kill list in [kill-plugin-system.md](kill-plugin-system.md),
so reviving it via rebase would port code onto infrastructure we're deleting.

## v1 scope (Rhys, 2026-07-27)

- **Model-generated only.** The #263 flow: the MCP `execute` tool detects JSX
  in a result and renders it via MCP Apps. No hand-authoring, no
  deploy/graduation story yet (that's the vision.md "authored artifact" tier —
  later, possibly on the Phase 3 concept-package model).
- **Persistent + personal.** Generated artifacts are saved with a name/title,
  owned by the generating user. The sidebar gets an **Artifacts tab** listing
  them (open/re-render, rename, delete).
- **Retrievable through MCP.** "Show me my active users dashboard" must work
  from any MCP client: the agent lists saved artifacts, matches by
  title/description, and a render tool returns the stored JSX with `_meta.ui`
  so the client renders it as an MCP App. Same shell, same delivery path as
  first generation.
- **No sharing at launch.** Org-share comes later, but it is just the existing
  persisted `owner: "org" | "user"` tier + visibility-is-union scope merging —
  so the table carries the owner tier column from day one (rows all
  user-owned at launch), and no new sharing machinery is ever needed.

## What to salvage from #263 (the ~3.5k LoC shell is plugin-free inside)

- Shell runtime: Sucrase JSX compile + sandboxed eval; React, shadcn/ui,
  Recharts, Lucide in scope; runtime Tailwind (`@tailwindcss/browser`);
  error boundary; JSON view for non-JSX results; configurable maxHeight;
  auto-resize; dark mode via `prefers-color-scheme` + host theme;
  reload-restore via `ontoolinput`.
- Tools proxy: tRPC-style recursive proxy (`tools.github.issues.create()` →
  `execute-action`), kernel envelope unwrap, `run()` escape hatch.
- The browser test suite (`mcp-app.browser.test.ts`, ~1.4k lines) and the
  sunpeak MCP Apps e2e harness (`e2e/mcp-apps/`).
- The dedicated `render-ui` tool and its description (the PR _body_ is stale —
  it describes an early `isReactCode`-detection-inside-`execute` design; the
  branch's final shape is a separate tool whose description enforces the
  discovery-vs-render split and JSX guardrails, e.g. no hardcoded live-data
  arrays). Keep the separate-tool shape.

## What to kill from #263 (the plugin costume)

- The `packages/plugins/dynamic-ui` packaging itself.
- `packages/core/vite-plugin` changes (Phase 2.1 deletes that package).
- The plugin route (`apps/cloud/.../plugins.$pluginId.$.tsx` addition).
- The new plugin seam in `packages/hosts/mcp` (`plugin.ts`).
- Per-host feature-flag files and the plugin wiring in `apps/local/main.ts`.

New homes: shell + renderer in a first-party package (or `packages/react`);
MCP host exposes the ui-bearing tools directly; the Artifacts tab is an
ordinary route in `packages/app`. No feature-flag-per-host, no virtual
modules, no plugin registration.

## Data model

Core `artifact` table following the subject-table pattern (Phase 1.1 of the
plugin-kill plan): tenant-scoped `coreTables` entry + cloud drizzle mirror +
one migration. Columns (roughly): id, tenant, owner tier, subject, title,
description (for agent matching), jsx source, created_at, updated_at.
Immutable content-hashed versions (rollback = pointer move, per the Phase 3
model) are a later upgrade — v1 can overwrite in place.

## MCP surface

- **`render-ui` stays a dedicated tool** (the branch's final shape; the stale
  PR body describes JSX detection inside `execute` — do not resurrect that).
  `execute` remains the discovery/data path per the tool description's
  discovery-vs-render protocol. `render-ui` persists the artifact on
  successful render (model supplies title/description via the tool contract).
- **Capability fallback (Rhys, 2026-07-27): `render-ui` is always advertised,
  same description, regardless of client MCP Apps support.** When the client
  doesn't advertise MCP Apps, the tool still persists the artifact but
  returns a **deep link into the product** (the artifact's page in the web
  app) instead of the `_meta.ui` embedded resource. This is vision.md's
  delivery-negotiation rule verbatim: "a UI → an embedded UI resource if the
  client renders it (MCP apps), else a deep link into the web app." The model
  behaves identically either way; only delivery changes. Persistence is what
  makes the fallback possible — the deep link needs a durable row to point at.
- New tools: list artifacts (title + description, for matching), render
  artifact by id — same dual delivery (embedded resource or deep link).
  Delete/rename can stay web-UI-only in v1.
- Deep-link shape: stable `/artifacts/:id`-style URL (auth-aware redirect,
  same pattern as the 1.6 `/connect/:slug` links).

## Sharing portability: connection names in tool paths (explored 2026-07-28)

Codemode addresses are 5 fixed segments —
`tools.<integration>.<org|user>.<connectionName>.<tool>` (`parseToolAddress`,
`packages/core/sdk/src/executor.ts:209`) — and the connection segment is the
raw `connection.name`, resolved by exact equality with **no fallback or
aliasing**. Names are user-derived (label → `connectionIdentifier` camelCase;
default `personal<Integration>` / `workspace<Integration>` — "main" is a test
fixture, not a convention). So a shared artifact from user A:

- **works unmodified for B** only when every path uses an org-tier connection
  (`.org.` pins `subject = ""`, tenant-visible — same rows for both users);
- **breaks per-call** on any `.user.` path: the row lookup pins B's subject,
  so B gets `tool_not_found` (empty suggestions — the suggestion query itself
  filters on the unresolvable connection segment), surfaced as a query error
  state inside the artifact. Even an identically-named user-tier connection of
  B's own doesn't match today.

**The custom-tools (apps) plugin already models the fix** (dependency
injection, `packages/plugins/apps/src/plugin/bindings.ts`): a tool declares
integrations as _roles_ (field → `IntegrationDecl`), never a literal
connection; the connection arrives at invoke time and
`resolveIntegrationBindings` resolves it against the caller's own connections
(with a candidate list in the error when it can't). The artifact analogue:
extract the integration roles an artifact uses (derivable from its tool
paths), store them as declared dependencies, and bind role → viewer's
connection at render time — swap the account or pass it in, exactly the
custom-tools shape. Cheapest hook points if/when built:
`tool-invoker.ts:305` (`pathToAddress` — every sandbox path passes through,
already inside the viewer's scoped executor) or the shell's `toolPathToCode`
(`shell-app.tsx:112`) if the binding should be user-visible/overridable in
the UI. Deliberately NOT in v1 scope (v1 artifacts are viewer-owned, so
paths always resolve); this lands with sharing.

## Trust note

#263 auto-approves elicitations for UI-initiated `execute-action` calls
(the user consented by interacting). Acceptable for v1 because every artifact
is the viewer's own, model-generated in their session. **Must be revisited
before sharing ships** — an org-shared artifact executing tools with the
viewer's connections on click is a different trust story.

## Sequencing

Independent of the plugin-kill phases: built plugin-free from the start, it
touches none of the seams Phase 2 deletes, and avoids re-creating dynamic-ui
as an eighth plugin. The persistence PR follows the same schema conventions
as the in-flight subject-table stack (#1463+) but has no hard dependency
on it.

## Iteration and create-time render checking (shipped)

Two additions after the v1 surface landed, both about the same gap: the model
never found out when an artifact was wrong.

### Updating an artifact in place

`create-artifact` takes an optional `artifactId`. Present, it overwrites that
artifact rather than minting a new one — the workflow a model actually has when
a user asks for a tweak is "`show-artifact`, edit the source, send it back", so
a separate `update-artifact` tool would take the same arguments and differ only
in whether a row is created. One tool keeps the catalog at three.

Semantics: `code` fully replaces the stored source (v1 keeps no version
history); `title` and `description` are optional on an update and absent means
keep the stored value; bindings are re-extracted and re-resolved from the NEW
code plus an optional `connections` map, because the roles the new source uses
are not necessarily the old ones; an id that is not the caller's is refused with
the same `artifact_unavailable` the binding path uses, so create-artifact cannot
be used to probe which ids exist. The artifact keeps its id, so a link already
in the user's hands resolves to the new version. The detail page re-reads its
row when the tab regains focus, which is when a user who asked an agent for a
change looks back at it.

### Catching first-render failures at create time

The motivating bug: a model wrote `<ChartTooltipContent />` with no
`<ChartContainer>`, the artifact saved cleanly, and the page died with `useChart
must be used within a <ChartContainer />`. The model got a success back and had
no idea. Two layers now run before a save:

1. **Provider pairing** (`PROVIDER_PAIRINGS` in `create-artifact.ts`) — a table
   of names that oblige a wrapper. Only the chart family qualifies today: of the
   four components in `packages/react` that throw on a missing context
   (`useChart`, `useCarousel`, `useFormField`, `useSidebar`), only `Chart*` is
   exported from the shell's barrel. `Tooltip` needs a `TooltipProvider` but the
   shell pre-provides one, so requiring it would refuse working code. The
   `artifact-style` skill's chart recipe now shows `ChartContainer` as the
   mandatory wrapper, since the model wrote the broken code because the recipe
   did not.
2. **A real render** (`smoke-render.ts` in the shell package) — the component is
   compiled and rendered once server-side through the same
   `compileJsx`/`evaluateComponent`/`createToolsProxy` the iframe uses, with the
   same provider stack, and a `tools` transport whose promises never settle so
   every query stays pending. A synchronous first-render throw is refused with
   the real message plus React's component stack.

**Non-goal: data-shape errors.** Code that only throws once a tool returns an
unexpected payload is out of scope. Nothing is fetched at create time, and
inventing a plausible payload would reject correct code whenever the guess was
wrong. That class stays a runtime error inside the frame, where the shell's
error boundary already reports it. Undefined query data during loading is NOT in
this category — it is a real first-render crash and is caught.

Two constraints shaped the implementation:

- **Fail open, always.** The renderer is injected through a config seam, and if
  it breaks the artifact still saves. Refusing a valid create because our own
  check broke is the worse failure, and it is pinned by test.
- **workerd cannot evaluate.** `evaluateComponent` uses `new Function`, which
  Cloudflare refuses outright — so the runtime is probed once and the check
  reports `ok` for everything where it cannot run. Cloud therefore gets the
  static checks only; self-host and the HTTP hosts get the render. (Executor
  already runs model code on workerd through QuickJS for the same reason;
  putting React inside that sandbox is a much larger change than this is worth.)
  `apps/local` is also left out, because its consumer `apps/cli` cannot resolve
  the renderer's `.tsx` graph without `jsx` configured.

## Approving an artifact action (fixed)

Clicking a destructive action inside an artifact on cloud failed the approval
with `ExecutionNotFoundError`. The reported symptom pointed at an expiring
approval window, but the trigger was not time: a resume issued **7ms** after the
pause fails exactly the same way.

### Why it failed

The console's artifact page has no MCP client, so the shell's host adapter
(`packages/react/src/api/shell-host.ts`) reaches the server over the ordinary
executions HTTP API — `POST /executions`, then `POST /executions/:id/resume`.
On cloud those paths are served by the **stateless worker**, not by a Durable
Object: `makeExecutionStackMiddleware` builds a fresh executor + engine for every
request, and a paused execution lives only in that engine instance's in-memory
`pausedExecutions` map. The pause is therefore discarded with the request that
created it, and the resume lands on a new engine whose map is empty. `null` from
`engine.resume` became `ExecutionNotFoundError`, surfaced through the shell's
postMessage bridge as a JSON-RPC `-32603`.

The MCP plane never had this problem because its engine lives for the lifetime of
the session Durable Object, which is also why the #1300 cross-session work
(`McpExecutionOwnerDirectoryDO`, `resumeFallback`) is wired only into the MCP
`resume` path. That machinery routes a resume to the DO holding the pause; the
HTTP route carries no session id, so there was never a DO for it to find.

### The fix

An artifact action is not arbitrary code. The shell's grammar is exactly one
tool call, and the approval gate (`enforceApproval`) runs strictly *before* the
tool is invoked — so a paused artifact action holds no partial work, only a
resolved intent that has not happened yet. That makes the pause reconstructible
rather than something that must be kept alive.

`POST /executions` with an `artifactId` now records the resolved call as a
durable **pending approval** (owner-scoped, in the existing `blob` table, so no
migration and no new table), keyed by execution id. On resume, the handler first
tries the in-memory engine (unchanged, and still the path on local/desktop and
for any same-instance resume), and falls back to the durable record: it verifies
the record belongs to this caller, then runs the already-resolved call with the
approval applied. Records carry an expiry and are consumed on use, so an approval
is single-use and a decline drops it without running anything.

This is deliberately scoped to artifact-originated executions. General codemode
`execute` can pause anywhere inside arbitrary code, so its pause genuinely is a
suspended fiber and cannot be reconstructed this way; that path keeps its
existing behavior.

When resume finds neither a live pause nor a durable record, the shell now
renders an explicit expired-approval state ("trigger the action again") instead
of surfacing a raw MCP error.

### Follow-ups

- **Preference management UI.** "Approve and don't ask again" grants are stored
  client-side, per browser profile, keyed by artifact + tool address. There is no
  UI yet to review or revoke them; clearing site data is the reset. A grants
  list (view/clear) is the follow-up.
- Sharing will revisit both halves: a shared artifact executing tools with the
  viewer's connections needs the trust story in "Trust note" settled first, and
  don't-ask-again grants must not survive a change of artifact owner.
