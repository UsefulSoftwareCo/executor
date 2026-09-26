# Benchmarks

`run-discovery.ts` is the original 1/8/24-app discovery comparison. `run-perf.ts` is the general
performance harness: perf stages, synthetic upstreams, production-shaped seeding, named scenarios,
interleaved before/after runs and flamecharts. Both use public product APIs only.

Credentials come from the staging launcher; never pass them as arguments:

```sh
L="agent-vault run --env-file $HOME/agent-workspace/executor-next/.env.test-stage.op --"
P="node e2e/benchmarks/run-perf.ts"
E=$HOME/agent-workspace/.perf-0925/<key>   # private evidence directory, outside the repo
```

## 1. Stage

```sh
$L $P stage --slug perf-<key>-0925 --control $E/stage-control.json   # keep running
```

Deploys the current checkout as a retained PlanetScale stage (`--database neon` to change), then
stays in the foreground as the stage's fixture process. Fixture control is limited to `test-e2e-*`
and `test-perf-*` stages; the deploy hands the stage's database and signing settings to this
loopback process, which mints synthetic owner/admin/member sessions. The control file (mode 0600)
is deleted when the command stops. Restarting it redeploys the same stage to reconnect fixtures.
Slugs must match `perf-*-0925`.

## 2. Emulated upstreams

```sh
$L $P emulator deploy                  # https://perf-emulator-0925.<account>.workers.dev
$P emulator serve --port 4600          # the same handler on loopback (self-host / local)
```

`/mcp/<spec>/mcp` is a Streamable HTTP MCP server; `/openapi/<spec>/openapi.json` is an OpenAPI
document with operations under `/openapi/<spec>/ops`. `<spec>` sets tool count (`t`), per-call
latency and jitter (`l`, `j`), list/document latency (`s`), extra first load per isolate (`c`),
error rate per mille (`e`), required `x-api-key` (`a1`) and an instance key (`k`), for example
`t200-l40-j10-s800-c2500-e0-a0-kalpha`. Every response carries `x-emulator-processing-ms` and
`Server-Timing: emulator;dur=`; tool results repeat it as `emulator.processingMs`, which the
scenarios subtract to get Executor-added time. All data is generated.

## 3. Shape and seed

```sh
$P shape                               # committed production shape (aggregate quantiles)
$L $P shape --pull --hours 36          # refresh from executor-next-v2-traces (needs query access)
$P seed --control $E/stage-control.json --receipt $E/receipt.json --seed 925
```

`perf/shape.ts` holds only quantiles (apps/accounts/profiles per org, catalog apps and tools,
calls per execute, upstream call and discovery latency). The seeded RNG turns them into
organizations `a1f a8f a24f` (fast upstreams), `a1s a8s a24s` (production-latency upstreams,
first-load delays) and `call` (zero-latency MCP, account-bound MCP and OpenAPI apps). Apps are
imported through `POST apps/import` from the emulator, with profiles, API-key accounts and a PAT
per org. The same seed and emulator origin produce equivalent data on every stage. Seeding
resumes from the private receipt (it holds PATs; keep it out of Git).

## 4. Scenarios

```sh
$P list
$P run --control $E/stage-control.json --receipt $E/receipt.json --output $E/results/run.json
$P run ... --scenarios '^mcp.execute.24,^toolcall' --samples 30
$P compare --control $BASE/stage-control.json --receipt $BASE/receipt.json \
  --control-b $E/stage-control.json --receipt-b $E/receipt.json --output $E/results/compare.json
```

Groups: `api.*` (every dashboard read seen in production traffic), `action.*`, `ui.load.*` and
`ui.nav.*` (Chromium page loads and client-side navigations until requests settle),
`mcp.session.*`, `mcp.execute.{1,8,24}.{fast,slow}.{warm,cold}`, `toolcall.{rest,execute}.*` and
lifecycle writes (`app.import.*`, `app.deploy.*`). Warm-ups are discarded. Each result reports
n/p50/p95/max/mean for client wall time, server time (`Server-Timing: executor;dur`, the handler
duration) and scenario metrics such as `upstreamMs` and `executorAddedMs`, plus the median and
slowest trace IDs. Lifecycle scenarios take at most 5 samples; browser and cold ones at most 10.
`compare` warms both origins then alternates A/B each round (ABAB, BABA), so drift affects both.
`compare --spacing-ms 61000` instead samples every selected scenario once per round and waits
until the spacing has passed before the next round, so reads find results kept for up to 60 s
(evaluated app declarations) expired: it measures first reads rather than repeat reads. Select
scenarios whose reads do not share a kept result (for example `api.app.skills` but not also
`api.app.skill-bundle`, which reads the same catalog).

`api.slow.app.*` read the evaluated tabs of an imported MCP app in `a8s`; its factory does not
await its upstream. `api.factory.app.*` read an app whose factory awaits a 512 ms emulated catalog
(production p50 discovery) on every evaluation. On first use per stage they create the extra
fixture organization `decl`, deploy that app and connect a synthetic account; setup is unmeasured.

Cold MCP samples open a new session for each sample; they do not force a cold Worker isolate or
an empty catalog cache. Client times include the network path from the runner to Cloudflare.

## 5. Flamecharts

```sh
$L $P flamechart --from $E/results/run.json --output $E/flame                  # median + slowest
$L $P flamechart --from $E/results/compare.json --output $E/flame-compare      # side by side
$L $P flamechart --slug perf-<key>-0925 --trace <id> --at <iso time> --output $E/flame/one
```

Spans come from `executor-next-test-traces` for one `test-*` stage and trace ID. Output is an SVG
waterfall (name, ms, colour by service; beyond 250 rows the shortest spans are folded) and a PNG.
