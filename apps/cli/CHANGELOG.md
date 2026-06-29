# executor

## 1.5.23

### Patch Changes

- [#1199](https://github.com/RhysSullivan/executor/pull/1199) [`29936d5`](https://github.com/RhysSullivan/executor/commit/29936d5981256f8f953797d9ce8ce073ac6a0b6a) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Add a test seam to skip the first-run "keep Executor running in the background?" consent dialog under automation, matching the existing `confirmResetState` seam. Set `EXECUTOR_TEST_AUTO_CONFIRM_BACKGROUND_SERVICE=1` to keep the background service or any other value to decline. When the variable is unset the dialog is shown exactly as before. Native dialogs cannot be answered from CDP or Playwright, so a packaged first-run boot under automation previously blocked at this prompt with no way to proceed.

- [#1199](https://github.com/RhysSullivan/executor/pull/1199) [`29936d5`](https://github.com/RhysSullivan/executor/commit/29936d5981256f8f953797d9ce8ce073ac6a0b6a) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Fix the desktop app failing to start its local server when the generated auth token begins with a dash. The token is `randomBytes(32).toString("base64url")`, which can start with "-", and the packaged app passed it to the bundled CLI as a separate argument (`--auth-token`, then the token). The CLI then read the leading-dash token as an unknown flag, printed its help, and exited, so the desktop showed a fatal "local Executor server crashed during startup" dialog. This was persistent (the token is saved) and cross-platform, affecting roughly 1 in 64 fresh installs. The token is now passed in the combined `--auth-token=<value>` form so a leading dash is treated as the value.

- [#1199](https://github.com/RhysSullivan/executor/pull/1199) [`29936d5`](https://github.com/RhysSullivan/executor/commit/29936d5981256f8f953797d9ce8ce073ac6a0b6a) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Notify when a newer Executor is published. The CLI now prints an "update available" line under its ready banner, and the web shell's sidebar update card works for real (a new `/v1/app/npm/dist-tags` endpoint backs it). In the desktop app the card shows a native "Restart to update" action wired to the in-app updater instead of the npm command. The check is best-effort and offline-safe, and can be disabled with `EXECUTOR_DISABLE_UPDATE_CHECK`.

- Updated dependencies [[`29936d5`](https://github.com/RhysSullivan/executor/commit/29936d5981256f8f953797d9ce8ce073ac6a0b6a), [`29936d5`](https://github.com/RhysSullivan/executor/commit/29936d5981256f8f953797d9ce8ce073ac6a0b6a)]:
  - @executor-js/api@1.4.43
  - @executor-js/local@1.4.4
  - @executor-js/sdk@1.5.23
  - @executor-js/runtime-quickjs@1.5.23

## 1.5.22

### Patch Changes

- [#1167](https://github.com/RhysSullivan/executor/pull/1167) [`add2e40`](https://github.com/RhysSullivan/executor/commit/add2e405fca8a5e20aea43d216bc8289c15e2187) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Fix the desktop app's main-area title-bar strip pushing page content down so page headers no longer lined up with the sidebar header. The drag strip now overlays the top of the main area (behind page content) instead of reserving its own row, and the Toolkits header uses a fixed title-bar height so its bottom border aligns with the sidebar header again.

- Updated dependencies []:
  - @executor-js/local@1.4.4
  - @executor-js/sdk@1.5.22
  - @executor-js/runtime-quickjs@1.5.22
  - @executor-js/api@1.4.42

## 1.5.21

### Patch Changes

- [#1134](https://github.com/RhysSullivan/executor/pull/1134) [`78aa871`](https://github.com/RhysSullivan/executor/commit/78aa8710d774d552d6030eca060c5e72f0899461) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Fix OAuth callbacks in cloud so they preserve the URL-selected organization when the session cookie points at another org.

- Updated dependencies []:
  - @executor-js/local@1.4.4
  - @executor-js/sdk@1.5.21
  - @executor-js/runtime-quickjs@1.5.21
  - @executor-js/api@1.4.41

## 1.5.20

### Patch Changes

- [#1132](https://github.com/RhysSullivan/executor/pull/1132) [`580fc7f`](https://github.com/RhysSullivan/executor/commit/580fc7f8b2615a0d7760b3a4daddf8d45673ef3f) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Fix the PostHog custom MCP OAuth setup flow so Add connection opens PostHog authorization instead of falling back to manual OAuth app registration.

- Updated dependencies []:
  - @executor-js/sdk@1.5.20
  - @executor-js/runtime-quickjs@1.5.20
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.40

## 1.5.19

### Patch Changes

- [#1115](https://github.com/RhysSullivan/executor/pull/1115) [`92bd86c`](https://github.com/RhysSullivan/executor/commit/92bd86cb975ce867b3002ae9bcb6bf60da67cc48) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Google media downloads (Drive file contents, exports, and other binary
  endpoints) are now returned as binary responses instead of being decoded as
  text, so files come back intact. Emit them with `emit(result.data)`.

- [#1115](https://github.com/RhysSullivan/executor/pull/1115) [`92bd86c`](https://github.com/RhysSullivan/executor/commit/92bd86cb975ce867b3002ae9bcb6bf60da67cc48) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - The CLI now validates that a URL is `http`/`https` before handing it to the
  operating system's browser opener, and on Windows opens it via
  `rundll32 url.dll,FileProtocolHandler` instead of `cmd /c start`. This removes a
  path where a crafted URL could be interpreted as a shell command. `executor
login` and the "open in browser" prompts behave the same for normal URLs.

- [#1115](https://github.com/RhysSullivan/executor/pull/1115) [`92bd86c`](https://github.com/RhysSullivan/executor/commit/92bd86cb975ce867b3002ae9bcb6bf60da67cc48) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Hardened the hosted egress guard. Outbound requests from OAuth token exchanges,
  MCP transports, and GraphQL/Google/Microsoft discovery now all route through the
  guard, and the guard resolves DNS before connecting so a hostname that points at
  a private or loopback address is blocked rather than only literal private IPs.
  This tightens SSRF protection for hosted and cloud execution.
- Updated dependencies []:
  - @executor-js/sdk@1.5.19
  - @executor-js/runtime-quickjs@1.5.19
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.39

## 1.5.18

### Patch Changes

- [#1093](https://github.com/RhysSullivan/executor/pull/1093) [`bc24d1a`](https://github.com/RhysSullivan/executor/commit/bc24d1a4924ed8b3f09d64c639b0fe7fe02ed53d) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - `connections.create` now accepts no-auth connections (the `none` template with
  no credential), which previously failed validation with "Expected exactly one
  provider credential origin". Agents can wire up public, no-auth integrations
  (public MCP servers, public REST APIs) programmatically instead of bouncing
  through the web UI. Templates that take a credential still require exactly one.

- [#1093](https://github.com/RhysSullivan/executor/pull/1093) [`bc24d1a`](https://github.com/RhysSullivan/executor/commit/bc24d1a4924ed8b3f09d64c639b0fe7fe02ed53d) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - OpenAPI tools that return a file now spell out how to emit it directly in the
  tool's description, so an agent sees the `emit(result.data)` contract before its
  first call instead of only discovering it after a failed attempt or by reading
  `describe.tool`. Non-file tools are unchanged.
- Updated dependencies []:
  - @executor-js/sdk@1.5.18
  - @executor-js/runtime-quickjs@1.5.18
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.38

## 1.5.17

### Patch Changes

- [#1076](https://github.com/RhysSullivan/executor/pull/1076) [`3e47752`](https://github.com/RhysSullivan/executor/commit/3e4775292d75e65fe3fa9ab4101360123b29e27c) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Add `executor login` (plus `logout` and `whoami`) for signing the CLI into a
  hosted or self-hosted Executor server using the OAuth 2.0 Device Authorization
  Grant (RFC 8628), instead of manually creating and pasting an API key. `login`
  prints a code and verification URL, opens the browser, and polls; afterwards the
  CLI authenticates with a bearer token. Works against both cloud (WorkOS) and
  self-host (Better Auth) servers.

- [#1076](https://github.com/RhysSullivan/executor/pull/1076) [`3e47752`](https://github.com/RhysSullivan/executor/commit/3e4775292d75e65fe3fa9ab4101360123b29e27c) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - `connections.list` now returns a lean summary by default, replacing the full
  `oauthScope` grant string (which can run to thousands of characters per
  connection) with an `oauthScopeCount`. Pass `verbose: true` to get the full
  grant back.

- [#1076](https://github.com/RhysSullivan/executor/pull/1076) [`3e47752`](https://github.com/RhysSullivan/executor/commit/3e4775292d75e65fe3fa9ab4101360123b29e27c) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - The execute result envelope now reports how many items a script sent to the user
  via `emit()`. A script that only emits (with no return value) is no longer
  indistinguishable from one that did nothing: the envelope includes an emitted
  count and a `(no return value; N items emitted to the user)` text preview.

- [#1076](https://github.com/RhysSullivan/executor/pull/1076) [`3e47752`](https://github.com/RhysSullivan/executor/commit/3e4775292d75e65fe3fa9ab4101360123b29e27c) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Fix OAuth connect for providers that issue authorization codes redeemable only
  at a region-specific token host. Executor now redeems the code at the region
  returned on the callback rather than the statically advertised token endpoint,
  so connecting these providers no longer fails at the token-exchange step.

- [#1076](https://github.com/RhysSullivan/executor/pull/1076) [`3e47752`](https://github.com/RhysSullivan/executor/commit/3e4775292d75e65fe3fa9ab4101360123b29e27c) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Send a default `executor` User-Agent on OpenAPI tool calls. Upstreams such as
  GitHub that reject requests without a User-Agent (HTTP 403) now succeed instead
  of surfacing the rejection as a credential error. A spec- or connection-provided
  User-Agent still takes precedence.
- Updated dependencies []:
  - @executor-js/sdk@1.5.17
  - @executor-js/runtime-quickjs@1.5.17
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.37

## 1.5.16

### Patch Changes

- [#1066](https://github.com/RhysSullivan/executor/pull/1066) [`0961773`](https://github.com/RhysSullivan/executor/commit/09617733310152bfa5ae9439b17bd6903cac611e) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Replace the code-mode output helpers with a single `emit(value)` primitive.
  `emit(...)` accepts plain values, `ToolFile` attachments, and MCP content blocks,
  while `return` remains reserved for ordinary structured data.
- Updated dependencies []:
  - @executor-js/sdk@1.5.16
  - @executor-js/runtime-quickjs@1.5.16
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.36

## 1.5.15

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.15
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.35
  - @executor-js/runtime-quickjs@1.5.15

## 1.5.14

### Patch Changes

- [#1051](https://github.com/RhysSullivan/executor/pull/1051) [`cfda0ac`](https://github.com/RhysSullivan/executor/commit/cfda0ac91248041ca178d77ea9bd7a698d9dd98e) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Fix desktop startup so a failed supervised-daemon replacement no longer leaves
  the app on a black window. The desktop now re-checks the daemon after install
  failures, falls back to a managed sidecar when the stale daemon disappears, and
  surfaces startup recovery instead of leaving a failed renderer visible.
- Updated dependencies []:
  - @executor-js/sdk@1.5.14
  - @executor-js/runtime-quickjs@1.5.14
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.34

## 1.5.13

### Patch Changes

- [#1046](https://github.com/RhysSullivan/executor/pull/1046) [`2de1804`](https://github.com/RhysSullivan/executor/commit/2de1804d81d3e9223cd80fa49df2763aa0ea06bb) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Windows installs now repair stale Executor service listeners and only report success after the background daemon publishes the sign-in manifest used by `executor web`. The desktop app also attaches to a reachable supervised daemon before trusting Windows PID probes, so it no longer starts a competing sidecar when the background service already owns the port.

- Updated dependencies []:
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.33
  - @executor-js/sdk@1.5.13
  - @executor-js/runtime-quickjs@1.5.13

## 1.5.12

### Patch Changes

- [#1021](https://github.com/RhysSullivan/executor/pull/1021) [`c8faad7`](https://github.com/RhysSullivan/executor/commit/c8faad7b6991e968811693feb78dc46879bb8cb8) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Self-hosted instances now detect their public URL automatically on common
  platforms, and origin handling is consistent across every host. When
  `EXECUTOR_WEB_BASE_URL` is not set, the server reads the origin a host injects
  (Railway, Render, Fly, Vercel, Netlify, Heroku, Azure, Cloudflare Pages) instead
  of defaulting to localhost — so a platform deploy works with zero configuration
  and no longer fails sign-in with "Invalid origin". When the origin still can't be
  determined, that error is replaced with a clear message telling you exactly which
  `EXECUTOR_WEB_BASE_URL` value to set, and a startup warning fires on any non-dev
  deploy that falls back to localhost. The MCP browser-approval link a self-host
  sends to clients now uses the pinned public URL (reachable behind a reverse
  proxy) rather than the server's internal address. These resolution rules now live
  in one shared helper used by every host.
- Updated dependencies []:
  - @executor-js/sdk@1.5.12
  - @executor-js/runtime-quickjs@1.5.12
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.32

## 1.5.11

### Patch Changes

- [#1002](https://github.com/RhysSullivan/executor/pull/1002) [`64b3544`](https://github.com/RhysSullivan/executor/commit/64b3544c297f122fb915ab281f2ac84c766ddcfd) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Fix the self-hosted "Connect an agent" MCP URL. The card printed an
  organization-scoped path (`<origin>/<organizationId>/mcp`) that the
  single-tenant self-host server didn't serve, so connecting an MCP client
  authorized successfully but then failed to reach the tools with an HTTP 404.
  The self-host server now accepts the organization-scoped path and routes it to
  its MCP endpoint.

- [#1002](https://github.com/RhysSullivan/executor/pull/1002) [`64b3544`](https://github.com/RhysSullivan/executor/commit/64b3544c297f122fb915ab281f2ac84c766ddcfd) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Self-hosted MCP connections now require explicit approval. When an MCP client
  connects, the browser stops on an approval screen showing the connecting
  client's name, what it can access, and that the grant is limited to the MCP
  server (not a web-app login, and it can't make other API calls on your behalf);
  a token is granted only after you Approve. Previously a signed-in user's client
  was authorized automatically with no prompt.

- [#1008](https://github.com/RhysSullivan/executor/pull/1008) [`7237bf2`](https://github.com/RhysSullivan/executor/commit/7237bf2a82c2bd435a3a07f7f24338a325d578f0) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Self-hosted instances no longer lose data on restart. Better Auth now shares
  the same libSQL connection as the rest of the instance instead of opening its
  own. Previously the two connections each managed their own write-ahead log on
  the shared database file, and the second one to open could orphan the first —
  so integrations, connections, and tools written after startup landed in a
  discarded log and disappeared on the next restart, while sign-in data survived.
  This is the "reconnected my account but it has zero tools" failure; a single
  shared connection removes the split entirely.
- Updated dependencies []:
  - @executor-js/sdk@1.5.11
  - @executor-js/runtime-quickjs@1.5.11
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.31

## 1.5.10

### Patch Changes

- [#995](https://github.com/RhysSullivan/executor/pull/995) [`0717067`](https://github.com/RhysSullivan/executor/commit/0717067da5f2a272d9786f66248ce045b46f17ed) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Self-hosted deployments now persist their data correctly across restarts.

- Updated dependencies []:
  - @executor-js/sdk@1.5.10
  - @executor-js/runtime-quickjs@1.5.10
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.30

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
