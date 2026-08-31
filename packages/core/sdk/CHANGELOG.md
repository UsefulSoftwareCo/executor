# @executor-js/sdk

## 1.6.7

### Patch Changes

- [#1867](https://github.com/UsefulSoftwareCo/executor/pull/1867) [`98d6c6a`](https://github.com/UsefulSoftwareCo/executor/commit/98d6c6ad3272fca371fc2d8b14b2e332100d8322) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Faster dynamic tool calls: independent storage reads run concurrently**

  Every dynamic tool call paid for its bookkeeping reads one at a time: first the tool row, then the active policy rules, then the connection row, and later the credential resolution followed by the integration row. Each read is a separate storage round-trip, so the serial chain added tens of milliseconds per call locally and more against a remote database. The reads are mutually independent, so they now run concurrently: the tool, policy, and connection reads overlap before approval, and credential resolution overlaps the integration read after approval. Approval enforcement still completes before credential resolution starts — a declined call never triggers a token refresh — and each read's failure still surfaces at the same point with the same error as before.

## 1.6.6

## 1.6.5

## 1.6.4

### Patch Changes

- [#1858](https://github.com/UsefulSoftwareCo/executor/pull/1858) [`ffcfbc0`](https://github.com/UsefulSoftwareCo/executor/commit/ffcfbc0de27d0ae55215839fb70395b0b7d9a65c) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Add locally installed OpenAI Codex plugins as one-click integrations: Messages
  (iMessage/SMS), Chrome, Computer Use, Computer History, and OpenAI Developer
  Docs. They appear in the connect dialog with their own icons, and a card that
  cannot run yet says what to install and links to it.

  Tool calls reach the plugins through `codex app-server` rather than a plugin's
  own MCP server, because their services only honour calls from a Codex host
  session. Computer Use and Chrome ship no MCP server at all, so their APIs are
  projected as typed tools — `list_apps`, `click`, `read_page`, `navigate` — that
  compile to a single call each. No model turn is involved; nothing is bundled or
  downloaded, and a machine without Codex simply sees the setup steps.

  A plugin's own approval prompt now reaches the caller, and states the terms it
  carries: a browser prompt that persists for a site says so. Approvals are asked
  once per session rather than per call.

  Elicitation requests can carry implementation-defined metadata through
  `FormElicitation` / `UrlElicitation`, and a paused execution reports it. Both
  fields are optional and additive.

- [#1346](https://github.com/UsefulSoftwareCo/executor/pull/1346) [`10e16a5`](https://github.com/UsefulSoftwareCo/executor/commit/10e16a5baa2648657b70038e7d11429c58e4d242) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Creating a connection over an existing one is rejected instead of silently overwriting it**

  `connections.create` used to upsert: a create with the same (owner, integration, name) replaced the saved connection and, for a pasted value, overwrote the stored secret itself. It now fails with the new `ConnectionAlreadyExistsError` and leaves the existing connection untouched. Remove the connection first, or pick a different name.

  This adds one error to the wire contract: the `POST /connections` endpoint can answer **HTTP 409** with tag `ConnectionAlreadyExistsError`, and the `connections.create` core tool resolves the same case as `{ ok: false, error: { code: "connection_already_exists" } }`. The core tool now also resolves the other expected input failures the same way instead of as opaque internal errors: `integration_not_found` for an unknown integration and `invalid_connection_input` for an invalid input. The change is additive — no existing status, field, or success shape moves.

  OAuth is unaffected. Fresh OAuth connects already resolve a taken name to the next free suffix through `newConnection`, and reconnect still re-mints the same connection on purpose.

- [#1708](https://github.com/UsefulSoftwareCo/executor/pull/1708) [`515d6aa`](https://github.com/UsefulSoftwareCo/executor/commit/515d6aa391a04a3579a7b10f974ec316a563cf7a) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Stale "unhealthy" verdicts no longer wait for a manual "Check now"**

  A connection's persisted health verdict was only ever re-checked from the web UI, so after one bad probe (a transient upstream error, a refresh that failed once) agents reading `connections.list` kept reporting "unhealthy, reconnect" for a connection that worked fine — invocation auto-refreshes OAuth tokens — until a human opened the page and clicked "Check now".

  Two repair paths make the verdict track reality on its own. The agent-facing `connections.list` now re-runs the same probe as "Check now" before reporting a non-healthy verdict older than a minute, so recovery shows on the next read while repeated lists collapse to one probe per window. And a successful tool invocation through a connection wearing a non-healthy verdict flips it back to healthy — real traffic is stronger evidence than any probe. Tool-sync failure verdicts and grants the authorization server has rejected as `invalid_grant` are deliberately left alone: the first is cleared only by a successful sync, and the second genuinely requires a reconnect. A call whose credential no longer resolves is left alone too — a rendered request omits the missing placement, so an upstream that answers unauthenticated proves nothing about a credential that is gone.

  `PluginCtx.connections` gains `checkHealth`, the same probe-with-freshness-window the executor surface already exposed.

- [#1818](https://github.com/UsefulSoftwareCo/executor/pull/1818) [`06bf742`](https://github.com/UsefulSoftwareCo/executor/commit/06bf74254f3432e8d75fd8b493ef7a435ea4bc84) Thanks [@ramarivera](https://github.com/ramarivera)! - **Rejected MCP OAuth grants now request reconnect without registering a disposable client**

  Remote MCP catalog discovery used the MCP SDK's interactive OAuth fallback when an upstream rejected Executor's stored bearer with `401`. A background refresh cannot finish that browser authorization, but the SDK first fetched OAuth metadata and dynamically registered another client. Executor then preserved the old catalog under a generic degraded health verdict, so clients saw zero or stale tools without a reliable reconnect signal.

  Executor now stops at the authenticated HTTP boundary for OAuth-backed MCP transports. A rejected stored bearer becomes a structured reauthorization result before OAuth discovery or Dynamic Client Registration runs. Catalog refresh still preserves the last authoritative tools, but records the connection as expired with a reconnect-required detail so the UI and API can direct the user through authorization again.

  API-key and unauthenticated MCP transports keep their existing `401` behavior, and ordinary incomplete discovery results remain degraded.

## 1.6.3

### Patch Changes

- [#1537](https://github.com/UsefulSoftwareCo/executor/pull/1537) [`c1f51b7`](https://github.com/UsefulSoftwareCo/executor/commit/c1f51b7f96328b795669bb3d241667660dc2b060) Thanks [@Rish-it](https://github.com/Rish-it)! - Share the OAuth refresh gate across execution stacks so a rotating refresh token is redeemed once.

  The in-flight refresh gate was built inside `createExecutor`, so it only covered one execution stack. A host builds a fresh stack per MCP session, and now per request, so two sessions resolving the same connection each read the same stored refresh token and each believed they were the refresh winner. Against a provider that rotates refresh tokens, the loser redeems a token the winner already spent, and a provider that detects reuse revokes the whole token family: the connection dies and the user has to reauthorize. The first refresh always succeeds, so the fault stayed invisible until a later expiry.

  The gate now hangs off the root database handle, which is the object hosts already share across sessions and requests, so every stack over one handle converges on one gate. Its key includes the tenant, because a gate that spans tenants would otherwise let two tenants collide on one entry.

  The grant also runs on its own detached fiber that callers await, rather than on whichever caller registered it. Sharing an entry across stacks would otherwise share the first caller's cancellation: a disconnected MCP client or an execution deadline would fail every peer waiting on that entry, and would abandon a refresh token the authorization server had already rotated, which is itself a dead connection. A cancelled peer now detaches without touching the grant, and a grant nobody is left waiting on still settles and still persists the rotated token.

  Deduplication covers one database handle in one process. A host that builds a fresh handle per request or per session, and any multi-instance or multi-replica deployment, is out of scope here and still needs database-backed coordination, such as a compare-and-swap on the stored refresh token.

- [#1098](https://github.com/UsefulSoftwareCo/executor/pull/1098) [`02b52cd`](https://github.com/UsefulSoftwareCo/executor/commit/02b52cd01b09d3601ffe88d1f9c0b777f26e76ae) Thanks [@aryasaatvik](https://github.com/aryasaatvik)! - Add a FumaDB bulk upsert query path and route plugin-storage bulk writes through
  it so existing rows are updated without delete/reinsert churn.
- Updated dependencies [[`02b52cd`](https://github.com/UsefulSoftwareCo/executor/commit/02b52cd01b09d3601ffe88d1f9c0b777f26e76ae)]:
  - @executor-js/fumadb@1.5.8

## 1.6.2

## 1.6.1

### Patch Changes

- [#1784](https://github.com/UsefulSoftwareCo/executor/pull/1784) [`55180cb`](https://github.com/UsefulSoftwareCo/executor/commit/55180cb1487f9a3a28ddc0ee0bedfab8464c1f72) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Build `StorageError.message` from the call-site label plus the driver's error code instead of the driver's raw text. The driver text is drizzle's `Failed query: <sql>\nparams: <bound values>`, so error reporting grouped one storage defect by statement shape and printed bound parameters into issue titles. The full driver error stays on `cause`.

  Add `StorageConnectionError`, a `StorageFailure` variant for postgres.js connection faults (`CONNECTION_ENDED`, `CONNECTION_CLOSED`, `CONNECTION_DESTROYED`, `CONNECT_TIMEOUT`, `ECONNREFUSED`, `ECONNRESET`) and workerd's cross-request I/O rejection. It carries the fault `code` and a `retryable` flag so a lost socket can be told apart from a pool-lifetime bug.

## 1.6.0

### Patch Changes

- [#1648](https://github.com/UsefulSoftwareCo/executor/pull/1648) [`a2d1417`](https://github.com/UsefulSoftwareCo/executor/commit/a2d141758e478274813c8c24d354e1fd0f66af49) Thanks [@baggiiiie](https://github.com/baggiiiie)! - Keep `connections.list` health output compact unless callers opt into diagnostics with `verbose: true`. Default list responses now retain only the health status, identity, and check timestamp; verbose responses continue to include HTTP status, diagnostic detail, and bounded upstream response samples.

## 1.5.42

### Patch Changes

- [#1626](https://github.com/UsefulSoftwareCo/executor/pull/1626) [`d3f0617`](https://github.com/UsefulSoftwareCo/executor/commit/d3f0617deec06c57e0d6e1479fe668f79daf977d) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Redact every span header attribute outside a safe allowlist on the hosted HTTP client. The tracer's default four-name blocklist let provider-specific credential headers reach the trace backend verbatim; the hosted client now inverts the model and masks everything except structurally safe negotiation, caching, and tracing headers.

## 1.5.41

### Patch Changes

- [#1580](https://github.com/UsefulSoftwareCo/executor/pull/1580) [`d572658`](https://github.com/UsefulSoftwareCo/executor/commit/d572658d74097917412256f10a3ea2e3974f44dd) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Fix: the admin joined user view no longer issues one connection query per subject**

  `admin.listSubjectsWithConnections` read a page of subjects and then queried
  connections once per subject, sequentially. A default page therefore cost 100
  round trips inside a single request, which on a per-request socket dominated
  the response. It now reads the page and then batches every subject's
  connections into one query, so the cost is two queries regardless of page size.
  A subject with no connections still reports an empty array rather than dropping
  out of the page, and the batched read carries the same `owner: "user"` and
  tenant scoping the per-subject read did.

  The `?email=` filter on the admin users endpoints is also applied before the
  read rather than after it: the address resolves to a principal id and that id is
  read directly, instead of paging the tenant and keeping the row that matched.
  Paging still applies to a filtered response, but to the selected row — one row
  at `offset: 0`, empty beyond it.

## 1.5.40

### Patch Changes

- [#1541](https://github.com/UsefulSoftwareCo/executor/pull/1541) [`8ba64f6`](https://github.com/UsefulSoftwareCo/executor/commit/8ba64f675f6d6ab5302d4f68390c0b055d006f4a) Thanks [@baggiiiie](https://github.com/baggiiiie)! - Fix a second OAuth connection for the same integration silently overwriting the first instead of being added. Connection names are now normalized consistently: `connectionIdentifier` is idempotent, and the OAuth start flow's free-name guard checks the same normalized name the mint stores, so connecting another account resolves to a distinct suffixed name (e.g. `myGmail2`) instead of re-minting the existing connection.

## 1.5.39

### Patch Changes

- [#1531](https://github.com/UsefulSoftwareCo/executor/pull/1531) [`6c316c7`](https://github.com/UsefulSoftwareCo/executor/commit/6c316c77a9efc98784976236852b58c6156e016e) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Revert the hosted outbound DNS guard resolution cache and the accompanying outbound guard changes released in 1.5.38. The guard returns to its previous behavior: no resolution cache, the caller's `redirect` mode is not honored, and `makeHostedHttp` is no longer exported — use `makeHostedFetch` and `makeHostedHttpClientLayer` as before.

## 1.5.38

### Patch Changes

- [#1524](https://github.com/UsefulSoftwareCo/executor/pull/1524) [`6a924dd`](https://github.com/UsefulSoftwareCo/executor/commit/6a924dd98de916d6ff8cea2329bf672f149b64f4) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Cache hosted outbound DNS guard resolutions, so a proxied request no longer pays a fresh lookup on every hop. `makeHostedHttp` builds the guarded fetch and the guarded HTTP client layer over one cache; building them separately still works but resolves each hostname twice.

  The outbound guard also honors the caller's `redirect` mode, which it previously ignored: `manual` now returns the unfollowed 3xx with its Location header, and `error` rejects, rather than both silently following the redirect. Redirect method semantics now match platform fetch — a `DELETE` or `PUT` meeting a 301/302, and a `HEAD` meeting a 303, keep their method instead of being rewritten to `GET`, so the request the caller made is the request that goes out. Exhausting the redirect budget rejects rather than handing back the raw 3xx as if it were a final response.

  Address classification is tightened too: the cloud metadata endpoint is now blocked by the address a hostname denotes rather than by one dotted-decimal spelling, so its IPv6 forms (`::ffff:169.254.169.254`, the 6to4 `2002:a9fe:a9fe::`, NAT64) are blocked under `allowLocalNetwork` as well, and a name that merely resolves to it is blocked in that mode too — the resolved-address check now runs whether or not the local network is allowed, with only the metadata rule applied to its answers when it is; IPv6 prefixes that carry an IPv4 destination (IPv4-translatable, 6to4, local-use NAT64) are classified by that destination; deprecated site-local addresses (`fec0::/10`) count as local; every address a hostname resolves to is checked rather than the first; subresource integrity survives a cross-origin redirect; and address forms the platform resolver reads differently from a decimal-only parser (octal octets, a dotted quad in the head of a compressed literal) no longer classify as public.

## 1.5.37

### Patch Changes

- [#1498](https://github.com/UsefulSoftwareCo/executor/pull/1498) [`657b913`](https://github.com/UsefulSoftwareCo/executor/commit/657b9135b8b841495b362936bf60bdca998c16eb) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Add anonymous product analytics to the local daemon (CLI + desktop) and self-host: execution counts split by MCP/API plane, toolkit usage, integration add/remove, and artifact usage (created/viewed/updated/deleted, attributed to agent tools vs the console UI), filed under a persisted per-install anonymous id. Opt out with DO_NOT_TRACK or EXECUTOR_DISABLE_ANALYTICS.

## 1.5.36

## 1.5.35

### Patch Changes

- [#1443](https://github.com/UsefulSoftwareCo/executor/pull/1443) [`1b9b1f1`](https://github.com/UsefulSoftwareCo/executor/commit/1b9b1f10313834a625a411169ebf83f6181589df) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Re-register a dynamically registered OAuth client when the configured callback URL changes instead of reusing the stale registration. DCR clients now persist the redirect URI they registered with the authorization server (`oauth_client.origin_redirect_uri`), and the per-issuer reuse lookup compares it against the current flow callback — a mismatch (for example after a sandbox recreation moved the callback origin) mints a fresh client rather than pairing the old registration with the new callback, which strict providers reject with `invalid_redirect_uri`. The stale client row is left in place so existing connections keep refreshing through it; clients persisted before this release have no stored redirect URI and continue to be reused as before.

## 1.5.34

### Patch Changes

- [#1422](https://github.com/UsefulSoftwareCo/executor/pull/1422) [`e2712db`](https://github.com/UsefulSoftwareCo/executor/commit/e2712dbff98145c5c340832ffbdcb21113b9dd78) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - A token refresh the authorization server definitively rejects (any RFC 6749 error code, not just `invalid_grant`) now surfaces to the sandbox as an `oauth_refresh_failed` auth failure carrying the server's error code and description, instead of being scrubbed to "Internal tool error". `invalid_grant` still classifies as `oauth_reauth_required`. Code-less failures (transport blips) keep retrying as before.

- [#1427](https://github.com/UsefulSoftwareCo/executor/pull/1427) [`7207347`](https://github.com/UsefulSoftwareCo/executor/commit/720734756a70b1b4f1564bdf82dc4118e5de2b76) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Apply persisted RFC 6902 overrides to OpenAPI specifications during preview, import, and refresh so upstream documents can be corrected without maintaining a fork. Figma imports automatically narrow OAuth to the scopes supported by its OAuth app configuration.

- [#1425](https://github.com/UsefulSoftwareCo/executor/pull/1425) [`0c4e9b4`](https://github.com/UsefulSoftwareCo/executor/commit/0c4e9b49fecb35ad71c92a464c3ea01131ff9d6f) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Preserve an integration's declared OAuth scopes when same-origin authorization-server metadata describes a different authorization or token endpoint.

## 1.5.33

## 1.5.32

## 1.5.31

## 1.5.30

## 1.5.29

## 1.5.28

### Patch Changes

- [#1246](https://github.com/UsefulSoftwareCo/executor/pull/1246) [`1c48182`](https://github.com/UsefulSoftwareCo/executor/commit/1c4818254e71dc4ee27ff95f489e2c5cf330a450) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Keep MCP tool catalogs in sync with the server's live tool set. Previously a
  connection's tools were listed once at create time and never updated unless the
  integration's config changed or a user clicked Refresh, so server-side tool
  changes silently broke invocations.
  - `tools/list` discovery now follows `nextCursor` pagination per the MCP spec,
    so servers with paginated catalogs list completely instead of first-page-only.
  - The client handles `notifications/tools/list_changed` received during a tool
    call and marks the connection's persisted catalog stale; the next tools read
    re-lists from the server.
  - An unknown-tool rejection from the server (protocol error or the reference
    SDK's error envelope) returns a typed `mcp_tool_unknown` failure telling the
    caller to re-list, and marks the catalog stale so it heals on the next read.
  - Remote catalogs now also refresh on read once older than a freshness TTL
    (`ExecutorConfig.toolsSyncTtlMs`, default 15 minutes, `null` to disable),
    covering servers that change tools without notifying.
  - A failed listing (server unreachable, auth not ready) no longer wipes the
    previously persisted catalog; it is kept and retried after the TTL.

## 1.5.27

## 1.5.26

## 1.5.25

## 1.5.24

## 1.5.23

## 1.5.22

## 1.5.21

## 1.5.20

## 1.5.19

## 1.5.18

## 1.5.17

## 1.5.16

## 1.5.15

### Patch Changes

- Surface binary tool results as model-native file outputs across OpenAPI and upstream MCP integrations.

## 1.5.14

## 1.5.13

## 1.5.12

## 1.5.11

## 1.5.10

## 1.5.9

## 1.5.8

## 1.5.7

### Patch Changes

- [#964](https://github.com/RhysSullivan/executor/pull/964) [`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Faster integrations with large API specs**

  Resolved OpenAPI spec text and GraphQL introspection snapshots are now stored content-addressed in the plugin blob store instead of inline in each integration's stored config. Listing integrations no longer loads multi-megabyte spec blobs it immediately discards, which makes the integrations surface dramatically faster for workspaces with large specs. Existing integrations keep working: rows that still inline a spec resolve unchanged and are rewritten in place the next time they are imported or refreshed.

- [#964](https://github.com/RhysSullivan/executor/pull/964) [`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Republish from committed source. Versions 1.5.5 and 1.5.6 of the library packages were published directly to npm to fix installs resolving the wrong `fumadb` dependency (the vendored database layer is now scoped as `@executor-js/fumadb`); that fix landed in the repo separately, and this release brings the recorded package versions back in line with npm.

- Updated dependencies [[`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15)]:
  - @executor-js/fumadb@1.5.7

## 1.5.4

## 1.5.3

## 1.5.2

## 1.5.1

## 1.5.0

### Patch Changes

- [#893](https://github.com/RhysSullivan/executor/pull/893) [`7d7fbbd`](https://github.com/RhysSullivan/executor/commit/7d7fbbda9c0912e70334dcc809ec755ba3328f68) Thanks [@dmmulroy](https://github.com/dmmulroy)! - Batch OpenAPI operation metadata writes through plugin storage so adding large built-in OpenAPI sources no longer performs thousands of sequential D1 operations.

- [#922](https://github.com/RhysSullivan/executor/pull/922) [`1ba0193`](https://github.com/RhysSullivan/executor/commit/1ba01932919e6aee25a76c4c093841df8539adad) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Move `effect` from `dependencies` to `peerDependencies` in the published library packages so consumers provide a single shared Effect instance.
