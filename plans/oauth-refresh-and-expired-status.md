# The wrong Expired status: analysis and plan

Status: the analysis is complete and the plan is proposed. This branch adds
tests and this document. It does not change runtime behavior.

## The problem

Connections show the health status **Expired**. The status is sometimes wrong.
The status is sometimes permanent. Token refresh also gives the impression that
nothing coordinates it. These two problems have one origin. The health status
and the refresh mechanism do not agree on what counts as evidence. One defect
in the refresh mechanism also produces the wrong status.

All citations in this document refer to `main` at commit `a72e51d13`.

## Terms

This document uses one term for one concept.

- **Connection**: one stored credential, identified by owner, integration, and
  name.
- **Health status**: the value in `connection.last_health`. The values are
  `healthy`, `expired`, `degraded`, `misconfigured`, and `unknown`.
- **Probe**: one run of an integration's health check against the upstream.
- **Refresh grant**: one request to the authorization server (AS) for a new
  access token.
- **Permanent rejection record**: the object
  `provider_state.oauthReauthRequiredAt`. The system writes it when it decides
  that a refresh token is permanently rejected.
- **Instance**: one executor with its own root database handle. Two instances
  can run in one process or in two processes.

---

## 1. How the health status and the token refresh work today

### Refresh triggers

The code is in `packages/core/sdk/src/executor.ts`.

- **Proactive.** `resolveConnectionValues` (:2998) refreshes the token when
  `shouldRefreshToken({ expiresAt })` returns true. That function
  (`oauth-helpers.ts:1726`) compares `expires_at` with the current time plus a
  60 second skew (`OAUTH2_REFRESH_SKEW_MS = 60_000`). A null `expires_at`
  never starts a proactive refresh. This is deliberate.
- **Reactive.** `executor.execute` retries one time when a tool call receives a
  401 response. It calls `forceRefreshConnectionValues` (:3049). The call site
  is :6642-6674.
- **Deduplication.** `refreshInFlight` is a `WeakMap` (:264, :1986-1990). The
  key is the root database handle object. The documentation of that map states
  the limit: deduplication reaches only as far as one root database handle in
  one process. It states that multi-instance deployments are outside that
  limit. It recommends coordination in the database with a compare-and-set on
  the stored refresh token.
- **Failure.** A definitive rejection calls `markRefreshGrantDead` (:2294).
  That function writes the permanent rejection record and an `expired` health
  status.

### The permanent rejection record

The record is permanent. Every read derives the status from it.

- `performTokenRefresh` does not send the grant (:2600-2630).
- `connectionCheckHealth` does not probe. It answers `deadGrantVerdict`
  (:5186-5195). This includes the manual "Check now" action.
- `presentedLastHealth` (:1118) derives `expired` on every API read. No writer
  can replace it. `healPersistedHealthOnUse` (:4966) stops when it sees the
  record.
- Only a reconnect removes it. A reconnect writes a new `provider_state`
  object.

This gate is deliberate and it has a reason. One incident produced more than
100 identical rejections in two days (the comment at :2600). Two e2e scenarios
pin the behavior: `e2e/scenarios/connection-health-verdict.test.ts` and
`e2e/selfhost/mcp-oauth-reconnect-health.test.ts`. **This plan keeps the gate.**
The plan changes what writes the record and how much evidence the system needs
before it writes it.

---

## 2. Causes in rank order

### R1 — The refresh gate does not work in the cloud app, and the losing instance makes a valid connection permanently Expired (severity: critical)

`apps/cloud/src/api/protected.ts:110-121` and
`apps/cloud/src/api/layers.ts:38-46` rebuild `DbService` for each request.
Cloudflare Workers forbids one I/O object in two request handlers.
`cloudDbProviderLayer` then rebuilds the fuma client from that service
(`apps/cloud/src/db/fuma.ts:56-73`). Each request therefore gets a new database
object. A new database object gets a new `WeakMap` entry. The gate is empty for
every request in the HTTP plane. The MCP plane is per session:
`session-durable-object.ts:156-160` builds one handle for each Durable Object.
Two sessions do not share a gate. One session and one HTTP request do not share
a gate.

The consequence follows when the AS rotates refresh tokens. Rotation is the
normal case. The test AS in this repository rotates
(`packages/core/sdk/src/testing/oauth-test-server.ts:876-887`).

1. Instance A and instance B both read the refresh token `R1`. Both send a
   refresh grant.
2. Instance A receives the answer first. It stores `R2` and a new access
   token. It updates `expires_at`.
3. Instance B receives `invalid_grant` because the AS consumed `R1`. It calls
   `markRefreshGrantDead`. It writes the permanent rejection record.
4. `markRefreshGrantDead` (:2294-2336) is an unconditional `updateMany`. It has
   no compare-and-set. Compare this with `persistHealthResult` (:4917-4936),
   which uses `updated_at` and `tools_synced_at` as the compare-and-set. No
   code examines whether the token that the instance sent is still the token on
   the row. `persistRefreshedToken` (:2363) does not remove the record.

The result is this: **a connection that holds a valid rotated refresh token
shows `expired` forever.** Every surface shows it. No probe and no tool call
can change it. Only a human re-consent removes it. There is a second risk. Some
providers treat token reuse as theft and revoke the whole token family. The
race can then destroy the grant.

Many surfaces can start the race. At the moment a token becomes due, each
concurrent surface refreshes it. These surfaces exist: parallel tool calls in
two sessions, a background tool sync (`#2028`), a browser tab that loads the
accounts page (`use-connection-health.ts` sends no freshness window for a
non-healthy status), and the catalog sync after an OAuth callback.

### R2 — One 4xx response is enough to declare a grant permanently rejected (severity: high)

The classifier is in `oauth-helpers.ts:73-91`:

```ts
isUnusableSuccessTokenResponse = (e) => e.status !== undefined && e.status < 300;
isPermanentTokenRejection = (e) =>
  isUnusableSuccessTokenResponse(e) || (e.status >= 400 && e.status < 500);
```

`executor.ts:2858-2872` maps that result directly to `reauthRequired: true` and
then to the permanent rejection record. These temporary or unclear results
therefore end a connection permanently:

- **429.** The token endpoint limits the request rate. This is likely when R1
  makes the system send duplicate grants. It is also likely during an incident
  at the AS. 429 is in the range 400 to 499.
- **408, 425, a proxy or WAF 403, a 404 HTML page, a CDN edge error.**
- **A 2xx response that is not a token response.** Examples are a
  captive-portal page and an HTML 200 response from a wrong origin. The
  condition `status < 300` is true, so the system writes the record.

The §5.2 `invalid_grant` path (:2833-2857) is definitive. It should stay a
one-shot decision. Every other case is an inference from an HTTP status code.
Those cases need a second confirmation.

### R3 — The probe does not refresh, so it reports `expired` for a connection that works (severity: high)

`connectionCheckHealth` (:5240-5280) resolves the credential and gives it to
the plugin probe. Resolution performs the proactive refresh only. A 401
response becomes `expired` through `classifyHttpStatus`
(`health-check.ts:208-213`) and the system persists that status. There is no
forced refresh and no second probe. `executor.execute` has both.

The affected cases are exactly the cases that the reactive path exists for.
They are: a server-side revocation, an identity provider idle timeout that is
shorter than the advertised lifetime, and a null `expires_at` because the AS
omitted `expires_in` (`oauth-flow.test.ts:2508` records five such rows in
production). In these cases one page load writes `expired`. The indicator turns
red. The status changes to `healthy` only when the user calls a tool, because
`healPersistedHealthOnUse` (:4966) then runs. The user sees a connection that
does not work, and that connection would refresh correctly on the next call.

### R4 — The system reports `healthy` without evidence (severity: medium)

An OAuth connection on an integration with no declared `health_check` spec does
not probe. The branch at :5242-5250 selects
`oauthCredentialHealthWithoutProbe` (:5045-5056). The result is
`{ status: "healthy", detail: "Credential resolved (no probe configured)." }`.
The system persists it. A persisted healthy status then suppresses
revalidation for five minutes (`HEALTH_REVALIDATE_MS` in
`use-connection-health.ts`). Reading a token from the credential store says
nothing about the upstream.
`e2e/scenarios/google-health-checks.test.ts:381` pins this behavior, so it is
intentional. It is still the opposite error to R3: the same indicator is
wrongly red in one case and wrongly green in the other. This branch also skips
plugins that could probe without a spec. The MCP `checkHealth` ignores `spec`
and discovers tools (`packages/plugins/mcp/src/sdk/plugin.ts:1941-1981`).

### R5 — A refresh response without `expires_in` erases the expiry (severity: medium)

`persistRefreshedToken` (:2386-2390) sets `expires_at` to
`now + expires_in * 1000` when the response has `expires_in`, and to null when
it does not. RFC 6749 makes `expires_in` optional. An AS that sends a lifetime
in the code exchange but omits it in the refresh response therefore sets
`expires_at` to null after the first refresh. Proactive refresh can then never
run again. Every later call receives a 401 and pays a reactive refresh. R3 then
turns each of those calls into a red indicator between uses.

### R6 — A scope shortfall and a text match report `expired` (severity: medium)

- `classifyHttpStatus` maps a 403 response to `expired`. The invoke path
  already distinguishes this case: `detectInsufficientScope`
  (`packages/core/sdk/src/insufficient-scope.ts`) detects RFC 6750
  `insufficient_scope` and the Google `ACCESS_TOKEN_SCOPE_INSUFFICIENT` error.
  `packages/plugins/openapi/src/sdk/backing.ts:777-800` uses it. The probe path
  carves out only the Google configuration 403 (`health-check.ts:250-257`). A
  connection with too few scopes therefore shows red **Expired** and the text
  "reconnect to restore access". The correct remedy is a new consent. The row
  already carries `missingOAuthScopes`.
- The GraphQL plugin classifies free text.
  `packages/plugins/graphql/src/sdk/plugin.ts:118-121` reports `expired` for an
  upstream message that matches
  `/permission|credential|api.?key|sign in/i`. An unrelated error in a 200
  response body can match that pattern.

### R7 — The skew is 60 seconds and no background refresh exists (severity: low)

`OAUTH2_REFRESH_SKEW_MS = 60_000` is short next to a 20 second token request
timeout and an agent turn that can run for minutes. Refresh happens only at
call time. An idle connection can therefore lose its grant, because many
authorization servers expire a refresh token after a period of inactivity. One
more fact is relevant: the health probe gate uses the same per-request key as
the refresh gate. The statement in `connections/api.ts:244-246` — that open
tabs cannot stampede an upstream — is therefore not true in the cloud app.

### R8 — The MCP probe makes a second connection, so a single-instance local server fails its own health check (severity: high, local)

`checkHealth` in `packages/plugins/mcp/src/sdk/plugin.ts:1972-1994` builds a new
connector and calls `discoverToolsFromInput`. That function creates a new
connection (`discover.ts:142`, then `createMcpConnector`) with a 15 second
deadline. It does not use the pooled connection that tool calls use
(`connection-pool.ts` keeps one idle session per identity for five minutes;
`invoke.ts:468-478` takes it). For a remote server this costs one handshake.
**For a local stdio server it starts a second child process.** The common local
servers permit one instance only. Chrome DevTools MCP owns a browser and a debug
port. Playwright MCP does the same. `docker run -i` owns a container. The second
process cannot start and exits with a non-zero code. The probe then reports that
the connection does not work, while the server runs and serves the pooled
client.

`mcpLivenessFailureStatus` (`plugin.ts:86-102`) answers `degraded` for a failed
spawn and for a timeout. `use-connection-health.ts` then probes again on every
mount for a non-healthy status, with no freshness window. Each page load
therefore starts one more child process of a server that already runs. The
indicator turns amber. The next probe runs after the pooled child is gone and
reports `healthy`. This is the reported change between disconnected and
connected for local MCP servers.

This cause needs no OAuth, no token rotation, and no second instance. It
reproduces in a single-process local app. That is where the user reported the
symptom.

---

## 3. Replication

Four causes have executable tests. Each cause has two tests. The first test
shows the behavior on `main` today and passes. The second test gives the
required behavior after the fix and fails on `main`. The test suite therefore
skips the second test. The pull request that makes the fix removes the skip.
The test must then pass without changes.

### The OAuth and health tests

File: `packages/core/sdk/src/oauth-expired-status-repro.test.ts`.

```sh
cd packages/core/sdk && npx vitest run src/oauth-expired-status-repro.test.ts
#  3 passed | 3 skipped   (the skipped tests are the fix targets)
#  Remove one skip to see that test fail on main.
```

- **R1.** The test makes two executors with two root database handles over one
  SQLite database and one shared credential store. The test AS rotates refresh
  tokens. Instance A stops after it reads the stored refresh token. Instance B
  completes a refresh and rotates the token. Instance A then sends the consumed
  token. The passing test shows this behavior: the system writes
  `provider_state.oauthReauthRequiredAt`; `checkHealth` answers `expired`
  without a probe; after the next expiry instance B cannot refresh; the AS
  receives zero further grants, although the store holds the valid rotated
  token of instance B. The skipped test fails on the assertion "a lost race
  must not record a dead grant".
- **R2.** The test points the `token_url` of the backing app at a fixture
  endpoint. That endpoint answers the first refresh grant with
  `429 Too Many Requests` and forwards every later grant to the real AS. The
  passing test shows this behavior: one 429 gives `expired` from `checkHealth`,
  and the next call sends no grant, although the endpoint is healthy again. The
  skipped test fails on the assertion "a 429 does not end the grant".
- **R3.** The test declares a health check, uses a long-lived token, and then
  revokes that token at the upstream. The passing test shows this behavior: the
  probe answers `expired` and persists it after zero refresh grants; the next
  `execute` refreshes, succeeds, and writes `healthy` to the same row. The
  skipped test fails on the assertion "a refreshable revocation is not an
  expired connection".

### The MCP test

Files: `packages/plugins/mcp/src/sdk/mcp-liveness-second-spawn.test.ts` and the
fixture `stdio-single-instance-test-server.ts`. The fixture does not start
while a live process holds its lock. Chrome DevTools MCP has the same shape.

```sh
cd packages/plugins/mcp && npx vitest run src/sdk/mcp-liveness-second-spawn.test.ts
#  1 passed | 1 skipped
```

- **R8.** One instance runs and holds the lock. The passing test shows this
  behavior: the probe starts a second child process, and the spawn log of the
  fixture proves it; the second process does not start; the probe answers
  `degraded` for a server that runs and serves requests. The skipped test fails
  on the assertion "a server that is up and serving reads healthy".

### Quality gates for the new files

Both new test files and the fixture pass `oxlint -c .oxlintrc.jsonc`, pass
`oxfmt`, and give no `tsgo --noEmit` errors in their packages.

### Which host shows which cause

`apps/local` builds one executor over one SQLite handle
(`apps/local/src/executor.ts:212-233`, `createExecutorHandle`). The in-process
refresh gate therefore works in the local app. **R1 occurs in the cloud app and
in multi-process self-hosting only.** R3 and R8 reproduce in a single-process
local app. These two causes match the reported symptoms: an OAuth integration
that changes between disconnected and connected, and local MCP servers that
read as disconnected. R2 needs one instance and one temporary 4xx response, so
it applies to all hosts.

---

## 4. Plan

The phases are in this order for two reasons. Each phase lands independently
with `format:check`, `lint`, `typecheck`, and `test` green. The phases that
stop permanent damage come first.

### Phase 0 — Reproduce and measure

The tests are complete. Two tasks remain.

1. Add span attributes so production data shows the size of the problem before
   the fix. Add `executor.oauth.refresh.race_suspected` for an `invalid_grant`
   where the stored token differs from the token that the instance sent. This
   attribute is an observation only. Add
   `executor.oauth.dead_grant.status` for the HTTP status behind a rejection.
   Record the share of `executor.health.source=credential_only`. Then query the
   number of permanent rejection records per tenant, integration, and reason
   from the existing `executor.oauth.refresh.*` attributes.
2. Record this diagnosis in `MISTAKES.md`. `AGENTS.md` names that file, and the
   file does not exist yet. Create it with this entry.

Note one fact about the existing coverage. The two-instance test in
`oauth-flow.test.ts` ("a refresher paused after reading the stored token never
writes it back over a peer's rotated one") already builds this deployment
shape. It examines the credential store. It does not examine the connection
row. That is the reason nobody found R1.

### Phase 1 — Stop the permanent damage (R1 detection and R2 classification)

This phase is small and easy to review. It removes the permanent damage before
the coordination of Phase 2 exists.

1. **Detect the rotation before the system writes the record.** In
   `performTokenRefresh`, read the row and the stored refresh item again after
   a rejection. Compare the stored value with the value that the instance sent.
   A difference means that another instance rotated the token. Do not write the
   permanent rejection record in that case. Read the primary item and return
   the access token of the other instance. Add the span attribute
   `executor.oauth.refresh.outcome=adopted_peer_rotation`.
2. **Add a fingerprint and a compare-and-set to the record write.** Add the
   column `connection.refresh_token_fp`. Store a SHA-256 prefix of the refresh
   token. Never store the token. Write the fingerprint everywhere the system
   writes the refresh item: the mint paths at `executor.ts:4509`, `:4565`, and
   `:4729`, which `oauth-service.ts:2344-2430` feeds, and
   `persistRefreshedToken`. Then guard `markRefreshGrantDead` with a
   compare-and-set on the observed `refresh_token_fp` and `updated_at`. Use the
   same idiom as `persistHealthResult`. `updateMany` gives no row count, so
   write first and read again to decide. A lost compare-and-set does nothing.
   A successful rotation by another instance then always wins against an old
   rejection.
3. **Narrow `isPermanentTokenRejection`.** Treat these cases as definitive: a
   §5.2 `invalid_grant`, and an unusable 2xx response with a JSON token body
   that carries an error code. Treat these cases as retryable: 408, 425, 429,
   any 5xx, a transport failure, and a non-JSON 2xx response such as a
   challenge or portal page. Treat every other 4xx without a §5.2 code as one
   strike. Record `oauthRefreshRejectCount` and `oauthRefreshRejectAt` in
   `provider_state`. Write the permanent rejection record on the second strike
   inside a cooldown period, for example ten minutes. This keeps the benefit of
   the existing gate: a truly rejected grant stops sending requests after two
   attempts and not after 100. It removes the risk that one wrong answer from a
   proxy ends a connection.
4. Add these tests: a 429, a 5xx, a transport failure, and an HTML 200 give no
   record; two 400 responses with a gap give the record; one `invalid_grant`
   gives the record immediately; the existing `oauth-refresh-rejected*.test.ts`
   files stay green; the losing instance in the Phase 0 harness recovers.

### Phase 2 — Coordinate the refresh between instances (the R1 fix)

Implement the coordination that the `refreshGateFor` documentation recommends.
Put it in core so that multi-process self-hosting and the cloud app both get
it.

1. **Add a lease to the connection row.** Add `refresh_lease_owner` and
   `refresh_lease_expires_at`. Use a short lease, for example 30 seconds.
   Claim the lease with a conditional `updateMany` where the condition is
   `lease_expires_at IS NULL OR lease_expires_at < now`. Then read the row
   again to learn which instance won. `updateMany` gives no row count, so the
   second read is the compare-and-set.
2. **The winner sends the grant and persists the result.** The losers wait for
   a bounded time. Poll approximately every 150 ms for a maximum of
   approximately ten seconds, and examine `expires_at` and `refresh_token_fp`
   for a change. Then read the stored access token and use it. A lease that
   expires during a grant gives the behavior of today, and the adoption path of
   Phase 1 handles that case.
3. **Keep the in-process `WeakMap` gate as the fast path.** One executor then
   never pays a database round trip for its own concurrency. The lease
   arbitrates between handles only.
4. **Apply the same design to `healthProbeGateFor`.** This fixes the probe half
   of R7. One probe runs, and all readers use the persisted status.
5. Add these tests: two handles give exactly one grant at the AS, with the
   Phase 0 harness extended; an expired lease gives no deadlock and a bounded
   wait; a winner that crashes lets the loser continue after the lease ends.
   Add the e2e scenario `oauth-refresh-cross-instance.test.ts` for the cloud
   and self-hosting targets. Model it on `oauth-refresh-cross-session.test.ts`
   but drive two planes: one HTTP health probe and one MCP tool call at the
   same time.

### Phase 3 — Make the probe report the truth (R3, R6, R8)

1. **Add a reactive refresh to `connectionCheckHealth`.** Act when all these
   conditions are true: the probe answers 401 or the plugin equivalent; the
   connection is OAuth; the connection has a refresh token; no permanent
   rejection record exists. Then force one refresh and probe one more time.
   Persist the second status. Add the span attribute
   `executor.health.refresh_retried`. This change makes the indicator agree
   with the next tool call. The lease of Phase 2 makes it safe.
2. **Detect a scope shortfall in a 403.** Run `detectInsufficientScope` in the
   probe classification. Report a distinct result: `degraded` with
   `reason: insufficient_scope`. Feed the existing `missingOAuthScopes`
   mechanism and the "Reconnect to grant access" interface. Do not report red
   **Expired**.
3. **Narrow the GraphQL `isAuthMessage` match.** Require an authentication
   signal and a reason that is not a network reason. The single word
   "permission" in free text must not give `expired`.
4. **Stop the second MCP connection (R8).** Use the pooled connection when one
   exists for that identity (`connection-pool.ts`) instead of the new connector
   in `discoverToolsFromInput`. A probe of a stdio server then does not start a
   second child of a single-instance process. When a new connection is
   unavoidable, classify "another instance already runs" as a neutral result.
   Report `unknown`. Never report `degraded` or `expired`, because the server
   runs and the probe never exercised the credential. Add a minimum interval to
   the non-healthy revalidation in `use-connection-health.ts`. Today that code
   sends no `ifStaleMs`, so every mount of every surface probes again, and for
   stdio it starts another child process.
5. Add these tests: a probe that receives a 401, then refreshes, then receives
   a healthy answer persists `healthy`; a connection with a null expiry
   recovers from a page load alone, which needs a tool call today; an
   insufficient scope shows the new-consent interface and not Expired; the MCP
   probe of a live single-instance stdio server answers healthy and starts no
   second child, which removes the skip from
   `mcp-liveness-second-spawn.test.ts`. Add the e2e scenario
   `health-probe-refresh-recovery.test.ts`. Keep
   `connection-health-verdict.test.ts` green: a refused refresh still ends at
   `expired`, persisted, with the freshness window intact.

### Phase 4 — Honest status values and a durable expiry (R4, R5)

1. **Keep the advertised lifetime.** Store the lifetime that the mint or any
   refresh reported in `provider_state.oauthTokenLifetimeMs`. When a refresh
   response omits `expires_in`, derive `expires_at` from that stored lifetime
   instead of writing null. Write null only for a grant that never advertised a
   lifetime.
2. **Require evidence for `healthy`.** The credential-only path keeps `healthy`
   when it performed a refresh, because that is evidence. Otherwise it answers
   `unknown` with the detail "Credential present; not verified against the
   upstream." Also let plugins that need no spec probe without one, for example
   MCP tool discovery. Fewer connections then stay unverified. This changes
   `google-health-checks.test.ts:381` on purpose. State that in the pull
   request.
3. Decide the interface for `unknown`. Use a grey indicator, no alarm text, and
   a "Check now" action that performs a real probe. `health-display.ts` already
   treats `unknown` as neutral.

### Phase 5 — Recovery for the user and prevention for the system (R2 result, R7)

1. **Add a "Retry refresh" action next to Reconnect** for a connection with a
   permanent rejection record. The action performs one new attempt under the
   compare-and-set of Phase 1. It removes the record only when the grant
   succeeds. A connection that received a wrong record then recovers without a
   new consent. Keep Reconnect as the primary action. Keep the rule "no probe
   while the record exists" for automatic surfaces, because this action is an
   explicit human action.
2. **Separate the messages.** Distinguish "Token refresh was rejected —
   reconnect" from "Upstream rejected the credential"
   (`accounts-section.tsx:196`). Show the recorded reason and its time.
3. **Increase the skew.** Use `max(60s, 10% of the advertised lifetime)`. Let
   the host override it.
4. **Consider a background refresh cron in the cloud app.** This is a separate
   decision and needs its own design note. `wrangler.jsonc` already runs a
   `* * * * *` cron. The cron would refresh the tokens of connections that were
   used in the last N days. It would remove idle lapse. It would also make one
   coordinated refresher the normal path instead of many racing surfaces. The
   design note must give the cost, the organization scope, and the WorkOS Vault
   request rate. Do not add this work to Phases 1 to 4.
5. **Add alerts.** Alert on the rate of permanent rejection records per tenant
   and integration, and on `race_suspected`. The next incident should start with
   an alert and not with a support message.

---

## 5. Invariants to preserve

- The gate itself. A truly rejected grant must stop refresh traffic after a
  bounded number of attempts and must show `expired` on every read
  (`connections.test.ts:2810`, `:2985`, `:3084`, `:3119`).
- Status writes stay best effort and keep their compare-and-set. A permanent
  rejection record that lands during a probe still survives the write of that
  probe.
- The reactive tool call retry stays at one retry, for 401 responses only, for
  connections with a refresh token only (`oauth-refresh-on-401.test.ts`).
- One refresh at a time inside one process
  (`oauth-refresh-cross-session.test.ts`).
- An interrupted connection attempt must still stop the stdio child process
  (`#1631`, `stdio-interrupt-cleanup.test.ts`). Routing the probe through the
  pool changes which component owns the child. The pool owns the lifetime of a
  pooled child. A probe must not close a connection that tool calls still need.
  An interrupted probe must not leave a child process running.
- The store-writability probe before the system spends a single-use refresh
  token (`#1377`). Note one defect: that probe writes one item per refresh and
  never deletes it. Track it as a cleanup task. It does not block this plan.
- No secret material in spans, in the health `detail`, or in the new
  fingerprint column. Store a hash only. The allowlist in
  `redactTokenEndpointBody` governs what the system renders.

## 6. Pull request boundaries

1. Phase 0: the tests, the telemetry attributes, and the `MISTAKES.md` entry.
   No behavior change.
2. Phase 1 items 1 and 2: rotation detection, and the fingerprint with its
   compare-and-set.
3. Phase 1 item 3: the narrow classification and the strikes.
4. Phase 2: the lease. This is the largest change. Put it behind a
   configuration flag that is on by default, and remove the flag in a later
   pull request.
5. Phase 3: the probe refresh, the scope-aware 403, the narrow GraphQL match,
   and the pooled MCP probe. R8 can ship on its own. It is the only fix that
   addresses the reported local symptom without other changes, and it does not
   change OAuth code. It can lead Phase 3 or ship before it.
6. Phase 4, then Phase 5.

For each pull request: run the narrowest meaningful vitest selection while you
iterate; add one named e2e scenario when the change is user-visible; run
`bun run format` before you open it.
