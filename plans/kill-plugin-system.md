# Kill the plugin system — in-place migration plan

Decision (Rhys, 2026-07-27): abandon the big-bang rework
(`UsefulSoftwareCo/executor-rework`, cloned read-only at
`.reference/executor-rework`); fix this repo in place over a sequence of PRs,
each keeping format/lint/typecheck/test/e2e green. Priority order: **data
models first**, then the plugin kill, then the concept-package (apps) model,
then the minimal SDK / platform split.

RESEQUENCED (Rhys, 2026-07-28): **Phase 3 (apps/concept-package model) now
lands BEFORE Phase 2 (plugin kill), side by side with the protocol plugins.**
Rationale: the new model's tables are greenfield and additive — landing it
first means the legacy apps tables never need an in-place migration; the whole
model swaps underneath while openapi/mcp/graphql keep running as plugins.
Structurally sound because (a) the kernel + MCP host are already plugin-free,
so the new model's runtime never touched the registry, and (b) the apps plugin
already exercises every extension point, so the new model ships as the apps
plugin's new internals wearing the same costume. When 2.3 later converts the
four kinds, apps converts as a stable, proven model instead of mid-rewrite.
Phase 0 and 2.1 remain freely parallel — they don't touch apps.

Hard line: side-by-side means new-apps-model alongside the _protocol plugins_,
never two app models with dual read paths inside the apps kind. Existing app
sources get a one-off migration to published-source form (enumerated
invariants, explicit approval, no permanent compatibility path). Accepted
cost: the new model's HTTP surface temporarily wears plugin-route ceremony
(HttpApiGroup + handler layers) that 2.2/2.6 later deletes — wiring, not
model. The authoring SDK (`defineApp`/`defineProvider`/`defineTool`) goes
public early; its boundaries take Standard Schema (StandardSchemaV1 &
StandardJSONSchemaV1), never Effect Schema, and Phase 4's vocabulary rules
(opaque owner refs, no "tenant") bind on it from day one.

## Diagnosis (verified against the code)

**The plugin system is a fiction.** `packages/core/sdk/src/plugin.ts` (~850
lines, ~20 optional hooks) pretends the plugin set is open, but:

- `Integration.kind` _is_ the plugin id string; all hot paths dispatch via
  `runtimes.get(row.plugin_id)` (`executor.ts`).
- Core and React hardcode the closed set anyway: `migration-spec.ts` hardcodes
  plugin ids; `packages/react` has `KIND_TO_PLUGIN_KEY` maps and an
  `if (pluginId === "toolkits")` route branch.
- Nobody ever shipped a fourth protocol plugin, and the two provider plugins
  (google/microsoft) were already collapsed into openapi (#1366).
- Whole packages exist only to support the open set: `plugin-routes.ts`
  type-union machinery, `@executor-js/config`'s jsonc+jiti loader,
  `packages/core/vite-plugin`'s virtual client module. The jsonc plugin path is
  vestigial — no `executor.jsonc` exists anywhere in the repo, no docs mention
  it.
- Toolkits (~880 LoC of pure curation + the single `toolPolicyProvider` slot)
  and apps (~6.8k custom-tools gateway) are first-party capabilities wearing a
  plugin costume. Kernel packages and `packages/hosts/mcp` have zero plugin
  references — the indirection is not load-bearing for the real surfaces.

**The data model is connection-first, not user-first**
(`packages/core/sdk/src/core-schema.ts`):

- No user/subject table. `subject` is an opaque partition-key string smeared
  across owned tables; a user "exists" only if they have a connection row.
- Disconnect is a hard delete (`connectionsRemove`) — a signed-out user is
  bit-identical to one who never connected. "Which users are signed out" is
  structurally unanswerable.
- Every Executor is bound to one `{tenant, subject}` via `owner-policy.ts`;
  there is no cross-subject read path, so no admin view.
- Toolkit state lives in generic `plugin_storage` KV, not core tables.
- Cloud's real identity tables (WorkOS accounts/organizations) have no join to
  `subject`.

**What to salvage from the rework** (its model docs are the valuable artifact;
its implementation ported only ~10 of 131 legacy e2e scenarios — that's why it
failed, and why this plan is incremental):

- Apps-as-published-source: `defineApp`/`defineProvider`/`defineTool`/
  `defineToolGroup`, immutable content-hashed versions, manifest derived by
  executing the source, rollback = pointer move.
- Generators: OpenAPI/MCP specs generate the _same_ app source a human would
  write, with a re-verifiable `GeneratorClaim` (first-party vs third-party).
- Minimal SDK boundary: `createExecutor`/`createRemoteExecutor`, no Effect
  crossing the boundary, MCP exposure returns a standard MCP SDK server.
- Custody separation: secrets never on the wire; opaque owner refs.

## Constraints discovered (do not relearn these)

1. **Published packages make this semver-major.** `scripts/publish-packages.ts`
   publishes `@executor-js/{config,sdk}` and plugins
   `{example,file-secrets,graphql,keychain,mcp,onepassword,openapi}` — killing
   `definePlugin` is a breaking release for seven packages. Changesets +
   deprecation story required; `publish-packages.ts`, `pkg-pr-new.yml`,
   `check-changelog-stubs.ts`, and `examples/*` all have hardcoded lists.
2. **`plugin_id = 'google'` is a live persisted value with no runtime.** The
   provider-service-split migration skips orgs with missing spec blobs
   (`sqlite.test.ts` asserts survivors). The `googleDiscovery → "google"`
   entries in React are compensating, not dangling. The closed SourceType
   switch must map `"google"`/`"googleDiscovery"` → openapi or degraded rows
   become hard failures.
3. **FumaDB is not versioned in practice.** All hosts pin `version: "1.0.0"`;
   runtime bring-up is `ensureDrizzleRuntimeSchemaFromTables` (CREATE TABLE IF
   NOT EXISTS + additive nullable ALTERs). New tables/nullable columns are free
   on local/self-host/D1. **Cloud is the exception**: hand-edit
   `apps/cloud/src/db/executor-schema.ts` + drizzle-kit migration +
   `db:migrate:prod`; `db.schema.test.ts` enforces the mirror, so "forgot
   cloud" fails tests.
4. **93 e2e files import `composePluginApi`** purely to type the client. Keep
   it as a deprecated argument-ignoring shim returning the static
   `FullExecutorApi`; sweep the call sites mechanically in one final PR.
5. **Keep the `plugin_id` column name** (four tables + blob namespace format
   `o:<tenant>/<plugin_id>`). Renaming to `source_kind` is a cross-host
   migration for zero behavior. Retype on the read side only.
6. **URL contracts:** `/integrations/add/$pluginKey` is navigated directly by
   e2e; `/plugins/desktop-settings/` is asserted by the desktop-packaged suite
   and baked into a tool's returned URL. Keep shapes / add redirects.
7. **CI gaps:** PRs run cloud (4 shards) + selfhost e2e only; local/desktop
   suites gate push-to-main. PRs touching desktop-settings or the local loader
   need a manual local e2e run pre-merge.
8. **Toolkit selection filters _connections_, not just tools**
   (`connectionsList` goes through the active policy provider). Preserve when
   moving toolkits to core, or the toolkit e2e suites go red.

## Phase 0 — declutter (3 PRs)

- **0.1** Delete empty `packages/plugins/{google,microsoft}`; drop the unused
  `@executor-js/config` dep from openapi/mcp/graphql; move
  `provider-service-split` to `packages/migrations/` (keep package name — it's
  imported by three host data-migration registries). In the React maps, keep
  `google`/`googleDiscovery` → openapi with a comment citing constraint 2.
- **0.2** Bake google/microsoft catalogs + spec-format adapters in as openapi
  defaults; strip the re-threading from all four host configs. Gate:
  `provider-plugins-ui`, `google-health-checks`, `microsoft-*` scenarios.
- **0.3** Move desktop-settings (438-line Electron-IPC client, not a
  one-liner) to a first-class desktop-only route in `packages/app`; update the
  static tool's URL and the desktop-packaged e2e selector; delete the plugin.

## Phase 1 — data model (4 PRs) — FIRST PRIORITY

Design choices (least-invasive, verified feasible):

- The new **subject table is `tenant`-scoped, not owner-scoped** — readable by
  any executor bound to the tenant with **zero policy changes** (the
  `integration` table already proves the pattern).
- Cross-subject connection reads: add `reach: "bound" | "tenant"` to
  `ExecutorOwnerPolicyContext` — widens `ownerVisibilityCondition` for reads
  only; `assertOwnerWritable`/`assertOwnerPatch` untouched, so admin reach can
  never write. Only two construction sites exist (`executor.ts`,
  `test-config.ts`).
- Identity stays with the hosts (WorkOS / Better Auth member lists already
  exist behind `AccountProvider.listMembers`); the subject table is the missing
  **join** between host identity and executor connections, not a new identity
  system. Tolerate `subject = null` (pure-org) and `subject = "local"`.

PRs:

- **1.1** Add tenant-scoped `subject` table (id, tenant, external_id,
  created_at, last_seen_at, status) to `coreTables` + cloud mirror + one
  drizzle migration. No readers yet.
- **1.2** Populate: upsert in `makeScopedExecutor`
  (`packages/core/api/src/server/scoped-executor.ts` — every HTTP request and
  MCP session on all four hosts passes through it) and at connection-create.
  Add to `purgeOrganizationData` + its `TENANT_TABLES` test.
- **1.3** `reach` mode + `admin.listSubjectsWithConnections`-shaped read on a
  derived handle. Policy test proving admin reach cannot write. Scope includes
  (customer ask, owner.com 2026-07-27): per-subject reads ("connections for
  subject X"), not just the aggregate list, and a privileged org-level API key
  (keys already carry `{accountId, organizationId}` —
  `apps/cloud/src/auth/api-keys.ts`) that resolves to the tenant-reach
  read-only handle so customers can inspect connections programmatically.
- **1.4** Connection lifecycle: nullable `status` column
  (active/disconnected/revoked/expired) plus `status_changed_at`; disconnect
  writes status instead of deleting. Wide blast radius — status predicate
  through `findConnectionRow`, `connectionsList`, credential resolution,
  `toolsList`, org purge; own e2e sweep (`connections-*`, `health-checks*`,
  `oauth-*`). PRIORITY RAISED (customer, 2026-07-28): the customer's
  block-startup-until-reconnect flow needs connected-then-disconnected to be
  distinguishable from never-connected, which hard-delete makes impossible
  today; expose status + statusChangedAt through the admin API when this
  lands.

Toolkits data does NOT move in this phase (it moves with its reader in 2.4 —
moving it earlier means either rewriting the plugin storage layer twice or a
forbidden dual read path).

### Framing: product view vs platform view (Rhys, 2026-07-27)

The two-view model for consumer-facing surfaces, longer-term:

- **Product view** — the bound, per-individual executor every request gets
  today (their connections, their tools). The default; unchanged.
- **Platform view** — an operator-level view attached alongside it: read-only,
  cross-user, explicitly reached for with elevated access (an escape hatch,
  never a mode product view drifts into). The `reach: "bound" | "tenant"`
  split in 1.3 is this model's first implementation; 1.5's admin API and the
  privileged key are its first surface. Later platform-view candidates (usage,
  policy overview, cross-user health) land on the same handle.

Cloud wrinkle: cloud consumers like owner.com don't bring their own owner ids —
their users authenticate through our WorkOS, so `subject` is _our_ accountId
and the customer correlates on their side. The opaque-owner-ids-in-the-
customer's-id-space story fully applies only to embedded/API consumers; for
cloud, the platform view (+ `external_id` on the subject table) is what makes
the correlation tractable.

### Fast path: owner.com admin-visibility ask (ships from Phase 1 alone)

The owner.com ask (admin inspects users' connections; API key that can do the
same; available-vs-connected icon grid; direct connect links) needs only
1.1 → 1.2 → 1.3 plus a thin delivery layer — no dependency on Phase 0 or the
plugin kill. Delivery PRs on top of 1.3:

- **1.5** Public admin API surface: `GET .../admin/users`,
  `GET .../admin/users/:externalId/connections` (integration slug + status +
  last_health only — never item_ids/oauth fields), gated on the privileged key
  / admin membership. Public paths say `users`, not `subjects`/`tenants` — see
  "Vocabulary" below. The available-vs-connected diff is computable client-side
  from this plus the existing integration catalog.
- **1.6** Connect deep links: stable
  `/connect/:integrationSlug`-shaped URL that lands the arriving user in the
  connect flow for that integration (auth-aware redirect). Uses integration
  slugs, not plugin routes, so it survives Phase 2.5 unchanged.

  1.4 (lifecycle status) upgrades the grid from binary connected/not to
  expired/disconnected states but is not a blocker for first ship.

## Phase 2 — kill the registry (6 PRs)

- **2.1** Remove dynamic loading: delete `load-plugins.ts` from
  `@executor-js/config` (keep the rest — jsonc integration config is a separate
  feature), drop `loadPluginsFromJsonc` from `apps/local`, delete
  `packages/core/vite-plugin`, replace `virtual:executor/plugins-client` with a
  static module in `packages/app` (5 `__root.tsx` importers + 3 ambient
  `.d.ts`), edit `turbo.json` `dev.dependsOn` + root `prepare`, fix
  `packages/app/vite.config.ts`'s dangling jsonc path. Breaking changeset.
- **2.2** Static route list: `composePluginApi` becomes the deprecated shim
  (constraint 4); hosts stop passing plugin tuples; delete
  `apps/{cloud,host-selfhost}/src/plugins.ts` (exist only to hold
  `PluginExtensionServices` typing).
- **2.3** The switch: closed internal `SourceType` interface implemented by
  openapi/graphql/mcp/**apps (current model, unchanged)** as plain libraries,
  replacing `runtimes.get`. All four kinds convert together — converting three
  and leaving apps on the plugin path means carrying dual dispatch; rewriting
  the apps model in the same PR is what killed the rework. Map
  `"google"`/`"googleDiscovery"` → openapi. `plugin_id` column name unchanged.
- **2.4** Toolkits to core: core tables + one-off migration out of
  `plugin_storage` (enumerated invariants, no dual path), `toolPolicyProvider`
  slot → native policy input (one call site, one implementation, one test),
  ordinary core routes, `activeToolkitSlug` becomes an executor option.
  Preserve the connection-visibility filter (constraint 8).
- **2.5** React: four named kind renderers; move plugin React code (~2.9k LoC,
  e.g. `AddMcpIntegration.tsx`) into `packages/react` — watch the peer-dep
  edge for cycles; delete `defineClientPlugin`, the plugins context, both
  `KIND_TO_PLUGIN_KEY` maps, and `/plugins/$pluginId/$` (with redirects for
  desktop-settings + toolkits). Keep `/integrations/add/$pluginKey` URL shape.
  Don't forget the second axis: `useSecretProviderPlugins` (secrets page).
- **2.6** Detach `CredentialProvider` from `PluginSpec` (the interface in
  `provider.ts` is already narrow — secret-store plugins keep it as their
  seam); delete `plugin.ts`, `plugin-routes.ts`, `plugin-example`, and the
  shim; mechanical sweep of the 93 e2e files; changesets for all seven
  published packages.

## Phase 3 — custom = concept package (3–4 PRs) — NOW BEFORE PHASE 2

(See RESEQUENCED note at top: lands side by side with the protocol plugins,
inside the apps plugin's existing costume; Phase 2 kills the registry
afterward, with apps converting in 2.3 as an already-stable model.)

Port the rework's app model in place as the `apps` source kind's new model:
published source, manifest derived by execution, content-hashed immutable
versions, rollback = pointer move. New tables are additive greenfield (same
pattern as 1.1: coreTables + cloud mirror + migration, no readers first).
Existing app sources migrate one-off to published-source form — no dual model
within the apps kind. Then the OpenAPI/MCP generators + `GeneratorClaim` as an
optional on-ramp (spec → generated app source); GraphQL generator later.
Long-term option (explicitly out of scope): protocol kinds themselves become
generators and "custom" is the only kind.

### Feasibility findings (two deep read-throughs, 2026-07-28)

**Current plugin** (~7.6k LoC): only ~2.65k encodes the old model (store
collections, sync state machine, publish/discover/descriptor, routes,
console client). ~2.6k is model-agnostic and survives verbatim: all three
sandbox executors, the bundler stack, bindings/bridge, authoring +
standard-schema, conformance. ~1.9k (hand-rolled git client + source
fetchers) hangs on the publish-input decision below. Storage is entirely
generic `plugin_storage` rows + content-addressed blobs — zero apps-specific
tables or migrations exist, so new tables are pure greenfield. Cloud prod is
git-source-only; **source text is never persisted today (only compiled
bundles)**, so the one-off migration re-fetches source from the recorded git
URLs (fetcher exists). Load-bearing invariants to preserve: tool addresses
`tools.<app>.org.published.<name>` + the `<fileSlug>__<key>` naming rule,
app-slug↔integration-slug 1:1 guard, publish CAS
(`AppPublishConflictError`), tombstone-not-delete, token-in-provider-item
(never in the source row). Safety net: `custom-tools.test.ts` (534-line
cloud+selfhost console loop), local directory-picker, packed-CLI, desktop
e2e, ~2.9k LoC in-package tests. Pre-existing gaps flagged: R2 blobs never
GC'd and org purge misses them; cloud silently falls back to in-process
executor without the worker loader; host-cloudflare doesn't register apps.

**Rework model** (portable tiers): T1 model proper ~3.9k LoC (authoring SDK,
publish-by-execution, projection, generator verification, storage port,
content hashing); T2 generators ~3.2k (fromOpenAPI 1k — complete; fromMCP
0.6k — computed group with real streamable-HTTP client; json-schema engine;
byte-for-byte GeneratorClaim verification; render endpoint); T4 host/registry
~2.9k explicitly skipped. Authoring is Standard Schema
(StandardSchemaV1 & StandardJSONSchemaV1) with raw-JSON-Schema literals as a
typed first-class alternative — matches our rule. Effect beta.93→beta.59
delta is small (ConstraintDecoder → one-line fix; hand-roll
StandardJSONSchemaV1 ~10 lines; reuse core sha256Hex). NOT portable as-is:
rework `storage-db.ts` (write a new adapter over our tables against the
~90-line Storage port interface) and `engine.ts` (extract only ~700 LoC of
model-owned logic: computed-surface cache + requirement resolution +
runTool). Known rework gaps to fix at port time, not inherit: derive-time
execution is unsandboxed in-process (`code-executor.ts:23` records it) — our
port MUST run publish-time evaluation in the existing sandbox `collect` path
from day one; fan-in computed groups unsupported; OAuth discovery
unsupported.

**Semantic deltas — decided by Rhys before 3.1 specs:**

1. **Handler credential contract (the deep one).** Current: handlers get an
   opaque callable `AppIntegrationClient` proxy that re-enters
   `ctx.execute` — app code never sees credentials, can only call other
   executor tools. Rework (D49): engine resolves credentials once and hands
   the handler **credential fields as data** (`ResolvedConnection.fields`,
   e.g. access_token) for direct HTTP — that's what makes generators
   possible (generated code does raw fetch with auth) and what
   `defineProvider` exists for. Not either/or in principle (a tool-call
   bridge can coexist as a second requirement kind later), but the ported
   model's primary contract is fields-as-data per the rework.
2. **Publish input.** Rework publish takes `SourceFiles` (push-based).
   Decision: keep git/local-directory as _fetchers that produce
   SourceFiles_ (preserves prod sources, the e2e suite, and the migration
   path; git-client survives), with direct push publish added as the new
   API. Delete-git-later stays open.
3. **App identity** moves from caller-supplied slug to the `defineApp`
   export inside the source (rework shape).
4. **Versioning**: content hash of source IS the version identity; the
   caller-supplied `sourceRef` + descriptor v6 die with the old model.
5. **Ownership**: app/version rows carry `space` and NO owner — spaces
   curate apps, principals own custody (connections stay on the legacy
   owner model in this phase; the opaque-OwnerRef swap is Phase 4).

### Phase 3 PR sequence (revised)

- **3.1** Port the model core as internal packages, no readers: authoring
  SDK + runtime brands, publish pipeline (evaluation routed through the
  sandbox `collect` seam), Storage port + adapter, greenfield tables
  (`app`, `app_version`, `computed_surface` — space column, content-hash
  identity, `current` pointer) in coreTables + cloud mirror + migration.
  Ported rework tests come along (authoring-boundary, tool-groups,
  publish).
- **3.2** Swap the apps plugin's internals onto the new model behind the
  same costume: resolveTools/projectToolSchema/invokeTool read the new
  tables; publish endpoint (`POST` source files); setCurrent/rollback +
  versions listing routes; git/local-dir sync becomes fetch→publish.
  Tool addresses and slug guards preserved; old collections
  (`apps_descriptors`/`apps_tools`/`apps_sources`) still written by
  NOTHING — one-off migration converts existing sources (re-fetch from
  git), then the collections are dead. e2e: full existing custom-tools
  suite green + new version-history/rollback scenario.
- **3.3** Console UI for the new model (sources → apps with versions,
  publish status, rollback) replacing the ~1.3k LoC old client/panels.
- **3.4** Generators: fromOpenAPI + fromMCP + GeneratorClaim verification +
  render endpoint, surfaced as the "add from spec/server" on-ramp.
  (Vendors google/microsoft conversion ~1.15k LoC ports later with 0.2.)

## Spaces: the rework's tenancy primitive (added Rhys, 2026-07-28)

The rework's SDK has exactly one tenancy concept: `SpaceId`
(`.reference/executor-rework/docs/TENANCY.md`, `docs/MODEL.md`). Adopt it as
the end-state tenancy model here. The shape:

- **Flat, no hierarchy, no default.** No parent, no inheritance, no
  distinguished rows (rework D39/D44b). Sharing is an explicit act, never a
  tree walk (R2 — re-ruled twice, do not relitigate). Every scoped row
  carries a `space` column; every space-scoped route carries the space in
  the URL path, never ambient context.
- **No org/project/team/user below the deployment edge.** The engine answers
  "what is in this space"; the deployment answers "who is this and which
  spaces may they touch" through named seams (`authorizeBrowserResource`,
  `dashboardSpacesForPrincipal`, MCP space resolver). Membership is
  authorized LIVE per request at the edge — projection may be cached,
  authorization never.
- **Deployment mappings:** cloud = one WorkOS org mirrors lazily to one
  space (mirror row `workosOrgId → space` is also the billing join — Autumn
  keys on workosOrgId, never a space); self-host = one instance, one
  found-or-created "Default" space, Better Auth org repurposed as the
  instance membership table; local/desktop = one "local" space, one static
  principal, single-tenancy declared via explicit sentinel, not defaulted.
- **Spaces curate, principals own.** Custody (secrets, connections'
  secret-bearing halves) belongs to principals via opaque `OwnerRef` +
  per-request `Reach` (R3); spaces curate apps and hold rows. Publishing an
  app into a space IS its presence there — no installation rows, no
  bindings; cross-space arrival (sharing/registry) is a future share-edge
  row, not golden-path ceremony (D45/D42).
- Cross-org OAuth callbacks complete into the _initiating_ org's space; the
  org header is a routing hint, not an authorization statement (R7).

**DECIDED (Rhys, 2026-07-28): spaces land in the CORE PRODUCT NOW — Phase S,
before the apps port.** Apps then publishes into real spaces from birth.

**Mapping onto this repo — the no-migration trick:** today's `tenant` column
is de facto the space — cloud writes the WorkOS org id there, self-host/local
write one constant. So: keep the persisted `tenant` column name (same rule as
`plugin_id`), and declare that **its value IS the space id**. Each org's
first space is grandfathered with `spaceId = <historical tenant value>` (the
org id); NEW spaces mint fresh ids written into the same column. The org→
space mirror table records which space ids belong to which org (and carries
the billing join — Autumn keys on workosOrgId, never a space). Existing rows
never move; multi-space needs no schema change on scoped tables. "Space" is
contract vocabulary; "tenant" retreats to cloud-internal (see Vocabulary).

### Phase S — spaces in core (before apps)

- **S1 — space table + boot ensure (no readers).** Greenfield `space` table
  (id, name, created_at) in coreTables + cloud mirror + migration, plus the
  cloud `org→space` mirror table. Boot/first-contact ensures the degenerate
  space per deployment: cloud lazily on first authenticated org contact
  (grandfathered id = org id), self-host "Default", local "local". Same
  no-readers pattern as PR 1.1.
- **S2 — space threading.** `SpaceId` brand in the SDK; the scoped-executor
  seam resolves request → space id (today: identical to tenant) and stamps
  it; reads interpret `tenant` columns as space ids. No behavior change —
  this is the retype + vocabulary PR. `reach: "tenant"` reads as
  "space-wide reach" from here on.
- **S3 — multi-space on cloud + product surface.** Create/rename space,
  space switcher in the console, membership = org membership (all spaces of
  the org for now), org→N mirror rows, space-scoped catalog/connection
  views (rows follow automatically — they're keyed by the space id in the
  tenant column). Billing stays org-keyed via the mirror. e2e: two spaces
  in one org, isolation of catalogs/connections between them, switcher.
- **S4 — sharing model on spaces.** Connect-time "share with space" writes
  the space's shared owner-ref (replaces the org tier semantically; the
  persisted `owner: "org"|"user"` column keeps its name, read-side
  reinterpretation only). Edge computes reach as
  [principal, sharedRef(space) for each member space]. This is the bridge
  to Phase 4's full owner-set reach.
- **Later (not scheduled): local multi-space, file-backed.** Each local
  space is its own store file (portable — copy/backup/sync/check in
  alongside a repo); the daemon opens one storage handle per space and
  routes by space id; the engine still sees flat SpaceIds. Custody never
  enters the space file — secrets stay in the principal-keyed provider
  (keychain), so a copied file carries connection metadata, never tokens.
- Phase 4 completes the picture: space-in-path routes,
  `dashboardSpacesForPrincipal`-style seams, reach as an explicit owner
  set.

Apps (Phase 3) then lands after S1/S2 — app rows carry a real `space` FK
from birth; S3/S4 can proceed in parallel with the apps port.

Interaction with shipped Phase 1 work: the subject table and platform view
are edge/deployment concepts (who exists in this identity world, what may
an operator read) — they sit above spaces and survive unchanged; `reach:
"tenant"` becomes "space-wide reach" vocabulary-wise at Phase 4.

## Vocabulary: retire "tenant" from consumer-facing surfaces (Rhys, 2026-07-27)

Direction: the SDK should be agnostic to the consumer's data-model shape, the
way Composio's is — consumers pass an opaque user/owner id string and hang
whatever hierarchy they have (user, team, workspace) off it; the SDK never
models their org chart. The rework already designed this (`OwnerRef` opaque
brand, `Reach = {owners}`, deployments translate identity at the edge) — adopt
its vocabulary, not its schedule. "Tenant" remains a real _internal_ concept
(which Executor-cloud org owns the rows) but must not leak into surfaces
consumers touch.

Rules, effective immediately:

- Persisted column names (`tenant`, `subject`, `owner`) stay — renaming
  storage is a cross-host migration for zero behavior (same rule as
  `plugin_id`).
- Internal policy code (`reach: "tenant"`, `ExecutorOwnerPolicyContext`) may
  keep the words.
- One contract noun: **`owner`** — the opaque ref naming who a connection
  belongs to (end-user, team, workspace, or the org itself; the rework's
  `OwnerRef`). "User" cannot be the contract noun because org-shared
  connections are a load-bearing feature an end-user word can't cover.
- **"user" is presentation vocabulary only**, for surfaces whose rows genuinely
  are the customer's end-users — the Phase 1.5 admin API says `users` because
  the subject table is populated from authenticated principals.
- Hazard: the persisted `owner` column keeps its old meaning (the
  `"org" | "user"` tier discriminator), while Phase 4 introduces the opaque
  ref as a distinctly named type (`OwnerRef`). Same word, two meanings,
  separated by layer — say so in policy-layer comments.
- The full swap (opaque owner refs at the SDK boundary, tenant retreating to a
  cloud-internal detail) lands with the Phase 4 minimal SDK.

## Phase 4 — minimal SDK + platform/product split

New consumer boundary modeled on the rework: `createExecutor` /
`createRemoteExecutor`, no Effect at the boundary, `tools.list/execute` +
connections + the new users/admin surface; policies/toolkits become optional
layers consumers opt into, not baked opinions (Composio-style minimalism).

Authorization end-state (Rhys, 2026-07-27): the engine enforces scope
mechanically but never decides policy — the host computes, per request, the
set of owners the request may read (the rework's `Reach = { owners }`), and
the storage predicate is just `row.owner ∈ reach.owners`. The 1.3
`reach: "bound" | "tenant"` enum is a stepping stone and is replaced by this
set shape here: "bound" = a reach of one, "tenant" = all owners (wildcard so
cloud needn't enumerate), and in-between cases (team views, support sessions,
subset-restricted org keys) are just different sets. Writes stay hard-pinned
to a single owner; only read reach generalizes. Trust model becomes a
per-deployment choice: a trusted backend with a server key gets tenant-wide
reach and layers its own authorization (Composio-style); an end-user session
gets a reach of one. The enum-to-set swap is contained: the policy context is
constructed in exactly two places.
Start the platform/product package separation _during_ 2.3–2.6 (each PR moves
one thing to its final home) rather than as a big bang; the SDK boundary
itself lands last.

## Bookkeeping

- Create `MISTAKES.md` / `DESIRES.md` / `LEARNINGS.md` (required by AGENTS.md,
  currently missing) with the first entries from this migration.
- `apps/local/src/db/executor-schema.ts` is already stale vs `coreTables`
  (missing several columns); its "keep in sync" comment is untrustworthy —
  runtime schema comes from the ensure path, not this file.
