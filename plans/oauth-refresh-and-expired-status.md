# "Expired" is lying, and refresh races cause it — analysis + plan

Status: analysis complete, plan proposed. No code changed yet.

The complaint: on executor.sh connections show a red **Expired** badge that is
wrong (or unrecoverable), and token refresh does not behave as if it were
coordinated. Both halves are the same defect family — the health verdict and
the refresh machinery disagree about what is evidence — and one of them
(refresh races across cloud's request/DO boundaries) actively _manufactures_
the false "Expired".

Everything below cites current `main` (`a72e51d13`).

---

## 1. How status and refresh work today

**Refresh triggers** (`packages/core/sdk/src/executor.ts`)

- Proactive: `resolveConnectionValues` (:2998) refreshes when
  `shouldRefreshToken({ expiresAt })` — `expires_at <= now + 60s`
  (`oauth-helpers.ts:1726`, `OAUTH2_REFRESH_SKEW_MS = 60_000`). A **null**
  `expires_at` never fires proactively, by design.
- Reactive: `executor.execute` retries once on a tool 401 via
  `forceRefreshConnectionValues` (:3049, call site :6642-6674).
- Dedup: `refreshInFlight` — a `WeakMap` keyed on the **root db handle object**
  (:264, :1986-1990). Its own doc block states the limit: _"dedup reaches
  exactly as far as one root DB handle in one process … Multi-instance
  deployments are outside it … Both need database-backed coordination
  (compare-and-swap on the stored refresh token)."_
- Failure: a definitive rejection calls `markRefreshGrantDead` (:2294), which
  writes `provider_state.oauthReauthRequiredAt` + an `expired` `last_health`.

**What a dead grant means** — permanent, and derived on every read:

- `performTokenRefresh` refuses to even send the grant (:2600-2630).
- `connectionCheckHealth` refuses to probe and answers `deadGrantVerdict`
  (:5186-5195), including for the manual "Check now".
- `presentedLastHealth` (:1118) re-derives `expired` on **every** API read, so
  no writer can bury it and `healPersistedHealthOnUse` (:4966) bails out.
- Only a reconnect (which rewrites `provider_state` wholesale) clears it.

This gate is deliberate and earned: the Datadog incident (100+ identical
rejections over two days, comment at :2600) plus
`e2e/scenarios/connection-health-verdict.test.ts` and
`e2e/selfhost/mcp-oauth-reconnect-health.test.ts` pin it. **The plan keeps the
gate.** It fixes what feeds it and how little evidence it takes to trigger it.

---

## 2. Root causes, ranked

### R1 — In cloud, the refresh gate dedups _nothing_, and the loser bricks the connection (severity: critical)

`apps/cloud/src/api/protected.ts:110-121` + `apps/cloud/src/api/layers.ts:38-46`
rebuild `DbService` **per request** (Cloudflare forbids sharing I/O across
handlers), and `cloudDbProviderLayer` rebuilds the fuma client off it
(`apps/cloud/src/db/fuma.ts:56-73`). So in the HTTP plane every request gets a new
db object → a new `WeakMap` entry → a fresh, empty gate. The MCP plane is
per-session (`session-durable-object.ts:156-160` builds one handle per DO), so
two sessions, or a session plus any HTTP request, are also mutually
undeduped.

Consequence, with a rotating authorization server (the norm — our own test AS
rotates: `packages/core/sdk/src/testing/oauth-test-server.ts:876-887`):

1. Surface A and surface B both read refresh token `R1`, both send a grant.
2. A wins, stores `R2` + a fresh access token, `expires_at` updated.
3. B is answered `invalid_grant` (reuse) → `markRefreshGrantDead` →
   `provider_state.oauthReauthRequiredAt`.
4. `markRefreshGrantDead` (:2294-2336) is an unconditional `updateMany` — no
   CAS, unlike `persistHealthResult` (:4917-4936) which CASes on
   `updated_at`/`tools_synced_at`. Nothing ever re-checks that the token we
   sent is still the token on the row, and `persistRefreshedToken` (:2363)
   never clears the marker.

Net: **a connection holding a perfectly valid rotated refresh token presents
`expired` forever**, on every surface, unreachable by probe or by use, until a
human re-consents. Worse, providers that treat reuse as theft revoke the whole
token family, so the race can kill the grant for real.

The trigger surface is broad: at the moment a token goes due, every concurrent
touchpoint refreshes — parallel tool calls across sessions, a tool sync
(`#2028` runs sync in the background), a browser tab loading the accounts page
(use-connection-health probes with **no** freshness window for non-healthy
verdicts), the OAuth callback's catalog sync.

### R2 — One 4xx is enough to declare a grant permanently dead (severity: high)

`oauth-helpers.ts:73-91`:

```ts
isUnusableSuccessTokenResponse = (e) => e.status !== undefined && e.status < 300;
isPermanentTokenRejection = (e) =>
  isUnusableSuccessTokenResponse(e) || (e.status >= 400 && e.status < 500);
```

and `executor.ts:2858-2872` maps that straight to `reauthRequired: true` →
dead grant. So these transient/ambiguous outcomes permanently brick a
connection:

- **429** — a rate-limited token endpoint (very likely once R1 makes us send
  duplicate grants, and likely under an AS incident). 429 is a 4xx.
- **408**, **425**, proxy/WAF **403** or **404** HTML pages, CDN edge errors.
- **2xx that is not a token response** — a captive-portal/challenge page, an
  HTML 200 from a misrouted origin: `< 300` ⇒ dead grant.

The §5.2 `invalid_grant` path (:2833-2857) is genuinely definitive and should
stay one-shot. Everything else is inference from an HTTP status and deserves a
second opinion.

### R3 — The health probe never refreshes reactively, so it reports `expired` for connections that work (severity: high)

`connectionCheckHealth` (:5240-5280) resolves credentials (proactive refresh
only) and hands them to the plugin probe. A 401 becomes
`classifyHttpStatus → "expired"` (`health-check.ts:208-213`) and is persisted.
Unlike `executor.execute`, there is **no** forced-refresh-and-retry.

So for exactly the cases the reactive path was built for — server-side
revocation, an IdP idle timeout shorter than the advertised lifetime, and
**null `expires_at`** (AS omitted `expires_in`; `oauth-flow.test.ts:2508`
records 5 such rows in production) — a page load writes `expired`, the badge
goes red, and it only heals if the user happens to invoke a tool
(`healPersistedHealthOnUse`, :4966). A connection that would refresh fine on
next use is presented as dead.

### R4 — `healthy` is asserted without evidence (severity: medium)

For an OAuth connection on an integration with **no** declared `health_check`
spec, the probe is skipped entirely and the verdict is
`oauthCredentialHealthWithoutProbe` (:5045-5056, branch :5242-5250):
`{ status: "healthy", detail: "Credential resolved (no probe configured)." }`
— persisted, which then suppresses revalidation for 5 minutes
(`use-connection-health.ts:HEALTH_REVALIDATE_MS`). Reading a token out of the
vault proves nothing about the upstream. This is pinned by
`e2e/scenarios/google-health-checks.test.ts:381`, so it is intentional, but it
is the mirror image of R3: the same badge is both falsely red and falsely
green. It also skips plugins that _could_ probe without a spec (MCP's
`checkHealth` ignores `spec` and discovers tools:
`packages/plugins/mcp/src/sdk/plugin.ts:1941-1981`).

### R5 — A refresh that omits `expires_in` erases the expiry (severity: medium)

`persistRefreshedToken` (:2386-2390):
`expires_at = typeof token.expires_in === "number" ? now + expires_in*1000 : null`.
An AS that advertises a lifetime on the code exchange but omits it on refresh
(RFC 6749 makes it optional) drops the connection to null expiry **forever
after the first refresh** — proactive refresh can never fire again, so every
subsequent call pays a 401 + reactive refresh, and R3 turns each of those into
a red badge between uses.

### R6 — Scope shortfalls and fuzzy text matching read as `expired` (severity: medium)

- `classifyHttpStatus` maps **403 → expired**. The invoke path already knows
  better: `detectInsufficientScope` (`packages/core/sdk/src/insufficient-scope.ts`,
  used at `packages/plugins/openapi/src/sdk/backing.ts:777-800`) distinguishes
  RFC 6750 `insufficient_scope` / Google `ACCESS_TOKEN_SCOPE_INSUFFICIENT`. The
  probe path only carves out Google's _configuration_ 403s
  (`health-check.ts:250-257`), so "you granted too few scopes" is rendered as
  a red **Expired** + "reconnect to restore access", when the remedy is
  re-consent and the row already carries `missingOAuthScopes`.
- GraphQL classifies on free text:
  `packages/plugins/graphql/src/sdk/plugin.ts:118-121` marks `expired` for any
  upstream message matching `/permission|credential|api.?key|sign in/i`,
  including a 200-body error from an unrelated cause.

### R7 — 60s skew, no background refresh (severity: low)

`OAUTH2_REFRESH_SKEW_MS = 60_000` is thin next to a 20s token-request timeout
and an agent turn that can run for minutes; and refresh is call-time only, so
an idle connection's grant can age out (many ASes expire refresh tokens on
inactivity) with nobody looking. Also relevant: the health-probe gate is keyed
the same per-request way as the refresh gate, so the "N tabs collapse to one
probe" claim in `connections/api.ts:244-246` does not hold in cloud either.

### R8 — the MCP liveness probe dials a SECOND connection, so single-instance local servers fail their own health check (severity: high, local)

`checkHealth` in `packages/plugins/mcp/src/sdk/plugin.ts:1972-1994` builds a
fresh connector and calls `discoverToolsFromInput`, which creates a new
connection (`discover.ts:142` → `createMcpConnector`) with a 15s deadline. It
never takes the pooled connection that tool invocations use
(`connection-pool.ts`, one idle session per identity, five-minute TTL;
`invoke.ts:468-478`). For a remote server that costs a handshake. **For a
local stdio server it spawns a second child process** — and the common local
servers are single-instance: Chrome DevTools MCP owns a browser and a debug
port, Playwright MCP the same, `docker run -i` a container. The second process
cannot start and exits non-zero, so the probe reports the _connection_ broken
while the server is up and serving the pooled client.

`mcpLivenessFailureStatus` (`plugin.ts:86-102`) then answers `degraded` for a
spawn failure or a timeout, and `use-connection-health.ts` re-probes every
non-healthy verdict on every mount with no freshness window — so each page load
spawns another child of a server that is already running. The badge goes amber
red, the next probe (once the pooled child is gone) says healthy: the
"local MCPs like Chrome show disconnected" flap.

This is the one root cause that needs no OAuth, no rotation and no second
instance — it reproduces in a single-process local app, which is where the
symptom was reported.

---

## 2b. Replication (done)

Four executable repros, each a pair: a **"documents current behavior"** test
that passes on main today (the replication) and a **REPRO** test asserting the
target behavior. Each REPRO test fails on main, so it is checked in **skipped**
and is the acceptance anchor for its phase — that PR un-skips it and it must go
green unedited.

`packages/core/sdk/src/oauth-expired-status-repro.test.ts`

```sh
cd packages/core/sdk && npx vitest run src/oauth-expired-status-repro.test.ts
#  3 passed | 3 skipped   (the skips are the REPRO targets)
#  un-skip one to see it fail: it asserts the post-fix contract
```

- **R1** — two executors, two root db handles, one SQLite db, one shared
  credential store, rotating test AS. A stalls after reading the stored refresh
  token, B wins and rotates it, A resumes and redeems the consumed token.
  Current behavior (passing test): `provider_state.oauthReauthRequiredAt` is
  recorded, `checkHealth` answers `expired` without probing, and after the next
  expiry **B cannot refresh either** — the AS receives zero further grants
  while the store still holds B's valid rotated token. REPRO fails on
  "a lost race must not record a dead grant".
- **R2** — the backing app's `token_url` is pointed at a fixture endpoint that
  answers the first refresh grant with `429 Too Many Requests` and forwards
  every later one to the real AS. Current behavior (passing test): one 429 ⇒
  `checkHealth` = `expired`, and the next call sends **no** grant even though
  the endpoint is healthy again. REPRO fails on "a 429 does not end the grant".
- **R3** — declared health check, long-lived token, upstream revokes it. The
  probe answers `expired` and persists it having sent **zero** refresh grants;
  the very next `execute` re-mints reactively, succeeds, and heal-on-use flips
  the row back to `healthy`. Same connection, seconds apart, no user action —
  the reported "disconnected, then connected". REPRO fails on "a refreshable
  revocation is not an expired connection".

`packages/plugins/mcp/src/sdk/mcp-liveness-second-spawn.test.ts` (+ the
`stdio-single-instance-test-server.ts` fixture, which refuses to start while a
live process holds its lock, exactly like Chrome DevTools MCP)

```sh
cd packages/plugins/mcp && npx vitest run src/sdk/mcp-liveness-second-spawn.test.ts
#  1 passed | 1 skipped
```

- **R8** — one instance is running and holding the lock. Current behavior
  (passing test): the health probe spawns a **second** child (proven from the
  fixture's spawn log), that child refuses to start, and the verdict for a
  live, serving server is `degraded`. REPRO fails on "a server that is up and
  serving reads healthy".

Both new files are lint-clean (`oxlint -c .oxlintrc.jsonc`), formatted
(`oxfmt`), and typecheck clean (`tsgo --noEmit`) in their packages.

**Which host sees what.** `apps/local` builds ONE executor over ONE SQLite
handle (`apps/local/src/executor.ts:212-233`, `createExecutorHandle`), so the
refresh gate does hold there: **R1 is cloud/multi-process only.** R3 and R8
reproduce in a single-process local app, which matches the reported symptom
(Linear flapping disconnected→connected; local MCPs like Chrome reading
disconnected). R2 needs only one instance and a transient 4xx, so it applies
everywhere.

---

## 3. Plan

Phases are ordered so each lands independently green
(`format:check`, `lint`, `typecheck`, `test`) and the bleeding stops first.

### Phase 0 — Reproduce and measure (DONE for the repros)

1. Landed as `packages/core/sdk/src/oauth-expired-status-repro.test.ts` and
   `packages/plugins/mcp/src/sdk/mcp-liveness-second-spawn.test.ts` (see §2b).
   Each "documents current behavior" test is the replication; each REPRO test
   is the acceptance anchor for its phase and stays red until that phase lands.
   The REPRO tests ship skipped; each fix PR un-skips its own.
   Note the existing two-instance test in `oauth-flow.test.ts` ("a refresher
   paused after reading the stored token never writes it back over a peer's
   rotated one") already builds this shape and asserts the _store_ survives —
   it never looks at the row, which is why R1 went unnoticed.
2. Add span attributes now so production can size the problem before we change
   it: `executor.oauth.refresh.race_suspected` (invalid_grant while the stored
   token differs from the one sent — read-only observation),
   `executor.oauth.dead_grant.status` (the HTTP status behind the rejection),
   `executor.health.source=credential_only` share. Query dead-grant counts per
   tenant/integration/reason from existing `executor.oauth.refresh.*` attrs.
3. Record the diagnosis in `MISTAKES.md` (AGENTS.md names it; the file does not
   exist yet — create it with this entry).

### Phase 1 — Stop bricking connections (R1 detection + R2 classification)

Small, reviewable, and it removes the permanent-damage path even before real
coordination exists.

1. **Rotation-aware `invalid_grant`** in `performTokenRefresh`: on rejection,
   re-read the row and the stored refresh item. If the stored value differs
   from the one we sent, a peer rotated it — do **not** mark dead; adopt the
   peer's access token (read the primary item) and return it. Span:
   `executor.oauth.refresh.outcome=adopted_peer_rotation`.
2. **Fingerprint + CAS on the dead-grant write.** Add
   `connection.refresh_token_fp` (SHA-256 prefix of the refresh token, never
   the token) written wherever the refresh item is written (the mint paths at
   `executor.ts:4509`, `:4565`, `:4729`, fed by
   `oauth-service.ts:2344-2430`; and `persistRefreshedToken`). `markRefreshGrantDead`
   becomes CAS-guarded on the observed `refresh_token_fp` + `updated_at`
   (same idiom as `persistHealthResult`; `updateMany` returns void, so
   write-then-re-read decides, and a lost CAS is a silent no-op). A peer's
   successful rotation now always beats a stale death certificate.
3. **Narrow `isPermanentTokenRejection`.** Definitive = §5.2 `invalid_grant`,
   or an unusable **JSON** 2xx token body carrying an error code. Retryable =
   408, 425, 429, 5xx, transport, non-JSON 2xx (challenge/portal pages).
   Other 4xx without a §5.2 code becomes a **strike**: record
   `oauthRefreshRejectCount`/`oauthRefreshRejectAt` in `provider_state` and
   mark dead on the second strike within a cooldown (e.g. 10 min). This keeps
   the Datadog fix (a truly dead grant stops hammering the AS after two
   attempts, not 100) without letting one WAF hiccup end a connection.
4. Tests: 429 / 5xx / transport / HTML-200 ⇒ no dead grant; two spaced 400s ⇒
   dead grant; single `invalid_grant` ⇒ dead grant immediately (existing
   `oauth-refresh-rejected*.test.ts` must stay green); loser-adopts-rotation
   from Phase 0's harness now asserts recovery.

### Phase 2 — Coordinated refresh across instances (R1 root fix)

Implement the coordination the `refreshGateFor` comment already prescribes, in
core so selfhost multi-process and cloud both get it.

1. **DB lease on the connection row**: `refresh_lease_owner`,
   `refresh_lease_expires_at` (short, e.g. 30s). Claim with a conditional
   `updateMany` (`lease_expires_at IS NULL OR < now`), then re-read to learn
   who won — `updateMany` gives no rowcount, so the re-read is the CAS.
2. Winner grants and persists; **losers wait bounded** (poll ~150 ms up to
   ~10 s for `expires_at`/`refresh_token_fp` to change) then adopt the stored
   access token. A lease that expires mid-grant degrades to today's behavior,
   and Phase 1's adoption path catches it.
3. Keep the in-process `WeakMap` gate as the fast path so one executor never
   pays a DB round trip for its own concurrency; the lease only arbitrates
   _between_ handles.
4. Same treatment for `healthProbeGateFor` (R7's probe-stampede half) — one
   lease, N readers adopt the persisted verdict.
5. Tests: two handles ⇒ exactly one grant at the AS (extend Phase 0 harness);
   lease expiry ⇒ no deadlock, bounded wait; a crashed winner ⇒ the loser
   proceeds after the lease lapses. e2e: `oauth-refresh-cross-instance.test.ts`
   (cloud + selfhost) modeled on `oauth-refresh-cross-session.test.ts` but
   driving two planes (an HTTP health probe racing an MCP tool call).

### Phase 3 — Make the probe tell the truth (R3, R6, R8)

1. **Reactive refresh in `connectionCheckHealth`**: when the probe answers 401
   (or plugin-equivalent auth wall), the connection is OAuth with a refresh
   token and no recorded dead grant ⇒ force one refresh and re-probe **once**;
   persist the second verdict. Span `executor.health.refresh_retried`. This is
   the single change that makes the badge agree with what the next tool call
   will do, and it is safe under Phase 2's lease.
2. **Scope-aware 403**: run `detectInsufficientScope` in the probe
   classification and emit a distinct outcome (`degraded` +
   `reason: insufficient_scope`, feeding the existing `missingOAuthScopes` /
   "Reconnect to grant access" UX) instead of red **Expired**.
3. **Narrow GraphQL's `isAuthMessage`**: require an auth signal _and_ a
   non-network reason; free-text "permission" alone stops meaning `expired`.
4. **MCP liveness must not dial a second connection (R8).** Take the pooled
   connection when one exists for that identity (`connection-pool.ts`) instead
   of `discoverToolsFromInput`'s fresh connector, so a probe of a stdio server
   does not spawn a second child of a single-instance process. Where a fresh
   dial is unavoidable, classify "another instance is already running" /
   spawn-because-locked as non-alarm (`unknown`, never `degraded`/`expired`):
   the server is up, the credential was never exercised. Add a floor to
   non-healthy revalidation in `use-connection-health.ts` (today it sends no
   `ifStaleMs` at all, so every mount of every surface re-probes — and for
   stdio, re-spawns).
5. Tests: probe-401-then-refresh-then-healthy persists `healthy`;
   null-expiry connection heals from a page load alone (today it needs a tool
   call); insufficient*scope renders the reconsent affordance, not Expired;
   the MCP liveness probe of a live single-instance stdio server answers
   healthy and spawns no second child (flip
   `mcp-liveness-second-spawn.test.ts`'s REPRO).
   e2e: `health-probe-refresh-recovery.test.ts`; keep
   `connection-health-verdict.test.ts` green (a \_refused* refresh still ends at
   `expired`, persisted, with the freshness window intact).

### Phase 4 — Honest verdicts and durable expiry (R4, R5)

1. **Preserve the advertised lifetime**: store the lifetime seen at mint (or
   any refresh) in `provider_state.oauthTokenLifetimeMs`; when a refresh
   response omits `expires_in`, derive `expires_at` from it instead of writing
   null. Null stays only for grants that were never advertised a lifetime.
2. **Evidence-tagged `healthy`**: the credential-only path keeps `healthy` when
   it actually refreshed (real evidence) and otherwise answers `unknown` with
   detail "Credential present; not verified against the upstream." Also let
   plugins that need no spec probe without one (MCP tool discovery), so fewer
   connections sit unverified. This changes
   `google-health-checks.test.ts:381` deliberately — call it out in the PR.
3. Decide the UX for `unknown`: grey dot, no alarm copy, and a "Check now"
   that probes for real (`health-display.ts` already keeps `unknown` neutral).

### Phase 5 — Recovery affordance and prevention (R2 aftermath, R7)

1. **"Retry refresh" next to Reconnect** on a dead grant: one re-armed attempt
   under the Phase 1 CAS (clears the marker only if the grant succeeds), so a
   spuriously bricked connection recovers without re-consent. Keep Reconnect as
   the primary action; keep the gate's "no probing while dead" rule for
   automatic surfaces — this is an explicit human action.
2. **Copy**: split "Token refresh was rejected — reconnect" from "Upstream
   rejected the credential" (`accounts-section.tsx:196`). Show the recorded
   reason and when.
3. **Skew**: `max(60s, 10% of the advertised lifetime)`, host-overridable.
4. **Optional, separate decision — background refresh cron** in cloud
   (`wrangler.jsonc` already runs a `* * * * *` cron): proactively refresh
   tokens for connections used in the last N days. It removes idle-lapse and
   makes one coordinated refresher the common path instead of N racing
   surfaces. Needs its own design note (cost, org scoping, WorkOS Vault QPS)
   — do not fold it into Phases 1-4.
5. **Alert** on dead-grant rate per tenant/integration and on
   `race_suspected`, so the next incident is a page rather than a support
   thread.

---

## 4. What must not regress

- The known-dead gate itself: a genuinely dead grant must stop generating
  refresh traffic after a bounded number of attempts and must present
  `expired` on every read (`connections.test.ts:2810`, `:2985`, `:3084`,
  `:3119`).
- Verdict writes stay best-effort and CAS-guarded; a dead grant recorded
  mid-probe still survives the probe's write.
- Reactive tool-call retry stays exactly one retry, 401-only, refresh-token
  holders only (`oauth-refresh-on-401.test.ts`).
- Single-flight refresh within one process (`oauth-refresh-cross-session.test.ts`).
- Interrupting a dial must still tear down the stdio child (`#1631`,
  `stdio-interrupt-cleanup.test.ts`): routing the liveness probe through the
  pool changes WHO owns the child, and the pooled child's lifetime is the
  pool's — a probe must not close a connection invocations still need, and an
  interrupted probe must not strand one.
- The store-writability probe before spending a single-use refresh token
  (`#1377`) — and note it writes an item per refresh that is never deleted;
  worth a cleanup task, not a blocker.
- Nothing secret-bearing in spans, health `detail`, or the new fingerprint
  column (hash only; `redactTokenEndpointBody`'s allowlist governs rendering).

## 5. Suggested PR boundaries

1. Phase 0 (tests + telemetry + MISTAKES entry) — no behavior change.
2. Phase 1.1-1.2 (rotation adoption + fingerprint CAS).
3. Phase 1.3 (classification narrowing + strikes).
4. Phase 2 (lease) — the largest; ship behind a config flag defaulting on, with
   the flag removed in a follow-up.
5. Phase 3 (probe refresh + scope-aware 403 + GraphQL narrowing + MCP liveness
   reusing the pool). R8 is independently shippable and is the one fix that
   addresses the reported local symptom on its own — it can lead Phase 3 or
   ship before it.
6. Phase 4, then Phase 5.

Each PR: narrowest meaningful vitest while iterating, one named e2e scenario
when the change is user-visible, `bun run format` before opening.
