# executor

## 1.6.5

### Patch Changes

- [#1863](https://github.com/UsefulSoftwareCo/executor/pull/1863) [`00c2ab7`](https://github.com/UsefulSoftwareCo/executor/commit/00c2ab789eef94efd9c05d389870566bba7111c2) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Adding a Codex plugin no longer asks for anything. `CODEX_HOME` is a path the
  scanner already resolved, but it was passed on the channel that makes an
  environment variable a credential — so the integration declared it as one, and
  a person who reached the connect step was shown a masked field for a value
  they should never have to know.

  Stdio integrations can now carry non-secret environment as static
  configuration, separate from declared secrets. The Codex plugins use it: they
  declare no auth, and their connection is created for them.

- Updated dependencies []:
  - @executor-js/local@1.6.5
  - @executor-js/sdk@1.6.5
  - @executor-js/runtime-quickjs@1.6.5
  - @executor-js/api@1.4.68

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

- [#1477](https://github.com/UsefulSoftwareCo/executor/pull/1477) [`c0c7a0d`](https://github.com/UsefulSoftwareCo/executor/commit/c0c7a0db41623077ba8b7d09de5ef8ee8e6a99e3) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Stop exporting credential-bearing URLs in telemetry. Every query parameter
  value, URL fragment, and userinfo component is stripped from exported span
  URLs — no parameter name is trusted — on every exporter path: the cloud span
  processors, the self-host OTLP exporter, the browser client's OTLP exporter,
  and the forwarded browser trace batches. User-supplied MCP endpoints are
  sanitized before being stamped onto spans.

- [#1841](https://github.com/UsefulSoftwareCo/executor/pull/1841) [`d13151a`](https://github.com/UsefulSoftwareCo/executor/commit/d13151ac19453f11b40c7f49303a10854c66e464) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - 1Password: multiple named accounts. The provider now holds any number of named accounts — a work account next to a personal one, or a service-account token next to desktop-app biometrics — each scoping its own set of vaults. The settings card lists every account with independent edit and disconnect, existing single-account configs upgrade in place, and `op://` refs keep their vault-first addressing: a vault name that exists in more than one account is an explicit ambiguity error, never a silent pick.

- Updated dependencies [[`ffcfbc0`](https://github.com/UsefulSoftwareCo/executor/commit/ffcfbc0de27d0ae55215839fb70395b0b7d9a65c), [`10e16a5`](https://github.com/UsefulSoftwareCo/executor/commit/10e16a5baa2648657b70038e7d11429c58e4d242), [`515d6aa`](https://github.com/UsefulSoftwareCo/executor/commit/515d6aa391a04a3579a7b10f974ec316a563cf7a), [`06bf742`](https://github.com/UsefulSoftwareCo/executor/commit/06bf74254f3432e8d75fd8b493ef7a435ea4bc84)]:
  - @executor-js/sdk@1.6.4
  - @executor-js/local@1.6.4
  - @executor-js/api@1.4.67
  - @executor-js/runtime-quickjs@1.6.4

## 1.6.3

### Patch Changes

- [#1560](https://github.com/UsefulSoftwareCo/executor/pull/1560) [`8c20c33`](https://github.com/UsefulSoftwareCo/executor/commit/8c20c33817ad815b252c3d72290004905aedab10) Thanks [@Adityakk9031](https://github.com/Adityakk9031)! - **Stale tool catalogs refresh together instead of one after another, and self-host can set the freshness window**

  A tools read rebuilds every connection whose catalog has gone stale. Those rebuilds each dial their own upstream, but ran strictly one after another, so a host with several stale remote catalogs paid the sum of every server's latency on the read that tripped the TTL. The upstream listings now run concurrently, bounded so a large stale set cannot open an unbounded number of listings from one read.

  Only the listings overlap. Each rebuild's catalog write stays single-file, because a self-host database is one connection issuing raw `BEGIN`/`COMMIT` and a second transaction opened while one is live fails outright. A rebuild that fails now also logs a warning naming the connection and the reason, instead of disappearing: the read still succeeds on the stale-but-working catalog and the other connections still finish, but a permanently broken connection no longer re-fails silently on every read.

  Self-host also exposes the freshness window as `EXECUTOR_TOOLS_SYNC_TTL_MS`. Leave it unset for the 15-minute default, or set `off` (equivalently `null` or `false`, in any case) to disable time-based re-sync and leave stale-marking and config revision as the only refresh triggers. The value forwards to the SDK verbatim, so `0` keeps its SDK meaning: every catalog is expired on every read. A malformed, negative, or too-large-to-represent value is refused at boot rather than silently falling back to the default.

- [#1572](https://github.com/UsefulSoftwareCo/executor/pull/1572) [`27cb466`](https://github.com/UsefulSoftwareCo/executor/commit/27cb4664282308e86fdb43218b42fe457d22e782) Thanks [@GeiserX](https://github.com/GeiserX)! - **Irreversible cleanup now waits for the transaction to commit, and plugins can do the same**

  `oauth.removeClient` deleted the client row and then deleted the client secret from the credential provider. The provider does not enlist in the caller's transaction and does not roll back with it, so an abort restored the client row while its secret stayed destroyed — a client that looks configured and can never authenticate again. The deletion now waits until the removal is durable and is discarded if the removal rolls back. With no transaction active it runs immediately, exactly as before.

  Deferring the deletion is not enough on its own. The secret is stored under a key derived from the app's `(owner, slug)` identity alone, so the key outlives the row it belonged to: whoever holds that identity when the deletion finally runs owns the key. A slug registered again before the removal committed would lose the new app's secret to the old app's queued deletion — the same unauthenticatable client, reached the other way round. The deferred deletion now re-checks that the app is still gone and stands down when it is not. A removal that matched no row also no longer queues a deletion at all: it removed nothing, so it has no claim on the key, which may well hold another subject's live secret.

  The same trap was reachable by plugins and they had no way out of it. `removeConnection` and `removeIntegration` run inside core's removal transaction — deliberately, so a plugin's own rows die atomically with the connection — which makes them exactly the wrong place to revoke a token at the provider's API, delete a remote object, or notify a third party. Nothing in the hooks' documentation said so, and `PluginCtx` exposed `transaction` but nothing to defer past it.

  `PluginCtx` gains `afterCommit`. It runs the effect once the outermost transaction commits, discards it if that transaction rolls back, and runs it immediately when no transaction is active. The lifecycle hooks now document that they run inside core's transaction and that outside-world work belongs in `afterCommit`.

  Sequencing work after your own `transaction(...)` call is not equivalent, and the documentation says so explicitly: `transaction` nests by pass-through, so inside an active transaction the inner call simply runs its effect and "afterwards" is still before any commit.

- [#1569](https://github.com/UsefulSoftwareCo/executor/pull/1569) [`d874455`](https://github.com/UsefulSoftwareCo/executor/commit/d874455c5d5ea83a69e2010152aeb703d74f51c2) Thanks [@GeiserX](https://github.com/GeiserX)! - **Abandoned authorization sessions no longer keep their PKCE verifier forever**

  An OAuth authorization session stores its PKCE verifier so the callback can redeem the code. `complete` discarded an expired session lazily, but an _abandoned_ flow is never completed, so that check never ran for it and nothing else swept the table — the verifier sat there in plaintext indefinitely.

  Starting a new authorization now sweeps sessions that have already expired. Doing it on `start` bounds the table by how often authorization is begun rather than by how often it is abandoned, and needs no scheduler in any host. A session whose completion cannot be retried is dropped rather than left behind.

  The sweep only ever reaches rows the caller can already see, so one member's authorization never touches another member's sessions. It is best-effort: a sweep that fails logs a warning and lets the authorization continue.

- [#1825](https://github.com/UsefulSoftwareCo/executor/pull/1825) [`06a7b75`](https://github.com/UsefulSoftwareCo/executor/commit/06a7b75fb62ac1c3eb22e28154fc250cd32a3ccb) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **A console URL naming an organization you cannot see is a not-found page, every time**

  Opening `/<some-other-slug>/policies` sometimes rendered the full authenticated console — sidebar, org switcher showing your OWN organization, page chrome — under an address naming an organization you are not a member of. The page body was a failing org-scoped query with a Retry button, so the workspace on screen belonged to nobody and the URL belonged to someone else.

  The shell's not-found only fired once `/account/me` had answered for the URL's slug. Until then the console read its identity from the auth-hint cookie, which always names the organization the session last landed in, never the one in the address bar. So the first paint answered a question about a different organization and built a whole workspace out of it, and whether you ever saw that depended on how fast the server replied.

  The shell is now built only from an answer that names the organization the URL names. A slug the current answer does not cover renders nothing at all until `/account/me` resolves for that slug, and then either the workspace or — for an organization this session cannot see — the not-found page. The URL is never rewritten: a wrong address stays a wrong address.

  The ordinary cold load is untouched. The hint names the slug already in the URL, so it matches on the very first paint and the shell renders with no round trip. Only a slug the hint does not name waits: a foreign one, and the single frame after switching organizations, which now paints the organization the URL asked for instead of briefly showing the previous one.

- [#1575](https://github.com/UsefulSoftwareCo/executor/pull/1575) [`e5526f3`](https://github.com/UsefulSoftwareCo/executor/commit/e5526f32b355e56aabe20024bc2f96296bfa982d) Thanks [@GeiserX](https://github.com/GeiserX)! - **GraphQL introspection no longer logs a credential carried in the endpoint URL**

  `query` is a supported credential carrier, so a GraphQL endpoint can be reached with `?token=<secret>`. Introspection built its request from a URL **string**, and `HttpClientRequest.setUrl` keeps a string verbatim as `request.url`. Every `HttpClientError` renders `${method} ${request.url}` into its `message` getter, and introspection logs the raw failure cause — so on any transport failure or non-JSON response, the connection's secret was written to the process log.

  The request is now built from a URL **object**, which moves the query into `request.urlParams` and clears it from `request.url`. The secret is therefore absent from the error message, and from anything else that renders the request URL. The credential still reaches the upstream: the client recombines url and urlParams when it executes the request. The endpoint's own query string is handled the same way, not just the separately-supplied query parameters, since a configured endpoint can carry a credential too.

  **The query string is now normalized on the wire.** Recombination appends each pair through `URLSearchParams`, so the query is re-serialized in form-urlencoded form instead of passed through byte-for-byte:
  - a space written as `%20` is sent as `+`
  - `~` and `!'()` are percent-encoded
  - a valueless `?flag` is sent as `flag=`

  Key order, repeated keys, and already-encoded reserved characters are unchanged, and every parameter still decodes to the same value. This is not avoidable while the fix holds: raw query bytes only survive inside `request.url`, which is the one field every error message renders, so byte-transparency and keeping the credential out of the log cannot both hold. An upstream that signs its raw query string is the case to watch. The exact resulting URLs are pinned by test.

  Two endpoints are now rejected up front with an `invalid-endpoint` failure rather than dialed:
  - an endpoint that is not a valid URL, which cannot be split this way and would otherwise be sent without the query parameters it was asked to include
  - an endpoint carrying userinfo (`https://user:pass@host/…`), which `URL` keeps in the origin, so it would stay in `request.url` and leak into error messages exactly the way a query-carried secret used to

  Neither rejection echoes any part of the endpoint. A health check on such an integration now reports the invalid configuration and points the operator at the endpoint URL, instead of blaming the credential that was never sent.

- [#1596](https://github.com/UsefulSoftwareCo/executor/pull/1596) [`b77ee69`](https://github.com/UsefulSoftwareCo/executor/commit/b77ee69aeeb90e40a2902c4d849e89d2343d91de) Thanks [@GeiserX](https://github.com/GeiserX)! - **Credentials are kept out of the health-check result that gets persisted**

  A health check stores a sample of the probed operation's response body, plus the extracted identity, in `connection.last_health` — so whatever those carry is written to the database. The operation is user-chosen from the plugin's catalog, which means it can just as easily be a key-listing endpoint as a `/me`, and those return secrets that no scrub of the connection's own credential value can recognise, because they are different secrets entirely.

  Two passes now cover both kinds of secret:
  - **By key name.** Leaves whose key names a credential (`token`, `api_key`, `secret`, `authorization`, `session`, …) have their value replaced with `[redacted]`. The row itself is kept, so the live preview still shows the response shape and the identity picker still works. Keys that merely contain a matching substring, such as `author`, are left alone. camelCase spellings are recognised too: `accessToken`, `refreshToken`, `clientSecret`, `privateKey` and `sessionId` have no separator before the credential word, so a matcher that only looks for one reads them as innocent.
  - **By value.** The OpenAPI health check removes the connection's own credential value from each sampled value, covering the other direction: a body that echoes back the key it was authenticated with under an innocent-looking name. This runs before the sample's 120-char truncation, not after — truncating first leaves a prefix of a long credential that an exact-value scrub can no longer match, and that prefix is what would be persisted.

  The key check reads a dotted path two ways. It uses the nearest NAMED segment, because array elements are named by index: `{"tokens": ["sk-live-…"]}` produces the path `tokens.0`, and testing the literal `"0"` matches nothing. It also uses an enclosing array container, because a key listing returns `{"api_keys": [{"value": "sk-live-…"}]}`, whose path is `api_keys.0.value` — the nearest named segment there is the innocent `value`, and only the array's own key says what the collection holds. A collection whose key names nothing, such as `names.0`, is still shown in full.

  The extracted `identity` goes through both passes as well. It is read straight off the raw body, so it previously bypassed them even though it is persisted the same way, and `identityField` is user-chosen from whatever the picker listed.

- [#1823](https://github.com/UsefulSoftwareCo/executor/pull/1823) [`d74865f`](https://github.com/UsefulSoftwareCo/executor/commit/d74865ff8cb7c4ada1badac512169beafe925cf8) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Saved integrations come back after an upgrade left an OAuth expiry in the old number format**

  Some installs lost every saved integration from the MCP gateway at once. The credentials were never deleted — the gateway simply could not read the table they live in, so it served an empty tool list and restarting did not help.

  The `connection.expires_at` column records when an OAuth access token expires. It used to be a plain number; it now holds the value's digits, because a millisecond timestamp is larger than a 32-bit integer. SQLite does not rewrite rows when a column's type changes, so a connection saved by an older build still held the old form. Reading one back failed, and because the failure happened while mapping the row, it failed the whole query rather than that one field — one stale row was enough to hide every integration.

  A boot-time migration now converts those values to the current form. It runs before anything reads the table, so the integrations are back on the first restart after upgrading. It only touches values still in the old numeric form: rows already written by a current build are left exactly as they are, and it runs once.

- [#1607](https://github.com/UsefulSoftwareCo/executor/pull/1607) [`75c917f`](https://github.com/UsefulSoftwareCo/executor/commit/75c917fdb0cb8499678f842c62133483472b4814) Thanks [@timkley](https://github.com/timkley)! - **Fix: allow MCP integrations to declare OAuth scopes when resource metadata omits them**

  MCP OAuth methods can now carry an optional non-empty scope list. Declared scopes
  take precedence over protected-resource scope discovery, so servers with fixed
  scopes can connect even when their dynamically registered OAuth client has no
  resource identifier. Existing integrations without declared scopes keep
  discovering them from the server at connect time.

- [#1577](https://github.com/UsefulSoftwareCo/executor/pull/1577) [`4879d47`](https://github.com/UsefulSoftwareCo/executor/commit/4879d47bd7bc0d80440fe0438ce0e4b36b19a2d2) Thanks [@GeiserX](https://github.com/GeiserX)! - **Idle MCP connections age out on the pool's next acquire, even when their identity is never dialled again**

  The pool's five-minute idle window was only consulted against the entry being requested, so an identity that was never asked for a second time was never examined a second time. Its session stayed open and authenticated for as long as the pool lived, holding the bearer token or API key it was dialled with. The advertised bound applied only to connections that happened to be reused.

  `acquire` now sweeps every entry past the window, closing each one, rather than just the entry matching the key. This stays lazy in the sense the pool intends — activity drives it, there is no timer and no background fiber — and the map holds at most one entry per identity, so the scan is trivial.

  Because the sweep is paid for by whichever invocation acquires next, it cannot be allowed to stall that caller. The expired entries leave the pool synchronously, before any close is awaited, and the closes then run concurrently with each one bounded by a two-second timeout — so a server that accepts a close and goes quiet is abandoned rather than waited on, and cannot hold up an unrelated request or the connections queued behind it.

  Reuse is unchanged: an entry still inside the window is left alone, and a second call for the same identity still gets the parked session rather than a fresh dial.

- [#1821](https://github.com/UsefulSoftwareCo/executor/pull/1821) [`435c0f2`](https://github.com/UsefulSoftwareCo/executor/commit/435c0f2d36ee891158a4e5cec35024cf439af6fe) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Fix: add remote MCP servers that sit behind an authenticating proxy**

  The add-MCP form now carries an optional request headers editor. The name/value
  pairs are sent on the connection check and on every later request, so an
  endpoint gated by an edge authenticator — a Cloudflare Access service token,
  for example — can be discovered and added.

  A `403` from such a gate is also no longer read as an unreachable server. It is
  classified the same way a `401` is: the endpoint needs credentials, so the add
  flow continues to the auth step instead of stopping on "Couldn't reach this
  URL".

- [#1775](https://github.com/UsefulSoftwareCo/executor/pull/1775) [`ecb87de`](https://github.com/UsefulSoftwareCo/executor/commit/ecb87debfcaa6676062cc09b8c847fde330f6337) Thanks [@The-AarushiSingh](https://github.com/The-AarushiSingh)! - **Stdio MCP integrations can be edited from the UI**

  The integration Edit sheet showed stdio servers as read-only text and told you
  to remove and recreate the integration to change its command. Fixing a typo in
  an argument, moving a server to a new path, or adding a static environment
  variable meant editing `executor.jsonc` by hand, or losing the integration's
  connections and tool policies to a delete-and-re-add.

  The sheet now edits the command, its arguments, the working directory, and the
  declared environment map, staged and applied by the sheet's own Save like the
  remote editor beside it. Arguments use the same quote-aware parsing as the add
  flow, so an argument containing spaces survives a round trip.

  The environment field edits the DECLARED static variables only. A stdio server
  receives those plus a small fixed base set — it does not inherit executor's
  environment — and secret values still belong to the connection, entered per
  account against the server's declared `stdio_env` method.

  Saving revises the integration config, which is already enough to rebuild the
  tool catalog: connections whose catalog predates the revision re-list on their
  next read, so an edited command's tools are correct without an explicit
  refresh.

- [#1402](https://github.com/UsefulSoftwareCo/executor/pull/1402) [`742a144`](https://github.com/UsefulSoftwareCo/executor/commit/742a144f169e24d5e0c082bfebb4334106267962) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **A disabled upstream API now reports `misconfigured` instead of `expired`**

  A 403 caused by the provider disabling the API (Google SERVICE_DISABLED / accessNotConfigured shapes) is a configuration problem, not a credential problem — reconnecting cannot fix it. Health checks now classify it as a fifth status, `misconfigured`, shown with an amber badge and a link to the provider console instead of a Reconnect prompt. Ordinary 401/403 credential rejections still report `expired`.

- [#1377](https://github.com/UsefulSoftwareCo/executor/pull/1377) [`98615b4`](https://github.com/UsefulSoftwareCo/executor/commit/98615b4bd6ee8b18bc63a304fe215c76332e108f) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **A credential-store outage no longer costs an OAuth connection its grant**

  Refreshing an OAuth token spends the stored refresh token: the authorization server rotates it, so the copy we sent stops working the moment the grant succeeds and the rotated one is the only thing that can mint again. Persisting the rotated token first bounds what a partial write can lose, but it cannot help when the store is refusing writes outright — the grant has already run, there is nowhere to put the successor, and every later refresh replays a token the server has revoked. The connection then reports `invalid_grant` and demands a re-auth over what was only a storage blip.

  The refresh is now gated on a store that is proven writable. Before the grant runs, it writes a fixed value to an item of its own that holds no credential and sits in the same partition as the connection's tokens. A store that cannot take that write fails the resolve while the stored refresh token is still valid, so the connection recovers on its own once the store does.

  The probe deliberately does not test the store by rewriting the refresh token with the value it just read. That is a read-then-write with no compare-and-set, and two instances refreshing one connection would lose the newer token to it: one reads the stored token, the other spends that same token and stores its rotated replacement, and the first then writes the spent one back over the replacement. The connection would die exactly the way the gate is meant to prevent.

  The probe also removes a write rather than adding one in the common case. Authorization servers that do not rotate hand back the same refresh token, and that value is no longer re-persisted when it has not changed — a rotated token never matches, so the write that matters still happens.

- [#1822](https://github.com/UsefulSoftwareCo/executor/pull/1822) [`d7e4b73`](https://github.com/UsefulSoftwareCo/executor/commit/d7e4b73a86b8e413af70e0fcb26f38a35a3f4546) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **An OAuth app can now be registered without an RFC 8707 resource, and that absence holds on every request**

  Microsoft Entra v2 rejects any authorization request that carries both a v2 `scope` (such as `https://api.fabric.microsoft.com/.default`) and the RFC 8707 `resource` parameter, failing with `AADSTS9010010` before the consent screen. Executor made that unavoidable for MCP servers behind Entra: registering an app for an MCP integration always derived the MCP endpoint as the resource, the form had no field to change it, and so every request carried the parameter Entra rejects.

  The register/edit OAuth app form now shows the resource indicator. It is still prefilled for MCP servers — nothing changes for providers that accept the parameter — but it can be cleared, and a cleared value persists as "no resource". A resource-less app then omits `resource` on all four grants alike: the authorization request, the code exchange, token refresh, and client-credentials. Symmetry matters here — sending `resource` on authorize but not on the token request (or the reverse) would bind the two tokens to different audiences.

  Two adjacent gaps closed with it:
  - MCP scope discovery no longer depends on the app's resource. It now falls back to the integration's own discovery URL (the MCP endpoint), so clearing the resource does not break connecting.
  - Token refresh for a first-party OAuth app dropped the app's configured resource, refreshing to a different audience than the original grant. It now sends the same resource the authorization request sent.

  Apps that keep their resource — the default for every discovered MCP server — behave exactly as before: the parameter is sent on every grant, as the MCP authorization spec expects.

- [#1567](https://github.com/UsefulSoftwareCo/executor/pull/1567) [`6225d5e`](https://github.com/UsefulSoftwareCo/executor/commit/6225d5ede05b23f552211ad0a99267f4b94fcaf6) Thanks [@GeiserX](https://github.com/GeiserX)! - **Keep token material out of OAuth token-endpoint error messages**

  A token-endpoint failure renders a preview of the upstream body into its
  message, and that message is persisted onto connection health, returned to the
  caller, and carried into telemetry. On a malformed HTTP 200 the body being
  previewed is a _successful_ token response, so an access token and a refresh
  token could be rendered into it.

  The preview is now built from an allowlist of fields that are safe to show
  (`error`, `errors`, `error_description`, `error_uri`, plus `code`, `message`,
  and `detail` nested inside them) instead of a denylist of fields to hide. A
  field nobody anticipated is omitted by default rather than printed by default.
  Keys stay visible and only non-allowlisted string values are replaced, so an
  operator can still read the shape of what the server sent. `code` is readable
  only when nested, because at the top level of a token response it is the RFC
  6749 authorization code.

  Form-encoded bodies take the same allowlist, the walk over a body is
  depth-bounded, and the failure summary records the token endpoint's hostname
  rather than its full URL, which can carry identifiers in its path.

  On that same malformed-200 path the failure no longer keeps the underlying
  rejection as its `cause`. That rejection carries the parsed token response, so
  keeping it put the raw tokens back into anything that renders the whole failure
  rather than only its message. Everything the path needs from the body — the
  status, the error code, the redacted preview — is read before the failure is
  built. A transport failure still keeps its cause, which is what tells a DNS miss
  apart from a refused connection.

  No public API changes. The dead-grant classification added for HTTP 200 refresh
  refusals is unaffected: it reads the HTTP status, not the rendered preview.

- [#1829](https://github.com/UsefulSoftwareCo/executor/pull/1829) [`369fa0a`](https://github.com/UsefulSoftwareCo/executor/commit/369fa0a32d5800c8333d2be00610c89f5feeb9ae) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **The 1Password provider can now be scoped to several vaults, with explicit per-vault addressing**

  The provider previously bound exactly one vault. The configuration now holds a set of vaults selected with checkboxes, and every reference is explicit about which vault it means: the item picker is a searchable list that shows each item's vault and stores a vault-qualified `op://` reference, so identically-titled items in different vaults can never collide. A bare item name is accepted only when it matches exactly one item across the selected vaults — a name that exists in more than one place fails with an error naming the matching vaults instead of silently picking one.

  Reopening the vault or item pickers no longer flashes a loading state: listings are retained and re-validated in the background, so the last-known list renders instantly.

  Configurations saved before this change keep working: the stored single-vault shape is read as a one-vault list and upgrades to the new shape the next time it is saved. The `status` tool reports `vaultNames` for all configured vaults and flags any configured vault the account can no longer see. Provider entries also gained an optional `group` label, which pickers use to show where an item lives.

- [#1772](https://github.com/UsefulSoftwareCo/executor/pull/1772) [`597ce90`](https://github.com/UsefulSoftwareCo/executor/commit/597ce90b30b96d2dd333a6c34e5f2cd0ee4c7d42) Thanks [@baggiiiie](https://github.com/baggiiiie)! - Persist the Connect-an-agent card's transport, artifact, integration-search, and approval preferences in the browser so its generated MCP install command remains stable across page reloads.

- [#1529](https://github.com/UsefulSoftwareCo/executor/pull/1529) [`0004ea3`](https://github.com/UsefulSoftwareCo/executor/commit/0004ea353411c9806273698e42d95ab45e0ba2f9) Thanks [@jadch](https://github.com/jadch)! - Keep Last-Event-ID recovery scoped to its originating MCP stream.

- [#1441](https://github.com/UsefulSoftwareCo/executor/pull/1441) [`a9bf623`](https://github.com/UsefulSoftwareCo/executor/commit/a9bf623dd4de359ca1d87275973b6ddf8b4f0ea6) Thanks [@salmonumbrella](https://github.com/salmonumbrella)! - Self-hosted instances can now allow additional browser origins without changing
  their canonical public URL. Set `EXECUTOR_TRUSTED_ORIGINS` to a comma-separated
  list of exact HTTP or HTTPS origins when one instance is intentionally reachable
  through multiple hostnames or addresses. OAuth callbacks, MCP metadata, approval
  links, and other generated URLs remain pinned to `EXECUTOR_WEB_BASE_URL`, and
  origins are never inferred from request headers.

- [#1720](https://github.com/UsefulSoftwareCo/executor/pull/1720) [`2da4953`](https://github.com/UsefulSoftwareCo/executor/commit/2da49535562e27291a1544f10e12b079b41f0362) Thanks [@Zeko369](https://github.com/Zeko369)! - **Connect an integration from the sidebar**

  The sidebar lists your integrations on every console route, but connecting
  another one meant navigating back to the integrations page to reach its Connect
  action — the picker state was owned by that page, so the shared shell could
  render the list without being able to open the flow behind it.

  The connect dialog now belongs to the shell. A labelled plus button sits beside
  the sidebar's Integrations heading and opens the same picker, records the same
  event, and leaves the current route in place behind it. On mobile the navigation
  drawer closes first so the dialog gets the full viewport.

- [#1824](https://github.com/UsefulSoftwareCo/executor/pull/1824) [`97ff388`](https://github.com/UsefulSoftwareCo/executor/commit/97ff38856c1618cfe8b6dc4394d3761d70b076b6) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Tools reads stop waiting on slow upstream servers**

  A tools read rebuilds every connection whose catalog has gone stale before answering. The rebuilds already ran concurrently, but the read still waited for all of them, so one slow or unreachable MCP server gated every catalog read behind its network timeout — a tools listing could take tens of seconds while healthy connections sat ready.

  A read now waits at most a short grace budget (2 seconds by default) for the rebuilds, then answers from the persisted catalog. The rebuilds keep running after the read returns and land on a later read, so the catalog still converges — it just no longer holds the reader hostage while it does. Overlapping reads share one in-flight rebuild per connection instead of stacking new ones.

  The budget is `toolsSyncGraceMs` on the SDK config. Pass `null` to restore the strict behavior, where a read blocks until every rebuild finishes and always reflects a fully converged catalog.

- [#1819](https://github.com/UsefulSoftwareCo/executor/pull/1819) [`1cd81d6`](https://github.com/UsefulSoftwareCo/executor/commit/1cd81d62cefa6fb8cfa2e21f2c0adbaedee60041) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Fix: stop the update check from claiming a newer version is available on builds it cannot compare**

  A build stamped with the placeholder 0.0.0 version always compared as older
  than the latest release, and a prerelease on a channel with no matching
  dist-tag (rc, alpha, and similar) always lost the comparison too. Both cases
  now short-circuit to "no update available" before the check reaches the
  registry.

  This applies wherever the update check runs, so the CLI check and the sidebar
  update card both stop showing an update prompt that a user could never act on.

- Updated dependencies [[`1908dd6`](https://github.com/UsefulSoftwareCo/executor/commit/1908dd6d7611489362d451f7594adca542c13ba1), [`c1f51b7`](https://github.com/UsefulSoftwareCo/executor/commit/c1f51b7f96328b795669bb3d241667660dc2b060), [`02b52cd`](https://github.com/UsefulSoftwareCo/executor/commit/02b52cd01b09d3601ffe88d1f9c0b777f26e76ae)]:
  - @executor-js/local@1.6.3
  - @executor-js/sdk@1.6.3
  - @executor-js/api@1.4.66
  - @executor-js/runtime-quickjs@1.6.3

## 1.6.2

### Patch Changes

- [#1802](https://github.com/UsefulSoftwareCo/executor/pull/1802) [`2afb6e8`](https://github.com/UsefulSoftwareCo/executor/commit/2afb6e86ddf081afb8a246d76291a7ae668e05f4) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Concurrent API requests no longer share one database provider build**

  Every HTTP request gets its own database connection, opened when the request fiber's scope opens and closed when it closes. The middleware that builds a request's execution stack, however, captures the boot fiber's context once at layer-construction time and re-applies it to every request. A captured context carries Effect's current memoization map, and re-applying it replaced the fresh per-request map with the boot one — which every in-flight request in the isolate shares.

  The per-request stack build then memoized itself there. Sequential requests still rebuilt, because the memo entry is released once the request that built it finishes, so the problem was confined to requests that overlap: the second request reused the first one's stack build, and with it the first one's database connection. A request could therefore issue queries on a connection it did not own, and lose that connection mid-flight when the owner finished and closed it — typically surfacing as a failed read after a slow outbound call, on a request that had already read successfully.

  The stack is now built with a request-local memoization scope, so overlapping requests each build their own stack over their own connection. The captured context still carries the long-lived services it exists to carry. The two other per-request provider builds that ran under a captured context — the account provider and the admin-users provider — are built the same way, for the same reason.

- [#1807](https://github.com/UsefulSoftwareCo/executor/pull/1807) [`78311a1`](https://github.com/UsefulSoftwareCo/executor/commit/78311a1ce506705a2420239fd96823203a9a1374) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Desktop: restore the macOS signing entitlements and app icon that were accidentally removed from the build inputs, and fail fast at PR time and before publishing when any configured build resource is missing. The v1.6.1 desktop build could not be signed; this release supersedes it.

- Updated dependencies []:
  - @executor-js/sdk@1.6.2
  - @executor-js/runtime-quickjs@1.6.2
  - @executor-js/local@1.6.2
  - @executor-js/api@1.4.65

## 1.6.1

### Patch Changes

- [#1576](https://github.com/UsefulSoftwareCo/executor/pull/1576) [`6535a74`](https://github.com/UsefulSoftwareCo/executor/commit/6535a74de4860e376e5a2e273cb2d5a662f98c5c) Thanks [@GeiserX](https://github.com/GeiserX)! - **The CLI's server-connection store is written owner-only, and two of its tests now actually run**

  `~/.executor/server-connections.json` holds live credentials for a hosted server — a bearer token, or an OAuth access token together with its long-lived refresh token, rewritten on every silent refresh. It was created with no explicit mode, so the process umask applied and it landed world-readable (0644 by default). Any other account on the machine — or anything that copies a home directory, such as a backup or a container layer — could read a durable credential until the user ran `executor logout`.

  It is now created `0600` with a follow-up `chmod`, matching what the local-server manifest already does for the sibling secret it keeps under `server-control/`. Both steps are needed: `mode` applies only on create, and the `chmod` covers rewriting a store that already exists with looser permissions — which is the common path here, since the file is rewritten on every token refresh.

  Separately, two tests in `server-profile.test.ts` were written as `it("…", () => Effect.gen(…))`. An `Effect` is not a thenable, so Vitest treated each as passing without ever running its body — a deliberately falsified assertion still passed. They are now `it.effect` and execute for real. No production behaviour was wrong; the tests simply were not checking it.

- [#1454](https://github.com/UsefulSoftwareCo/executor/pull/1454) [`e8ea62c`](https://github.com/UsefulSoftwareCo/executor/commit/e8ea62c8ba295931cf969cd310278b6a50771bdc) Thanks [@jadch](https://github.com/jadch)! - Prevent concurrent SQLite data-migration runners from failing when another runner commits the same ledger stamp first.

- [#1579](https://github.com/UsefulSoftwareCo/executor/pull/1579) [`31e17c7`](https://github.com/UsefulSoftwareCo/executor/commit/31e17c725f0987f86896519f0626f9c94d39ccb7) Thanks [@GeiserX](https://github.com/GeiserX)! - **The desktop settings store is written owner-only**

  `settings.json` holds `serverProfiles`, which carries a remote server's credential — a bearer token, or a basic-auth username and password — for any "Custom server" the user connects to. `conf` (under electron-store) defaults to `configFileMode: 0o666`, so with no explicit mode the file was created `0644`. On Linux, where `~/.config` is not reliably `0700`, that is readable by every other account on the machine. macOS is protected by `~/Library` being `0700` and Windows by ACLs, so this is primarily a Linux-desktop exposure — but owner-only credential files are already this app's standard: `local-auth.ts` writes `auth.json` at `0o600`, and the sidecar manifest is chmodded the same way.

  One option is sufficient here, rather than the mode-plus-chmod pair used elsewhere: `atomically` chmods the temp inode only when the requested mode differs from its own default, and the atomic rename then carries the tight mode onto an already-loose file. Verified against the installed `conf` — with no option a fresh file lands `0644`; with `configFileMode: 0o600` a fresh file lands `0600` and an existing `0644` file becomes `0600` on the next write.

- [#1582](https://github.com/UsefulSoftwareCo/executor/pull/1582) [`e8e97c4`](https://github.com/UsefulSoftwareCo/executor/commit/e8e97c4c008fce702ee07ec0ffe2a8d3e6946a21) Thanks [@GeiserX](https://github.com/GeiserX)! - **An MCP health check no longer reports `healthy` when the connection's credential is missing**

  Rendering skips an auth placement whose value is unresolved — that is the renderer's documented behaviour, and callers own the missing-value policy. The MCP health check had no such policy, so it dialled unauthenticated, and any server that lists tools without auth answered. `discoverTools` succeeding maps straight to `healthy`, so a connection whose credential was gone reported as healthy.

  Health status is the signal telling a user to re-authenticate, which makes `healthy` the one answer it must never give in that state. The check now reports `expired` with the unresolved input names, mirroring the OpenAPI health check, which already did exactly this.

  The MCP tool-invocation path already refused for the same reason. `resolveTools` is deliberately left alone — its own comment records that discovery tolerating unresolved credentials is intended, since an open server lists tools unauthenticated.

- [#1741](https://github.com/UsefulSoftwareCo/executor/pull/1741) [`62748e8`](https://github.com/UsefulSoftwareCo/executor/commit/62748e86122b747226c76c2e112c5c4d2b4f7095) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Opt-in per-integration search tools on the MCP surface**

  Connecting with `?search_tools=true` (stdio: `executor mcp --search-tools`) adds one minimally-described `search_<integration>` MCP tool per connected integration, so the integration namespaces reach the model as tool names it can see without calling anything. Each call routes through the same flow as `tools.search({ namespace })` inside `execute`, and the tool list comes from the same inventory the `execute` description shows. Off by default; a clean endpoint URL is unchanged.

- [#1573](https://github.com/UsefulSoftwareCo/executor/pull/1573) [`45ba141`](https://github.com/UsefulSoftwareCo/executor/commit/45ba1419b4e33ad10b0856c5fbc40fabc8f6efe1) Thanks [@GeiserX](https://github.com/GeiserX)! - **The MCP connection pool no longer keeps credentials in its cache key**

  A pooled remote MCP session is looked up by a key describing the connection's identity, and that key included the connection's resolved credential values — plus the headers and query params those same secrets had already been rendered into. The key is retained as a `Map` key for the pool's lifetime, so the secret stayed readable in process memory long after the call that needed it had finished, with nothing left to read it.

  The key is now the SHA-256 digest of that identity rather than the identity itself. Reuse is unchanged, because equal identities still produce equal keys, and separation is unchanged too: a rotated access token, a different rendered auth header and a credential carried in a query param each still dial a fresh session instead of reusing one authenticated as somebody else. Hashing the whole identity rather than only the fields known to be sensitive means a field added later is covered without anyone having to remember it carries a secret.

  Nothing reads the key back — the pool only compares it, and it reaches no log, span or error message — so nothing observable changes.

- [#1800](https://github.com/UsefulSoftwareCo/executor/pull/1800) [`eac13e7`](https://github.com/UsefulSoftwareCo/executor/commit/eac13e7032c027d866c06728f1d5b634fd9ef7dd) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Idle MCP session runtimes are actually reclaimed**

  The MCP session Durable Object has an idle timeout that disposes a session's execution runtime — the execution engine and its executor closure, the built tool catalog, and a live database handle — once the session has gone quiet. That timeout never ran.

  The session arms an idle alarm on every request. The agents framework independently recomputes the Durable Object alarm from its own schedule table and keep-alive refcount, and when it finds neither it does not leave the alarm alone: it deletes it. It releases the last keep-alive reference at the end of every ordinary tool call, from a `waitUntil` that runs just after the response goes out — so the idle alarm the session had armed moments earlier was erased, and a session that had just served a request was left with no alarm at all. Its runtime then stayed resident until the platform evicted the whole object.

  Durable Objects are colocated many-to-one onto an isolate with a single heap, so runtimes that are never reclaimed accumulate there. When the heap is exhausted the allocation that fails is whichever comes next, anywhere in the isolate — which is why the failure tended to surface from storage rather than from the runtimes that had consumed the memory.

  The idle deadline belongs to the session, not to the framework's scheduler, so it is now re-asserted after the framework has arranged whatever it needs — and only while a runtime is actually resident, since once there is nothing left to reclaim the framework's answer is correct.

  Disposal also now emits a span carrying a per-isolate resident-runtime gauge, alongside the same gauge on runtime build, so the reclaim can be confirmed in production rather than inferred.

- [#1609](https://github.com/UsefulSoftwareCo/executor/pull/1609) [`662ebe2`](https://github.com/UsefulSoftwareCo/executor/commit/662ebe28d5109156a1aa3b27eaa80ba9daacaf11) Thanks [@timkley](https://github.com/timkley)! - **Fix: declare the OAuth application type during dynamic client registration**

  Dynamic OAuth registrations now identify HTTPS callbacks as web applications
  and loopback HTTP callbacks as native applications. This lets strict OAuth
  servers validate Executor's redirect URI against the correct client type.

- [#1570](https://github.com/UsefulSoftwareCo/executor/pull/1570) [`e66a3d8`](https://github.com/UsefulSoftwareCo/executor/commit/e66a3d893c948fcccc7fc028870d051cb2d31860) Thanks [@GeiserX](https://github.com/GeiserX)! - **The OAuth popup clears its result out of `localStorage` after handing it over**

  The popup writes its result to `localStorage` as the fallback completion channel, because `postMessage` is severed when a provider's consent page sets COOP and `BroadcastChannel` can be partitioned or raced by the auto-close. Nothing removed that entry afterwards, so the payload — which carries the identity label, an email, and on failure the error preview — stayed parked in the user's browser profile.

  The entry is now cleared once the handover has had time to land, and on `pagehide` as a backstop — the failure page never auto-closes so the user can read the error, and closing it by hand would otherwise cancel the pending timer and strand the entry. This cannot cost a listener the result: a `storage` event captures `newValue` at dispatch, so an opener that has been notified already holds it.

- [#1574](https://github.com/UsefulSoftwareCo/executor/pull/1574) [`c8bb857`](https://github.com/UsefulSoftwareCo/executor/commit/c8bb8578c3afdc9731274d9e9abc68d7ce32d9ab) Thanks [@GeiserX](https://github.com/GeiserX)! - **The 1Password service-account token is cleared from the op-js global after each call**

  `@1password/op-js` keeps the service-account token on a module-level CLI instance (`cli.serviceAccountToken`) and reads it when it spawns `op`. The CLI backend set that global before each call and never cleared it, so one reachable reference to the token stayed live for the rest of the process.

  It is now cleared as soon as the call that needed it is done, on success, failure and interruption alike. Authentication is unaffected: every read and write of that global already happens inside the backend's semaphore, so the next operation re-sets the token before it spawns anything.

  This is hygiene rather than a boundary change. No unrelated `op` child ever received a stale token — every call routes through the same critical section that sets the correct one immediately before invoking — and the token is separately persisted in plaintext in the plugin's config blob, so an attacker's reach is unchanged. What it removes is a long-lived reachable reference that nothing needed to keep.

- [#1749](https://github.com/UsefulSoftwareCo/executor/pull/1749) [`d4afe0c`](https://github.com/UsefulSoftwareCo/executor/commit/d4afe0c79f146dd169a00988a2d5d0469297be19) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Slim the per-integration `search_<integration>` tool definitions to under half their size: one shared one-line description (the tool name already carries the namespace) and a single bare `query` parameter, dropping the `limit`/`offset` knobs. A session pays for these definitions once per connected integration, so the surface now costs ~2k tokens instead of ~5k at 30 integrations; paging through a namespace belongs in `execute`.

- [#1798](https://github.com/UsefulSoftwareCo/executor/pull/1798) [`69b0e64`](https://github.com/UsefulSoftwareCo/executor/commit/69b0e6413737599f11848b3877048f789ca84ac5) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **The packed Worker toolchain is verified at build time, and an incomplete copy is now reported instead of silently ignored**

  `@cloudflare/worker-bundler` cannot live inside the compiled binary: bunfs has no `node_modules`, so a bare specifier is unresolvable there by construction. The build instead copies the package's `dist/` next to the executable and `native-bindings.ts` publishes that path as `EXECUTOR_WORKER_BUNDLER_DIR` for consumers to load from.

  That handoff was described in two places that were free to drift, and did. The build writes `dist/index.bundled.js` — the entry consumers actually load, packed so it has no bare imports of its own — while the runtime check only looked for `dist/index.js` and `dist/esbuild.wasm`. Nothing verified the staged copy after the compile, so a partial staging produced a binary that looked fine on the build machine and failed on the user's, at startup. Worse, the runtime check failed open: when a file was missing it silently declined to set the environment variable, leaving a consumer to fall through to the bare specifier and crash.

  The required file list is now one shared contract used by both sides, so they cannot disagree. The build asserts the staged copy after compiling each target — every required file present, a size floor on the packed entry, and the `\0asm` magic on the wasm so a truncated copy cannot pass — turning a packaging slip into a failed build rather than a broken install. At runtime, a directory that is present but incomplete is reported on stderr naming the missing files, instead of being swallowed. An absent directory stays quiet, since that is the normal non-packaged path.

- Updated dependencies [[`55180cb`](https://github.com/UsefulSoftwareCo/executor/commit/55180cb1487f9a3a28ddc0ee0bedfab8464c1f72)]:
  - @executor-js/sdk@1.6.1
  - @executor-js/api@1.4.64
  - @executor-js/local@1.6.1
  - @executor-js/runtime-quickjs@1.6.1

## 1.6.0

### Patch Changes

- [#1737](https://github.com/UsefulSoftwareCo/executor/pull/1737) [`9296f36`](https://github.com/UsefulSoftwareCo/executor/commit/9296f36a8adbfdeec700ce33c37987127857b2fd) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Scope the `skills` tool to Executor's own documentation. Its description, argument, index, and unknown-name error now state that it serves a fixed catalog of how-to docs for this server's tools, so an agent on a host without a skill tool of its own no longer reads it as a general reader for the harness's or the user's skills.

- Updated dependencies [[`a2d1417`](https://github.com/UsefulSoftwareCo/executor/commit/a2d141758e478274813c8c24d354e1fd0f66af49)]:
  - @executor-js/sdk@1.6.0
  - @executor-js/local@1.6.0
  - @executor-js/api@1.4.63
  - @executor-js/runtime-quickjs@1.6.0

## 1.5.42

### Patch Changes

- Updated dependencies [[`d3f0617`](https://github.com/UsefulSoftwareCo/executor/commit/d3f0617deec06c57e0d6e1479fe668f79daf977d)]:
  - @executor-js/sdk@1.5.42
  - @executor-js/local@1.5.42
  - @executor-js/api@1.4.62
  - @executor-js/runtime-quickjs@1.5.42

## 1.5.41

### Patch Changes

- [#1600](https://github.com/UsefulSoftwareCo/executor/pull/1600) [`1b5f931`](https://github.com/UsefulSoftwareCo/executor/commit/1b5f931d90b52fa9eca7b6f53359a117d757c7c1) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Add `integrations.remove` to the core tools so an agent can drop a catalog integration**

  `integrations.list` advertises `canRemove` per integration, but nothing on the agent surface could act on it: removal existed only on the HTTP API and the web console, so an agent that could add an integration could never take one back out. Cleaning up a catalog meant clicking through the UI once per integration.

  The core-tools plugin now contributes `integrations.remove`, taking the `slug` reported by `integrations.list` and cascading to every connection under the integration and the tools those produced. It is approval-gated, being strictly more destructive than `connections.remove`. The `removed` flag is honest rather than always-true: `false` means no catalog row matched, so an already-absent slug and a built-in namespace like `executor` are distinguishable from a real removal, and an integration pinned with `canRemove: false` is refused with `IntegrationRemovalNotAllowedError` instead of silently surviving.

- [#1556](https://github.com/UsefulSoftwareCo/executor/pull/1556) [`f674fb8`](https://github.com/UsefulSoftwareCo/executor/commit/f674fb80eebd597f922edd5ec21b8035ab195a78) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Fix: native MCP elicitation now reaches clients on the local HTTP endpoint instead of timing out**

  The local daemon's Streamable HTTP transport ran with `enableJsonResponse: true`, which buffers a `tools/call` into a single JSON body and leaves no open stream for the server to write on. A server-to-client `elicitation/create` raised during that call was therefore never delivered, and approval-gated tools failed with a `-32001` request timeout even though the session had negotiated `elicitation_mode=native` and the client's `elicitation.form` capability. The transport now uses the spec-default SSE streaming, so the reverse request rides the originating tool call's stream — matching the Cloudflare host's behaviour.

- [#1603](https://github.com/UsefulSoftwareCo/executor/pull/1603) [`624e85f`](https://github.com/UsefulSoftwareCo/executor/commit/624e85f033632a7624c2bddf0944112166b1f481) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Fix: `oauth.clients.remove` reported success for clients it never removed**

  The tool returned `{ removed: true }` unconditionally. `oauth.removeClient` is idempotent by design at the storage layer — `deleteMany` on a missing row is a no-op, which is the right behaviour for a delete — but the tool mapped that silence to success, so a typo'd slug, an already-deleted client, and the wrong owner were all indistinguishable from a real deletion.

  This bites hardest because clients are keyed by BOTH owner and slug, so the same slug can exist separately under `org` and `user`. An agent sweeping a list of slugs under one hardcoded owner would delete only half of them and report every call as a success, leaving org-owned OAuth apps registered after everything they authorized was gone.

  The tool now checks the caller-visible client set first and returns `removed: false` when nothing matched that `(owner, slug)` pair. The service-level `removeClient` is unchanged and stays idempotent.

- Updated dependencies [[`d572658`](https://github.com/UsefulSoftwareCo/executor/commit/d572658d74097917412256f10a3ea2e3974f44dd)]:
  - @executor-js/sdk@1.5.41
  - @executor-js/local@1.5.41
  - @executor-js/api@1.4.61
  - @executor-js/runtime-quickjs@1.5.41

## 1.5.40

### Patch Changes

- [#1528](https://github.com/UsefulSoftwareCo/executor/pull/1528) [`676af1a`](https://github.com/UsefulSoftwareCo/executor/commit/676af1a78301d83cdab52b0389b4c67ed07ae872) Thanks [@baggiiiie](https://github.com/baggiiiie)! - Prevent execute agents from attempting unsupported base64 decoding by directing file payloads through ToolFile emission and bodyBase64 forwarding.

- [#1545](https://github.com/UsefulSoftwareCo/executor/pull/1545) [`df62bb3`](https://github.com/UsefulSoftwareCo/executor/commit/df62bb3c8753edf2db32cb45961cf1723114ea2d) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Fix: reconnecting an OAuth connection now refreshes its health status in place — no page reload needed**

  Completing a reconnect previously left the stale "Expired" verdict on the connection row (and the integrations-list summary) until a hard refresh. Re-minting now clears the persisted verdict, and the UI re-probes as soon as the refreshed connection arrives.

- [#1534](https://github.com/UsefulSoftwareCo/executor/pull/1534) [`80e5530`](https://github.com/UsefulSoftwareCo/executor/commit/80e553026278b1ecd7807f1ba99ba13b19d2c336) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Report the real product surface and version in the integrations.sh registry user-agent. The daemon previously sent `local` with a version frozen at 1.4.4; it now reports `cli` or `desktop` (matching analytics surfaces) and `@executor-js/local` is versioned with the release train.

- Updated dependencies [[`8ba64f6`](https://github.com/UsefulSoftwareCo/executor/commit/8ba64f675f6d6ab5302d4f68390c0b055d006f4a), [`80e5530`](https://github.com/UsefulSoftwareCo/executor/commit/80e553026278b1ecd7807f1ba99ba13b19d2c336)]:
  - @executor-js/sdk@1.5.40
  - @executor-js/local@1.5.40
  - @executor-js/api@1.4.60
  - @executor-js/runtime-quickjs@1.5.40

## 1.5.39

### Patch Changes

- Updated dependencies [[`6c316c7`](https://github.com/UsefulSoftwareCo/executor/commit/6c316c77a9efc98784976236852b58c6156e016e)]:
  - @executor-js/sdk@1.5.39
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.59
  - @executor-js/runtime-quickjs@1.5.39

## 1.5.38

### Patch Changes

- [#1417](https://github.com/UsefulSoftwareCo/executor/pull/1417) [`046d67d`](https://github.com/UsefulSoftwareCo/executor/commit/046d67d75c3a8bc4cf0ab9dc4e723bc26ff130a3) Thanks [@morluto](https://github.com/morluto)! - Show policy and OAuth app removal failures in the UI, and keep success-only state unchanged when those writes fail.

- [#1511](https://github.com/UsefulSoftwareCo/executor/pull/1511) [`7eb795d`](https://github.com/UsefulSoftwareCo/executor/commit/7eb795dda19c6177ad3bd590005eca1e326f760c) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Fix: `execute` scripts that both `emit()` output and `return` a value no longer lose the returned value in MCP clients that ignore `structuredContent` — the return value is now appended to the tool-result content after the emitted items**

- [#1418](https://github.com/UsefulSoftwareCo/executor/pull/1418) [`d3610e3`](https://github.com/UsefulSoftwareCo/executor/commit/d3610e386324891ccfde111e1ff519ec9218d30f) Thanks [@morluto](https://github.com/morluto)! - Return an execution error when a Deno subprocess closes stdin instead of emitting an unhandled write failure.

- [#1507](https://github.com/UsefulSoftwareCo/executor/pull/1507) [`541549a`](https://github.com/UsefulSoftwareCo/executor/commit/541549a5dd8806f45b1a01ea6f4fa18ac41f53b1) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Fix: OAuth refresh rejections with non-spec error bodies (e.g. Datadog) now surface as expired connections with a reconnect path, and definitively dead refresh tokens are no longer retried against the authorization server**

- [#1517](https://github.com/UsefulSoftwareCo/executor/pull/1517) [`59a6640`](https://github.com/UsefulSoftwareCo/executor/commit/59a6640e575c740d22e7804cdb67cd76efe8332b) Thanks [@kitze](https://github.com/kitze)! - **Fix: OpenAPI query parameters that use form-style exploded objects now serialize each object field as a query parameter.**

- [#1416](https://github.com/UsefulSoftwareCo/executor/pull/1416) [`f1b617c`](https://github.com/UsefulSoftwareCo/executor/commit/f1b617ce82475d4fe35be7a98c6bf9f468dbbd60) Thanks [@morluto](https://github.com/morluto)! - Prevent provider service migration row loss caused by generated ID conflicts.

- [#1420](https://github.com/UsefulSoftwareCo/executor/pull/1420) [`8c71744`](https://github.com/UsefulSoftwareCo/executor/commit/8c7174452fe05f32815950ed06f38516883a7c8f) Thanks [@morluto](https://github.com/morluto)! - Abort GraphQL tool calls that exceed the configured invocation timeout instead of waiting indefinitely for an upstream response.

- Updated dependencies [[`6a924dd`](https://github.com/UsefulSoftwareCo/executor/commit/6a924dd98de916d6ff8cea2329bf672f149b64f4)]:
  - @executor-js/sdk@1.5.38
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.58
  - @executor-js/runtime-quickjs@1.5.38

## 1.5.37

### Patch Changes

- [#1506](https://github.com/UsefulSoftwareCo/executor/pull/1506) [`c05a1cf`](https://github.com/UsefulSoftwareCo/executor/commit/c05a1cfa629b7f28a7d870c584998cb9cbbaf303) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Artifacts are now on by default for MCP connections.** A plain endpoint URL serves the full artifact surface — the artifact tools, the app shell resource, and the artifact skills. Connections that don't want it opt out with `?artifacts=false` (or `--no-artifacts` on the stdio CLI); `?artifacts=true` remains accepted as the explicit default. Previously the surface required a `?artifacts=true` opt-in.

- [#1498](https://github.com/UsefulSoftwareCo/executor/pull/1498) [`657b913`](https://github.com/UsefulSoftwareCo/executor/commit/657b9135b8b841495b362936bf60bdca998c16eb) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Add anonymous product analytics to the local daemon (CLI + desktop) and self-host: execution counts split by MCP/API plane, toolkit usage, integration add/remove, and artifact usage (created/viewed/updated/deleted, attributed to agent tools vs the console UI), filed under a persisted per-install anonymous id. Opt out with DO_NOT_TRACK or EXECUTOR_DISABLE_ANALYTICS.

- [#1500](https://github.com/UsefulSoftwareCo/executor/pull/1500) [`5eb2ca3`](https://github.com/UsefulSoftwareCo/executor/commit/5eb2ca36f93d2dae6eb8b3506c5de04ca141bb20) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Fix: the artifact migration no longer narrows `definition.name` to varchar(255), which failed on existing long definition names**

- [#1472](https://github.com/UsefulSoftwareCo/executor/pull/1472) [`1178e3b`](https://github.com/UsefulSoftwareCo/executor/commit/1178e3b31cd62cd2c05d6504d1586c2d8f018692) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Add an Artifacts tab. Interactive components an agent generates with `render-ui` are saved and listed in the console, and each one has its own page that renders it live — the page an MCP client without MCP Apps support deep-links to. Artifacts can be renamed and deleted from the console, and agents find them again by title.

- [#1505](https://github.com/UsefulSoftwareCo/executor/pull/1505) [`9bd4a5b`](https://github.com/UsefulSoftwareCo/executor/commit/9bd4a5b6063bd98f5ae8070baf0dd3ee3e110d68) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Artifact tool results now include the web deep link beside the inline widget payload, not just on the no-apps fallback. Clients can lose a rendered widget in ways the server never sees — a reopened transcript that skips the resource re-read shows raw JSON — and the URL in the result is the model's way to point the user back at the artifact.

- [#1483](https://github.com/UsefulSoftwareCo/executor/pull/1483) [`54df2e3`](https://github.com/UsefulSoftwareCo/executor/commit/54df2e3e99509008759269b27484ee6581ce8827) Thanks [@davidwrossiter](https://github.com/davidwrossiter)! - **Fix: GraphQL connections now reject credentials when schema introspection fails and show actionable tool sync diagnostics**

- [#1499](https://github.com/UsefulSoftwareCo/executor/pull/1499) [`010ea98`](https://github.com/UsefulSoftwareCo/executor/commit/010ea98e520643731b07e68e21119f12b8ef1505) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Fix: the add-connection wizard no longer wipes a pasted credential when the key check saves a health check mid-flow**

- [#1503](https://github.com/UsefulSoftwareCo/executor/pull/1503) [`a7c4689`](https://github.com/UsefulSoftwareCo/executor/commit/a7c468944837cfe097f03f69d612bde31903f284) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Fix: MCP responses larger than Durable Object storage's 128 KiB per-value cap hung the client instead of being delivered**

  The DO transport persisted every outbound message for reconnect replay before writing the live SSE frame, and `storage.put` of an oversize value throws — so a large response (the `ui://executor/shell.html` resource is ~5 MB) was neither stored nor sent, and the client waited on keepalives forever. The transport now delivers the live frame first and treats persistence as best-effort: an oversize message skips the event store with a logged warning and arrives without a replay id, which only costs replayability if the connection drops mid-delivery.

- [#1502](https://github.com/UsefulSoftwareCo/executor/pull/1502) [`25270b1`](https://github.com/UsefulSoftwareCo/executor/commit/25270b1f1f091778ba6584e41b041092fc1bdd00) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Fix: MCP clients of the cloud host got a "Shell not built" placeholder as the `ui://executor/shell.html` resource, so every artifact rendered as a widget that never finished loading**

  The deployed Worker has no filesystem, and the shell loader silently fell back to an inert placeholder document when its `fs.readFile` failed. Workers hosts now fetch the built shell through the static-assets binding (the app build emits a stable-named copy alongside the hashed one), the self-host image reads the same emitted asset from its SPA dist, and a host that cannot produce the shell now fails the resource read with an actionable error instead of serving a document that hangs the client. App builds fail if the shell asset was not emitted.

- Updated dependencies [[`657b913`](https://github.com/UsefulSoftwareCo/executor/commit/657b9135b8b841495b362936bf60bdca998c16eb)]:
  - @executor-js/sdk@1.5.37
  - @executor-js/api@1.4.57
  - @executor-js/local@1.4.4
  - @executor-js/runtime-quickjs@1.5.37

## 1.5.36

### Patch Changes

- [#1478](https://github.com/UsefulSoftwareCo/executor/pull/1478) [`8ecbfd6`](https://github.com/UsefulSoftwareCo/executor/commit/8ecbfd65f2c1393c75661c792723961877866cc5) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Store minted OAuth tokens in the durable file secret store (`auth.json` under `EXECUTOR_DATA_DIR`) instead of the system keychain. On sandbox/headless hosts the keychain can be an in-memory keyring that a stop/recreate wipes, leaving OAuth connections expired with "Stored refresh token could not be resolved." Existing keychain-backed connections migrate with one clean reconnect.

- [#1462](https://github.com/UsefulSoftwareCo/executor/pull/1462) [`5a70675`](https://github.com/UsefulSoftwareCo/executor/commit/5a706756c66e53c9a929e9a8c30e57166b8d121b) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Fix: org OAuth connections on self-host worked only for whoever ran the consent**

  The encrypted-secrets credential provider (the writable provider on the self-hosted and Cloudflare hosts) filed token rows under the _acting user's_ private partition instead of the credential's own owner. An org-owned OAuth connection whose consent completed in one member's browser session therefore resolved only for that member — every other principal failed with `oauth_connection_missing`, while the UI showed the connection healthy. The provider now partitions by the owner embedded in the item id (`oauth:org:…` → org-shared), matching the WorkOS Vault provider, and a boot-time data migration re-files rows already written wrong. The encrypted value itself was never affected.

- [#1459](https://github.com/UsefulSoftwareCo/executor/pull/1459) [`fc1e589`](https://github.com/UsefulSoftwareCo/executor/commit/fc1e589613a14750c2ca8c34838a71c758544c8d) Thanks [@wan0net](https://github.com/wan0net)! - Preserve `elicitation_mode=native` when creating self-hosted MCP sessions.

- [#1475](https://github.com/UsefulSoftwareCo/executor/pull/1475) [`77b0821`](https://github.com/UsefulSoftwareCo/executor/commit/77b0821ff9bddd6fb419d81a18b9e1af804fdb55) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Refresh OAuth tokens when the upstream rejects them with HTTP 401, not only when the stored expiry says they are due. Connections whose authorization server omits `expires_in` can now recover without a manual reconnect, and the refresh path is traced.

- [#1476](https://github.com/UsefulSoftwareCo/executor/pull/1476) [`167d899`](https://github.com/UsefulSoftwareCo/executor/commit/167d899162794064eeac0a755697c2c943f1b9ac) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Remove the custom apps plugin. Git and local-directory app sources are no
  longer supported. The packed binary still ships the workerd and worker-bundler
  sidecars.
- Updated dependencies []:
  - @executor-js/sdk@1.5.36
  - @executor-js/runtime-quickjs@1.5.36
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.56

## 1.5.35

### Patch Changes

- Updated dependencies [[`1b9b1f1`](https://github.com/UsefulSoftwareCo/executor/commit/1b9b1f10313834a625a411169ebf83f6181589df), [`99c808f`](https://github.com/UsefulSoftwareCo/executor/commit/99c808f09d3cf2263945efa4f6592cc4e78c9e08)]:
  - @executor-js/sdk@1.5.35
  - @executor-js/runtime-quickjs@1.5.35
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.55

## 1.5.34

### Patch Changes

- Updated dependencies [[`e2712db`](https://github.com/UsefulSoftwareCo/executor/commit/e2712dbff98145c5c340832ffbdcb21113b9dd78), [`7207347`](https://github.com/UsefulSoftwareCo/executor/commit/720734756a70b1b4f1564bdf82dc4118e5de2b76), [`0c4e9b4`](https://github.com/UsefulSoftwareCo/executor/commit/0c4e9b49fecb35ad71c92a464c3ea01131ff9d6f)]:
  - @executor-js/sdk@1.5.34
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.54
  - @executor-js/runtime-quickjs@1.5.34

## 1.5.33

### Patch Changes

- [#1404](https://github.com/UsefulSoftwareCo/executor/pull/1404) [`5e0dd15`](https://github.com/UsefulSoftwareCo/executor/commit/5e0dd15291daaedf10f6eb8e03c5afdca8787764) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - The provider service split boot migration now skips an org whose Google or Microsoft integration cannot be migrated (for example a config without a stored specHash) instead of failing the whole migration and blocking server startup. A daemon that does fail during boot now exits with the underlying error message instead of hanging with a generic "Unknown error".

- Updated dependencies []:
  - @executor-js/local@1.4.4
  - @executor-js/sdk@1.5.33
  - @executor-js/runtime-quickjs@1.5.33
  - @executor-js/api@1.4.53

## 1.5.32

### Patch Changes

- [#1395](https://github.com/UsefulSoftwareCo/executor/pull/1395) [`d90d8be`](https://github.com/UsefulSoftwareCo/executor/commit/d90d8be38fa26d3a6b8a5ac648af815191f537bb) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Policy create now defaults a new rule's position below any more-specific existing rule on the server, so a broad rule written without an explicit position (stale UI, API, agent tool) cannot shadow an existing narrower rule.

- [#1394](https://github.com/UsefulSoftwareCo/executor/pull/1394) [`1ca5111`](https://github.com/UsefulSoftwareCo/executor/commit/1ca511101fad057d129db9941b5c9bce963baf0a) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Ship the platform workerd binary in the self-host Docker runtime; without it custom app tools failed to sync or invoke with "workerd is unavailable on this platform".

- Updated dependencies []:
  - @executor-js/sdk@1.5.32
  - @executor-js/runtime-quickjs@1.5.32
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.52

## 1.5.31

### Patch Changes

- [#1390](https://github.com/UsefulSoftwareCo/executor/pull/1390) [`d95e63c`](https://github.com/UsefulSoftwareCo/executor/commit/d95e63cc33ade4ce0996678cfa51a5e4c784a9ea) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Ship @cloudflare/worker-bundler in the self-host Docker runtime so the server starts; it was resolved at runtime since the dynamic Worker bundler change but never copied into the image.

- Updated dependencies []:
  - @executor-js/local@1.4.4
  - @executor-js/sdk@1.5.31
  - @executor-js/runtime-quickjs@1.5.31
  - @executor-js/api@1.4.51

## 1.5.30

### Patch Changes

- [#1371](https://github.com/UsefulSoftwareCo/executor/pull/1371) [`262fc3e`](https://github.com/UsefulSoftwareCo/executor/commit/262fc3edcad31a53bd8aecacf8fe784b276fb745) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Explain 401s from a hosted server as a sign-in problem with the exact `executor login` command to run, instead of surfacing a raw decode error. `executor login` now defaults to https://executor.sh when no server is specified, and profile plumbing stays out of messages unless you address servers by name.

- [#1375](https://github.com/UsefulSoftwareCo/executor/pull/1375) [`0f81165`](https://github.com/UsefulSoftwareCo/executor/commit/0f81165138c1c987f13ff9839e46539f80b229b0) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Run cloud custom tool bundling in a dynamically loaded Worker so dependency installation and bundling do not share the serving request isolate.

- [#1349](https://github.com/UsefulSoftwareCo/executor/pull/1349) [`a7e3091`](https://github.com/UsefulSoftwareCo/executor/commit/a7e3091a94fbdf032ef134989ceaba4f0b1b3231) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Back-stop code execution with a host-side timeout so a wedged sandbox delivers a descriptive error instead of hanging silently.

- [#1351](https://github.com/UsefulSoftwareCo/executor/pull/1351) [`93b000a`](https://github.com/UsefulSoftwareCo/executor/commit/93b000a4ba24317f5a1f08fd8d7f72457d115f06) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Let stock MCP clients auto-reconnect and recover a tool result when a POST stream drops mid-call.

- [#1345](https://github.com/UsefulSoftwareCo/executor/pull/1345) [`c46730b`](https://github.com/UsefulSoftwareCo/executor/commit/c46730b5d48cc62dae1abdbe32136f3c229d79f6) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Preserve MCP tool results across dropped streamable HTTP SSE connections.

- [#1357](https://github.com/UsefulSoftwareCo/executor/pull/1357) [`4c319ee`](https://github.com/UsefulSoftwareCo/executor/commit/4c319ee2e4a8d062402a80419dd3e1d829908ad8) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Throw a guidance error when sandbox code enumerates the `tools` proxy (`Object.keys`, spread, `for...in`) instead of returning an empty list, pointing agents at `tools.search()`.

- [#1352](https://github.com/UsefulSoftwareCo/executor/pull/1352) [`8bdf315`](https://github.com/UsefulSoftwareCo/executor/commit/8bdf31550f702e6bce6c3460bb9d26fcce925d7b) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Treat a transient WorkOS outage during the MCP live-membership check as a retryable 503 instead of a Forbidden that destroys the session.

- Updated dependencies []:
  - @executor-js/sdk@1.5.30
  - @executor-js/runtime-quickjs@1.5.30
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.50

## 1.5.29

### Patch Changes

- [#1341](https://github.com/UsefulSoftwareCo/executor/pull/1341) [`5656c3e`](https://github.com/UsefulSoftwareCo/executor/commit/5656c3e2fbb1982510267a7999f4ae37cdb5a381) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Fix 1Password desktop-app connections failing with "undefined is not a constructor (evaluating 'new n.DesktopAuth(...)')" in packaged builds. The compiled binary now bundles the 1Password SDK's wasm core correctly and falls back to a copy shipped next to the binary, so vault listing and secret resolution work without the `op` CLI installed.

- Updated dependencies []:
  - @executor-js/sdk@1.5.29
  - @executor-js/runtime-quickjs@1.5.29
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.49

## 1.5.28

### Patch Changes

- Updated dependencies [[`1c48182`](https://github.com/UsefulSoftwareCo/executor/commit/1c4818254e71dc4ee27ff95f489e2c5cf330a450)]:
  - @executor-js/sdk@1.5.28
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.48
  - @executor-js/runtime-quickjs@1.5.28

## 1.5.27

### Patch Changes

- Updated dependencies [[`c7ab1e2`](https://github.com/RhysSullivan/executor/commit/c7ab1e2d56884e0453af85f6399fd25a39f04785)]:
  - @executor-js/api@1.4.47
  - @executor-js/local@1.4.4
  - @executor-js/sdk@1.5.27
  - @executor-js/runtime-quickjs@1.5.27

## 1.5.26

### Patch Changes

- [#1221](https://github.com/RhysSullivan/executor/pull/1221) [`3606317`](https://github.com/RhysSullivan/executor/commit/360631733e0d0595094a06b9a9fbe06b2714d16c) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Send correct `Cache-Control` headers for the self-hosted web app. The SPA shell (`index.html`) and its client-route fallbacks are now served with `no-cache`, so a new deploy is picked up on the next visit instead of the browser rendering a stale UI from cache until a hard refresh. Content-hashed `/assets/*` are served `immutable` and cached long-term.

- Updated dependencies []:
  - @executor-js/sdk@1.5.26
  - @executor-js/runtime-quickjs@1.5.26
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.46

## 1.5.25

### Patch Changes

- Updated dependencies []:
  - @executor-js/local@1.4.4
  - @executor-js/sdk@1.5.25
  - @executor-js/runtime-quickjs@1.5.25
  - @executor-js/api@1.4.45

## 1.5.24

### Patch Changes

- [#1207](https://github.com/RhysSullivan/executor/pull/1207) [`c8d9b9d`](https://github.com/RhysSullivan/executor/commit/c8d9b9df2a463da800233a8735b309db2e333d50) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Polish the app's title bar. The release tag beside the `executor` wordmark is now quiet muted-mono metadata instead of a filled pill, matching the registry-minimal design language, and the wordmark is shared across the desktop and dashboard shells so the brand reads identically everywhere. The macOS traffic-light offset is also applied to the mobile sidebar overlay and the collapsed top bar, so the native window controls never sit on top of the wordmark when the window is narrow.

- [#1204](https://github.com/RhysSullivan/executor/pull/1204) [`9394217`](https://github.com/RhysSullivan/executor/commit/939421733830c78c0be8e7a4c65ea9a7c143abfb) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Fix the self-host and Cloudflare web dashboards showing "update available" even on the latest version. The builds baked a placeholder version (`0.0.0-selfhost` / `0.0.0-cloudflare`) into the shell, so the update check always compared as behind. They now bake the real release version, and the sidebar footer shows the running version so you can see what you are on.

- [#1209](https://github.com/RhysSullivan/executor/pull/1209) [`ffa4f70`](https://github.com/RhysSullivan/executor/commit/ffa4f700fdba4e3c525f58bbfb0e8355946e29cb) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Fix the desktop and CLI daemon crashing on first launch on Windows when a v1 local database is present. The v1 to v2 data migration performed file operations (fsync, rename, remove) on libSQL SQLite files whose native OS handles linger after close() on Windows, surfacing as a fatal "Unknown error" (EPERM on fsync of a read-only handle, EBUSY on rename/remove of just-closed files). POSIX is unaffected, so this only reproduced on Windows. The migration now opens files read-write for fsync (treating it as best-effort), retries removes the same way renames were already retried, and forces a GC pass on each retry so libSQL's native finalizer releases the handle before the next attempt. Fixes the v1.5.23 Windows startup regression.

- Updated dependencies []:
  - @executor-js/sdk@1.5.24
  - @executor-js/runtime-quickjs@1.5.24
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.44

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
