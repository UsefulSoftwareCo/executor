# Deploying executor-cloud

executor-cloud deploys with an **upload then staged-promotion** flow, not an
immediate 100% cutover. This exists because every full deploy restarts all
Durable Objects, and the MCP session DOs (`McpSessionDOSqlite`) hold live
streaming sessions: a cutover mid-call drops in-flight MCP tool results. Staging
the promotion bounds that blast radius and keeps a mere merge from disrupting
anything.

The mechanics below were validated empirically on a throwaway staging worker
that mounted the real session DO and patched transport with stub auth; the
"what happens" claims are measured, not assumed. The findings are summarized
at the end.

## The flow

1. **Merge to main** runs `.github/workflows/deploy.yml` (`push` trigger only):
   - `migrate` applies database migrations.
   - `upload-cloud` runs `wrangler versions upload`. This creates a new Worker
     **version** but routes **no traffic** to it. No DOs restart; live MCP
     sessions keep running. This is safe to do on every merge.
   - `deploy-marketing` deploys the marketing worker (unchanged behaviour).
   - Note the uploaded **version id** from the `upload-cloud` job log (or run
     `wrangler versions list`): you promote it by id below.
2. **Promotion is a separate, deliberate, DECOUPLED step.** Run the Deploy
   workflow via **workflow_dispatch** with two inputs:
   - `promote_percent` (1-100): the traffic percentage for this step.
   - `promote_version`: the **version id** to promote (required). Use the
     literal `latest` only for "promote what I just merged"; for advancing an
     existing canary always pass the **same version id** you canaried, so you
     widen that reviewed version rather than something newer.

   A promote-only dispatch runs **only** the `promote-cloud` job: it does **not**
   re-run `migrate` or `upload-cloud`, so it never builds a new version. The job
   promotes `promote_version` to `promote_percent` of traffic
   (`scripts/promote-cloud.ts`, which calls `wrangler versions deploy`).

   Canary walk for one version `V`:
   - dispatch `promote_percent=10`, `promote_version=V` (10% on `V`);
   - watch telemetry;
   - dispatch `promote_percent=50`, `promote_version=V` (widen the **same** `V`);
   - dispatch `promote_percent=100`, `promote_version=V` (full cutover).

   Merges that land **after** you start a canary upload their own versions but do
   **not** get promoted until you dispatch with **their** id: advancing `V` never
   silently ships unreviewed code.

### Promoting from the CLI (manual, out of band)

From `apps/cloud`, against the generated build config. `--version` is required;
it is either an explicit version id or the literal `latest`:

```bash
bun run build
wrangler versions list -c dist/server/wrangler.json    # find the version id
# Canary: version <id> at 10%, current-live at 90%.
bun run scripts/promote-cloud.ts --percent 10 --version <id>
# Advance (same version id):
bun run scripts/promote-cloud.ts --percent 50 --version <id>
# Full cutover (same version id):
bun run scripts/promote-cloud.ts --percent 100 --version <id>
# Or, right after a merge, promote the most recent upload explicitly:
bun run scripts/promote-cloud.ts --percent 10 --version latest
```

The script promotes exactly the version you name (`latest` resolves to the
highest version number) and holds the remainder of a partial promotion on the
current-live version. It refuses to run unless the resolved wrangler config
targets the `executor-cloud` worker (set `PROMOTE_CLOUD_ALLOW_NAME` to override
for a non-production worker).

## Session version-affinity (zone ruleset, MUST be configured manually)

During a gradual rollout the **stateless front worker** and the **session DO**
can run different versions. DOs are natively version-pinned (a DO keeps its
assigned version for the deployment), but the front worker is not: without
affinity, consecutive requests for one MCP session hash to different worker
versions, so a request can hit a worker version that differs from its DO's
version (measured: a v2 front worker talking to a v3 DO).

Cloudflare routes a request to a specific version when the
`Cloudflare-Workers-Version-Key` header is set: the same key value always maps
to the same version for the life of a gradual deployment. We set that key from
the **MCP session id** so every request for one session sticks to one worker
version.

This is a **zone-level request-header-transform rule on `executor.sh`** and
cannot be set from the repo. Create it in the Cloudflare dashboard (Rules ->
Transform Rules -> Modify Request Header, or the Rulesets API, phase
`http_request_late_transform`) that copies the `mcp-session-id` request header
into `Cloudflare-Workers-Version-Key`. The exact rule:

```
# When: /mcp requests that carry a session id.
(http.request.uri.path wildcard "/mcp*" and len(http.request.headers["mcp-session-id"]) > 0)

# Action: Set static / dynamic request header
#   Header name:  Cloudflare-Workers-Version-Key
#   Value (dynamic expression):  http.request.headers["mcp-session-id"][0]
```

Requests without the header (e.g. the initial `initialize` that mints the
session) fall back to normal weighted routing, which is correct: there is no
session to pin yet. Once the client echoes `mcp-session-id`, every subsequent
request for that session is version-pinned to the worker version its DO landed
on.

Validated on the staging worker by sending `Cloudflare-Workers-Version-Key`
directly (12 requests per key across a 4-key set during a two-version gradual
deployment): each distinct key deterministically mapped to exactly one version
across all its requests, while unkeyed requests split across versions per the
weighted split. In production the header-transform rule sets the key from the
session id so clients never send it themselves.

## Durable Object migrations deploy separately

DO class migrations (the `migrations` array in `wrangler.jsonc`: `new_classes`,
`new_sqlite_classes`, renames, deletes) take effect when a version carrying them
is **promoted**, not merely uploaded, and Cloudflare validates a DO delete
against the live binding. Policy:

- Never combine a DO class change with a risky app change in one version you
  intend to canary slowly: a DO migration wants a clean promotion.
- To delete an orphaned DO class, promote a version that still exports it as a
  stub first (nothing binds it), then delete it in a **later** version. This is
  already how `McpSessionDO` (KV) was retired in favour of the SQLite class.

## Rollback

Roll back by promoting the previous-good version to 100%:

```bash
wrangler versions list -c dist/server/wrangler.json    # find the good version id
wrangler versions deploy -c dist/server/wrangler.json <good-version-id>@100% --yes
```

Constraints:

- **Rollback takes effect fast and the session survives.** Measured: promoting
  the previous version back to 100% took effect within seconds (all subsequent
  requests served by the rolled-back version), and a session that existed before
  the rollback still worked afterwards, its `tools/list` returned 200 and its DO
  storage was intact. As with any promotion, a call in flight at the instant of
  the rollback is lost (the DO whose pinned version changes restarts), but the
  session id and its persisted state carry across.
- **Migrations can block a rollback.** A version cannot be promoted if its DO
  migration state is behind the account's applied migrations (you cannot
  "un-create" a DO class by rolling back). If a release included a DO migration,
  rolling back to a pre-migration version may be refused; roll forward with a
  fix instead.

## What the staged flow does and does not fix

Measured on the staging worker:

- **Fixed, merges no longer disrupt anything.** `wrangler versions upload` does
  not restart DOs; a session opened before an upload runs straight through it.
  Measured: an upload fired mid-call (mid a ~30s in-flight tool call) caused
  zero disruption, the call's result marker was delivered normally. Most CI
  runs now upload only.
- **Fixed, staged blast radius.** A gradual promotion only restarts the DOs
  whose sessions land on the newly promoted version at each step, instead of all
  DOs at once.
- **Fixed, no mid-session worker/DO version skew** once the affinity ruleset is
  in place: the front worker matches the session's DO version for the rollout
  window.
- **Not fixed yet, the promotion itself still restarts DOs whose pinned version
  changes.** Promoting a new version to traffic moves those DOs' version and
  restarts them, so an in-flight call at the moment of promotion is still lost
  (same shape as the old cutover, but now scoped to the promoted slice, not
  everyone). Measured: a `versions deploy new@100` fired mid-call ended the
  in-flight stream with no result. Eliminating this needs durable-pause work on
  the DO and is out of scope here.
- **The session outlives a promotion even though the in-flight call does not.**
  Measured across the version swap: the session id stayed valid, the persisted
  event store survived the swap intact, and a reconnect GET replayed the prior
  events across the version boundary (older-version events replayed correctly on
  the newer version). So a client that reconnects recovers its stream, it just
  has to re-issue the one call that was in flight at the instant of promotion.
  This is why promotion is the **only** disruptive moment: uploads are free,
  and even a promotion loses only the single in-flight call, not the session or
  its history.

## Re-validating the mechanics

The measurements above came from a throwaway staging worker (a cut-down worker
mounting the real `McpAgentSessionDOBase` + the patched `agents` transport with
stub auth and a trivial `execute` tool, deployed to a `workers.dev` subdomain,
never routed). To re-validate after a Cloudflare behavior change, rebuild the
same shape: exercise affinity with `Cloudflare-Workers-Version-Key` across a
two-version gradual deployment, fire an upload and a promotion mid-call, and
roll back mid-session. Keep any such worker on `workers.dev` only and delete it
when done.
