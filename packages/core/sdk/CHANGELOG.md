# @executor-js/sdk

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
