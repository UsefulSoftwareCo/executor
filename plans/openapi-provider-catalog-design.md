# Providers as OpenAPI catalog entries

Decision (Rhys, 2026-07-07): dissolve `plugin-google` / `plugin-microsoft` into
the openapi plugin. No bulk-select picker — per-service OAuth killed the shared
consent that justified it; every service is added and authed individually, like
any other openapi integration. The dedicated Google/Microsoft add pages go away.

## Why this is small

Serving is already 100% openapi: both provider plugins' `resolveTools` /
`invokeTool` / `storage` are pass-throughs to `@executor-js/plugin-openapi`.
What the provider plugins actually own is add-time (spec acquisition/conversion,
scope selection UI) and identity (presets, icons, OAuth templates). The add-time
UI is being deleted, so what remains is data plus two spec converters.

## End-state model

### 1. Catalog entries (presets grow a little)

Each service/workload is one `IntegrationPreset` on the openapi plugin:

```ts
// packages/core/sdk — IntegrationPreset gains:
readonly family?: string;          // "google" | "microsoft" — grid grouping + umbrella label
readonly specFormat?: string;      // "google-discovery" | "microsoft-graph" (default: openapi)
readonly defaultSlug?: string;     // "google_gmail" — stable slug for policy/migration identity
readonly authTemplate?: readonly Authentication[]; // per-service OAuth: ONLY this service's scopes
readonly healthCheck?: HealthCheckSpec;
```

Google Calendar, Gmail, Drive, Docs, Sheets, YouTube, Photos (picker scope is
just this entry's scopes), Search Console, … and Microsoft Mail, Calendar,
Teams, Files, … are rows in this catalog. `featured` controls grid presence;
search finds the rest. The "single Google page" is gone — Google appears in the
picker as N entries (grid groups them under one umbrella, see §4).

### 2. Spec-format adapters (the only real new interface)

The openapi plugin accepts registered converters:

```ts
export interface SpecFormatAdapter {
  readonly id: string; // matches preset.specFormat
  /** Fetch + convert to the OpenAPI document shape the plugin already parses.
   *  Receives the preset URL(s) and auth credentials for authed spec hosts. */
  readonly fetch: (input: SpecFetchInput) => Effect.Effect<ConvertedSpec, OpenApiParseError>;
  /** Optional: derive identity (slug/name/description) from the fetched doc —
   *  powers custom Discovery URLs (google_tasks from the tasks discovery doc). */
  readonly deriveIdentity?: (doc: unknown) => DerivedIdentity | null;
}
```

Two adapters exist, both already written:

- `google-discovery`: `convertGoogleDiscoveryBundleToOpenApi` (discovery.ts) +
  the derived-identity rules from the parked stack (b14985d7)
- `microsoft-graph`: the 37MB Graph structural split (graph.ts). Fetch stays
  serial per process — the measured contention finding carries over as a note
  on the adapter, though without bulk add it rarely triggers.

Custom Discovery URL = the normal "add openapi spec" flow with format
`google-discovery`; identity derived from the doc; `google_custom` remains only
as the fetch-failure fallback. `microsoft_graph_custom` keeps explicit identity
(scopes carry no service identity).

### 3. Where the data lives

`@executor-js/plugin-google` / `-microsoft` shrink to data-only packages (or
fold into plugin-openapi outright — decide by size after deletion; bias: fold
in, packages are cheap to resurrect). They export `googleCatalog:
IntegrationPreset[]`, `googleDiscoveryAdapter`, `microsoftCatalog`,
`microsoftGraphAdapter`. Apps compose:

```ts
openapiPlugin({
  presets: [...googleCatalog, ...microsoftCatalog],
  specFormats: [googleDiscoveryAdapter, microsoftGraphAdapter],
});
```

Deleted entirely: AddGoogleSource.tsx, AddMicrosoftSource.tsx,
GoogleProductPicker, MicrosoftScopePicker, oauth-batches (scope batching served
the union-consent flow), the fan-out add APIs (addServices/addWorkloads,
added/skipped/failed result model, per-slug dedup locks, concurrency knobs),
both plugins' api/ groups and handlers, source-plugin.ts registrations.

### 4. Grid

Grouping (#1336) is harvested nearly as-is, with one change: key off
`preset.family` / integration config instead of `integration.kind` (everything
is kind "openapi" now). The family tag is stamped into the integration config
at add time so grouping works without a preset lookup. Umbrella card, entry
testids, slug-keyed icons all carry over.

### 5. OAuth / accounts

Each catalog entry's `authTemplate` carries exactly its service's scopes —
the consent screen asks for one service's access, which is the behavior that
motivated killing shared auth. The account-entity/login_hint work (#1311,
merged) is unaffected: connections still group by provider account, so adding
Gmail then Calendar with the same account is two consents but one visible
account. Connection cloning in the migration hands every derived service a
copy of the monolith token (union scopes) — grandfathered; converges as users
reconnect.

## Migration retarget

The planner from #1337 (policy fan-out with never-widen, connection cloning,
serving-state carry, ledger/resume, hard-error gating) survives with a new
target shape:

- created rows: `plugin_id = 'openapi'`, slug = catalog `defaultSlug`
  (unchanged: google_gmail, …), config = openapi config with
  `specFormat: "google-discovery"`, discovery URLs, family, specHash carried
- plugin_storage operation rows re-keyed under the openapi plugin's collection
  (same content-addressing; R2 blobs untouched)
- policies: same fan-out, same slugs — policy semantics identical to v2 dry-run
- connections: cloned (approved), provider/account fields preserved
- refactor into pure planner + two runners (cloud Postgres CLI; libSQL boot
  migration for selfhost + local registries, name
  `2026-07-XX-provider-service-split`). Boot rail can't ask a human: orphan
  block/require_approval policies are retargeted to the derived service as
  dormant rows, never dropped, never boot-blocking. The cloud CLI keeps
  fail-fast + the org 8fcaa0e54239 decision.
- prod dry-run rerun against the new shape before any apply; same review gate.

## Sequencing

1. Core: preset fields + openapi `specFormats` option + adapter interface
2. Move discovery.ts / graph.ts behind adapters; catalog data; delete provider
   add UI/APIs/plugins; grid family-tag grouping
3. e2e: adapt parked-stack specs (add google_calendar via catalog; custom
   discovery URL derives google_tasks; grid umbrella)
4. Migration planner refactor + both runners + dry-run v3
5. Park→close stack PRs #1308/1309/1315/1334/1336/1337 once the branch is up

Open items to settle during build, not before: exact `ConvertedSpec` shape
(reuse existing `OpenApiIntegrationConfig` plumbing), whether photos picker
needs any UI affordance beyond its scope set, fold-in vs data-only packages.
