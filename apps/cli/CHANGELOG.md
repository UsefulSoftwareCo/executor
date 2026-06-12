# executor

## 1.5.9

### Patch Changes

- [`fe4153d`](https://github.com/RhysSullivan/executor/commit/fe4153d0956d09332465f2e7bcbdee6ce55f0494) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Fix a Windows race in the local v1→v2 database migration: the legacy
  database rename could hit `EBUSY` (file still held by the just-closed
  SQLite handle or an antivirus scan) and crash the app at boot. The retry
  window now covers the lock instead of giving up after ~2 seconds.

  Also hardens the desktop release pipeline so a hung platform build fails
  fast instead of blocking later releases.

- Updated dependencies []:
  - @executor-js/sdk@1.5.9
  - @executor-js/runtime-quickjs@1.5.9
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.29

## 1.5.8

### Patch Changes

- [#983](https://github.com/RhysSullivan/executor/pull/983) [`bcfdeb2`](https://github.com/RhysSullivan/executor/commit/bcfdeb23316b3266f00a9aae6b67d525a67ce8dc) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Hardened the local v1→v2 database upgrade**

  Upgrading a local database created by an older (v1) release is now resilient to
  interrupted or partially-written upgrade state:
  - The one-time upgrade is recorded in the migration ledger, so it is never
    re-attempted on later boots. Databases that have already upgraded are detected
    from the ledger and skip the upgrade path entirely.
  - Replaying the legacy schema now tolerates a missing or truncated migration
    journal instead of failing to start, so a database left in a half-written
    state from a previous crash boots cleanly.

- Updated dependencies []:
  - @executor-js/sdk@1.5.8
  - @executor-js/runtime-quickjs@1.5.8
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.28

## 1.5.7

### Patch Changes

- [#964](https://github.com/RhysSullivan/executor/pull/964) [`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Desktop crash reporting and diagnostics**
  - The desktop app now reports crashes from all of its processes (window, main, and the local server sidecar), so launch failures and silent exits become fixable bugs instead of mysteries. Reporting is disabled in local/dev builds and honors `DO_NOT_TRACK=1` as an opt-out.
  - If the local server crashes, the app shows a crash screen with restart and update actions instead of closing silently, and the server's output is persisted to the log file.
  - New **Export Diagnostics** (menu and Settings) zips logs, crash dumps, and a redacted system manifest to Downloads — never secrets or executor data — and **Report a Problem…** prefills a GitHub issue with the diagnostics attached.

- [#964](https://github.com/RhysSullivan/executor/pull/964) [`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Faster integrations with large API specs**

  Resolved OpenAPI spec text and GraphQL introspection snapshots are now stored content-addressed in the plugin blob store instead of inline in each integration's stored config. Listing integrations no longer loads multi-megabyte spec blobs it immediately discards, which makes the integrations surface dramatically faster for workspaces with large specs. Existing integrations keep working: rows that still inline a spec resolve unchanged and are rewritten in place the next time they are imported or refreshed.

- Updated dependencies [[`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15), [`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15)]:
  - @executor-js/sdk@1.5.7
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.27
  - @executor-js/runtime-quickjs@1.5.7

## 1.5.4

### Patch Changes

- [#943](https://github.com/RhysSullivan/executor/pull/943) [`f485e4a`](https://github.com/RhysSullivan/executor/commit/f485e4a23cf3756b9e628cf2d9242fbc0b3da178) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **One auth model across OpenAPI, GraphQL, and MCP**
  - Every protocol plugin now stores the same placements-based auth methods (the new `@executor-js/sdk/http-auth` vocabulary): an API-key method carries any mix of header and query placements, each rendered from its own credential input — so one source can declare OAuth, a bearer-header-plus-team-id-query method, a plain bearer, and a query token side by side, and one connection can carry several values (e.g. both Datadog keys).
  - MCP and GraphQL gain what only OpenAPI could do before: multi-placement methods, query-parameter credentials (servers like ui.sh's `?token=`), and multi-input connections. Rendering, catalog projection, slug normalization, and the React method editor/codec are shared instead of triplicated; the connect modal collects one value per input.
  - Invoking with an unresolvable credential input now fails with `connection_value_missing` (naming the missing inputs) instead of silently dialing unauthenticated.
  - Stored integration configs are rewritten to the canonical shape by a one-off migration: local and self-host run it automatically at startup; cloud operators run `bun run db:migrate-auth:prod` before deploying. Connection bindings and stored credential values are preserved exactly.
  - Authoring: apikey methods are authored in ONE request-shaped dialect on every plugin — it reads like the request it produces: `{ type: "apiKey", headers: { Authorization: ["Bearer ", variable("token")] }, queryParams: { team_id: [variable("team_id")] } }` (`variable()` is exported from each plugin; a plain-string value is a static literal). Inputs normalize to the canonical placements model, which is what stored configs and the catalog read as. Authoring is strict where the renderer is: a value carries at most one variable, as the final part.
  - Every method is keyed by `kind` — OpenAPI's oauth templates re-key from the retired `type: "oauth"` spelling to `kind: "oauth2"` (matching MCP/GraphQL); the one-off migration rewrites stored entries.
  - Breaking (wire): the retired single-placement inputs (`headerName` on MCP, `in`/`name` on GraphQL), raw canonical-placement inputs, and `type: "oauth"` oauth inputs are rejected. The `mcp.addServer` singular `auth` shorthand still works.

- [#950](https://github.com/RhysSullivan/executor/pull/950) [`dbb48ec`](https://github.com/RhysSullivan/executor/commit/dbb48ec99e923b15cc39fa5041887566f4a6d2d0) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Fix credential sharing for workspace connections**

  Org-shared connections now resolve for every member of a workspace, not only the member who created them. Existing connections are migrated automatically; stored secrets are unaffected.

- Updated dependencies []:
  - @executor-js/local@1.4.4
  - @executor-js/sdk@1.5.4
  - @executor-js/runtime-quickjs@1.5.4
  - @executor-js/api@1.4.26

## 1.5.3

### Patch Changes

- [#939](https://github.com/RhysSullivan/executor/pull/939) [`db09372`](https://github.com/RhysSullivan/executor/commit/db093728ad1752d25a577cd7f89b705a3915a2d2) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Desktop packaging follow-ups from the v1.5.2 release run:
  - Fixed the Intel mac desktop build failing in CI (the cross-target dependency install was being glob-expanded by the shell).
  - Fixed the first-launch data migration on Windows: renaming the previous database file could hit a transient `EBUSY` while the just-closed SQLite handle was released, so the move now retries briefly instead of failing startup.

- Updated dependencies []:
  - @executor-js/sdk@1.5.3
  - @executor-js/runtime-quickjs@1.5.3
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.25

## 1.5.2

### Patch Changes

- [#936](https://github.com/RhysSullivan/executor/pull/936) [`2db9d65`](https://github.com/RhysSullivan/executor/commit/2db9d65a828615c2ec0b209d54616dbf4264fefd) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Desktop**
  - Fixed the desktop app failing to launch: the packaged sidecar was missing its native SQLite and keychain bindings, so the local server exited before the window appeared. The release pipeline now smoke-tests the compiled sidecar before publishing.
  - Mac auto-updates now serve the correct architecture — the arm64 and x64 update manifests previously collided, so Apple Silicon machines could be offered Intel builds.
  - If the local server fails to start, the app now shows the error (with a pointer to the log) and installs any available update on quit, instead of closing silently.

  **Integrations & auth**
  - Integrations can declare multiple authentication methods in every plugin. MCP servers join the slugged template model used by OpenAPI and GraphQL, so a server can offer OAuth and an API key side by side, and adding a custom method appends instead of replacing a detected one. Existing connections keep working with no migration.
  - OAuth app management is folded into the connect modal, so client setup happens where accounts are added.

- Updated dependencies []:
  - @executor-js/sdk@1.5.2
  - @executor-js/runtime-quickjs@1.5.2
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.24

## 1.5.1

### Patch Changes

- [#927](https://github.com/RhysSullivan/executor/pull/927) [`df40cd3`](https://github.com/RhysSullivan/executor/commit/df40cd3716254daff0343ace7c2de7d46756d0f5) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Fix `executor web` crashing with `no such table: plugin_storage` when upgrading from an older v1 release. The v1 → v2 data migration now replays the bundled legacy schema migrations first, so databases last touched by any pre-1.5 version are brought up to the final v1 schema before their data is migrated.

- Updated dependencies []:
  - @executor-js/sdk@1.5.1
  - @executor-js/runtime-quickjs@1.5.1
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.23

## 1.5.0

### Minor Changes

- [`c7bb2a4`](https://github.com/RhysSullivan/executor/commit/c7bb2a4da99aac4199b424d6d52e6ea843250e3a) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Integrations and connections rework.

  **Highlights**
  - Sources are now split into integrations (the API surface) and connections (the credential). One integration can hold many connections — workspace-shared or personal — and each connection gets its own tool catalog.
  - Tool addresses carry the connection, so agents can target a specific account: `tools.vercel_api.org.workspace.deploy` vs `tools.vercel_api.user.personal.deploy`.
  - Existing data migrates automatically on first launch: sources become integrations, secrets and credential bindings become connections, OAuth apps and tool policies carry over, and the previous database is kept as a backup next to the new one.
  - Public no-auth servers (MCP, GraphQL) connect without entering a credential.
  - Connections display the signed-in identity, so you can tell accounts apart at a glance.
  - The CLI, local web app, and desktop app can connect to a shared Executor server instead of each running their own; the desktop app persists server profiles across restarts.
  - Self-hosted Executor now publishes a multi-architecture GHCR image at `ghcr.io/rhyssullivan/executor-selfhost` (stable releases tagged `latest`, prereleases tagged `beta`).

  **Reliability**
  - OpenAPI, GraphQL, and MCP tools return structured authentication failures with recovery guidance instead of opaque internal errors — covering missing credentials, expired OAuth connections, upstream 401/403 responses, and MCP per-user isolation.
  - OAuth popups complete more reliably in Chrome by preserving the callback channel through the same-origin completion page.
  - OAuth Dynamic Client Registration data is reused across retries and reconnects, including scopes, so providers are not asked to register duplicate clients.
  - Creating a connection with invalid input (no credential for a credentialed method, mixed input origins) returns a clear error with the reason instead of an opaque internal error.
  - The v1 → v2 migration creates connections for no-auth sources, derives OAuth authorize endpoints when v1 only stored a bare issuer origin, keys inline header values per source, and skips malformed credential bindings with a warning instead of silently dropping them. An unreachable OAuth metadata endpoint no longer blocks the migration on launch.
  - Google sources use a bundled OpenAPI flow with valid schemas.
  - MCP tool output schemas match the actual invocation result envelope, including `content`, `structuredContent`, `_meta`, and `isError`.
  - Integration icons survive migration, connected presets show their icons, and credentials show a loading badge while resolving.

  **Breaking changes**
  - Tool addresses gained two segments for the connection's owner and name: `tools.vercel_api.deploy` is now `tools.vercel_api.org.workspace.deploy`. Saved tool policies are rewritten automatically during migration; agent code that hard-codes v1.4 addresses needs the new shape (`tools.search()` returns ready-to-call paths).
  - The Google Discovery plugin was removed. Google integrations now go through the bundled Google flow; existing Google sources migrate automatically.

### Patch Changes

- [#922](https://github.com/RhysSullivan/executor/pull/922) [`1ba0193`](https://github.com/RhysSullivan/executor/commit/1ba01932919e6aee25a76c4c093841df8539adad) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Move `effect` from `dependencies` to `peerDependencies` in the published library packages so consumers provide a single shared Effect instance.

- Updated dependencies [[`7d7fbbd`](https://github.com/RhysSullivan/executor/commit/7d7fbbda9c0912e70334dcc809ec755ba3328f68), [`1ba0193`](https://github.com/RhysSullivan/executor/commit/1ba01932919e6aee25a76c4c093841df8539adad)]:
  - @executor-js/sdk@1.5.0
  - @executor-js/runtime-quickjs@1.5.0
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.22
