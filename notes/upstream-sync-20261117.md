# Frozen upstream reconciliation — November 17, 2026 (PST)

Implementation/PR only. The lead owns review, merge, private SDK distribution, exact-image
rollback rehearsal and deployment. No production, registry, account or network configuration
was accessed or changed by this work.

## Identities and boundaries

- Fork base: `4f9fce5001e57532a5632af286af9a9d9f3ebf8a` (#92 plus #95).
- Incorporated upstream: `9de0a387a564f625eb454e3ac0281c5822eb0da2`.
- Frozen target: `56d893c24d60e76bc532400c8cfaefc8f70fa41d`, **69 reachable commits**.
  This includes a contributed HuJSON branch merged by an export; “exports” is the task's
  shorthand, not a claim that every commit has an Export subject.
- The first 41 are inventoried in the approved plan. The remaining 28 below are derived
  from each commit's first-parent diff, including the merge commit, not export labels.
- Never upstream `main`. The reconciliation uses a real two-parent merge.
- CLI beta.59; fork SDK `apps@0.0.1-beta.141.shuv.1`. Existing app pins are not rewritten.
  #95's private publication tool and fail-closed guard survive; nothing was published.

## Additional 28-commit inventory

| #   | Commit                                     | Actual change and gate impact                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 42  | `1d5cd9fac88a106b9704c82fcc1584ac89cad024` | Classify HuJSON as text rather than stringifying/parsing it as JSON in OpenAPI requests, responses and generated schemas. SDK content gate changes.                                                                                                                                                                                                                                         |
| 43  | `aa07b772670dd26616d31d8492e3387baac1f734` | Classify workflow engine-call failures by bounded hop/class/code, retry only transient sleep/sleepUntil engine calls, finish elapsed waits, record exhausted engine failures, and add E2E-only fault injection. **Extends the retry gate beyond never-connected exchanges to durable keyed sleeps, not app steps or writes.**                                                               |
| 44  | `e9a908c50758496da91d244c76894e1b1fda1da0` | CLI beta.57; strengthens workflow proof that a repeat actually completes a failed sleep and elapsed waits are not repeated.                                                                                                                                                                                                                                                                 |
| 45  | `2e8c8b7ed736b6c95f8f87c6a90f78160752919a` | Repeat read-only R2 get/list/head on classified transient 10001/10043 failures, at most three attempts; no replay of an opened failing body stream. Cloud adapter gate expands.                                                                                                                                                                                                             |
| 46  | `502b7c415293a93ac00d6f4323f0d52cceba64d1` | Give each stage test request its own non-keepalive connection; record new/reused connections, written state and response-body loss through lifecycle/setup/teardown. Harness only, not product replay.                                                                                                                                                                                      |
| 47  | `f66f9cf2f0d40629b1cbf32186eeb97e96bb91c1` | Temporarily mark workflow-engine-calls not-run on Cloud after upstream failures; self-host remains scheduled. Reversed by #55; no new final skip is introduced.                                                                                                                                                                                                                             |
| 48  | `ece78469888ebffb3a51bf17afb2114fa2cdf023` | Measure catalog-scale phases and retain timing evidence before checking latency. No product behavior.                                                                                                                                                                                                                                                                                       |
| 49  | `734e0b76d97757d9d960ed886cbc51bcbc7194ee` | Add edge probe tooling, plus redaction/classification of nested certificate/connection errors. Probe is removed in #67; redaction tests remain.                                                                                                                                                                                                                                             |
| 50  | `658397d4634775526256d777251c8593687c392a` | Share machine-speed calibration/timeout evidence and raise upstream scenario/hook hang detectors from 60 to 120 seconds. **Changes the plan's timeout gate; the fork retains 60 seconds under this task's no-longer-deadline rule.** The 7,000-tool scale budget is machine-calibrated upstream; the fork 8,549-tool cold gate is unchanged.                                                |
| 51  | `15cca94353951efffd9761188921267e9091078c` | Repeat harness requests only when diagnostics prove nothing was written, with bounded backoff, cancellation/deadline/body checks and saved attempt receipts. **Harness gate now includes unwritten methods, never written POST/GET/DELETE.**                                                                                                                                                |
| 52  | `9ec62d7c788ed0480d534597c972e9fbc05defd4` | Bound webhook sweep observations by scenario deadlines; preserve every external task/trace observation, queue progress and waits; add runner-owned webhook queue fixtures and standalone sweep-wait scenarios. Product source only corrects sweep comments; not a provider-write retry feature.                                                                                             |
| 53  | `5307d9fc1f8fc4a6b52d6c41056c9e29822b23c0` | Require a supported test-stage branch state before deletion, handle unreadable/deleted branches explicitly and cover command/orphan cleanup. Test-stage administration only; no branch operation was performed.                                                                                                                                                                             |
| 54  | `e40e5ea0a29a6175b97e16855000fcb3d7987643` | Distinguish retryable framework/build storage failure from app compilation failure, observe concurrent content-addressed framework writes, and classify/retry Cloud R2 writes. **Storage gate expands: keyed content writes/confirmation are distinct from app-write replay.**                                                                                                              |
| 55  | `12ee40be1d7a0ec66f7f0a6b229fc9688956e2bd` | Record failed sleep-call elapsed time, distinguish repeat versus elapsed sleep completion and restore managed Cloud coverage removed in #47. Retains the bounded sleep-only repeat gate.                                                                                                                                                                                                    |
| 56  | `ec9dd1254be126e608c597e83208e12cc0821a77` | Make webhook FIFO fixture expose the actual lease/queue transitions and assert public observations instead of racing removed rows. No new product mutation.                                                                                                                                                                                                                                 |
| 57  | `03b23ea1ccd35d06686bec144fddb076608129f6` | Persist privacy-safe stage request history with request timing, trace correlation and unfinished requests, including lifecycle evidence. Harness privacy/evidence gate expands.                                                                                                                                                                                                             |
| 58  | `64362230c887aa4fac26ae688125ec5f300bb26f` | Wait for observed webhook-source work rather than assuming an immediate sweep; update app-account webhook assertions. No product data step.                                                                                                                                                                                                                                                 |
| 59  | `da00d81a4e3980b8c5b05110211292d8df5ef6ed` | Share one in-flight framework retention write between concurrent builds; avoid retaining a failed build; add R2 failure/contention and SDK real-store fixtures. Content-addressed storage gate, no arbitrary app-call replay.                                                                                                                                                               |
| 60  | `52c4834a074ea87c511a630c076d42b4da0433ad` | CLI beta.58 and explicit CI-selection coverage for app source/framework changes. No fork CI layout replacement.                                                                                                                                                                                                                                                                             |
| 61  | `e160181f047f316e459358ec6161a7560a962e63` | Publish security reporting guidance and security.txt routes through site/Cloud edge contract. No infrastructure applied.                                                                                                                                                                                                                                                                    |
| 62  | `fbb5ac1df109e54e5bbb55fa9d05f45f1ba7640a` | Reject worker-size/skip evidence from unsuitable workflow versions/attempts; strengthen missing/mismatched baseline cases. Upstream-layout tooling only.                                                                                                                                                                                                                                    |
| 63  | `41120c3805ec9b5dcfd3aae52f04b09c19a11c22` | Make catalog-scale and connect-repeat fixtures account for process outcomes and protect opened/sent-call refusal cases. No classifier widening.                                                                                                                                                                                                                                             |
| 64  | `dcd272aff3100cca9584962cefa3ca455a23c775` | Merge HuJSON contribution, broaden structured +json recognition and AWS JSON types, and check JSON before the text gate; apps beta.139. SDK package changes; no protocol bump.                                                                                                                                                                                                              |
| 65  | `a8d3a2c555f6d14a019ef2ee9fdb8e0b9209ecfc` | Real-server HuJSON/JSON/AWS response and request coverage, with shared OpenAPI import helpers. SDK media gate now executable.                                                                                                                                                                                                                                                               |
| 66  | `f4416e915d7c4479a29c01f9d5fc6ec4343251fb` | Memoize shared schema identities/closures across account-router listings, validate merged schema entries once per catalog, preserve per-account branches, and record large-catalog/failure evidence; apps beta.140. **SDK content and #89 cyclic/shared-schema gates expand.**                                                                                                              |
| 67  | `ab2a3469bcb22cacfd5e8c085b5ebe79d1da1d88` | Remove the edge-probe experiment and its tooling/test selection. Not a skip of a retained product invariant; the probe never reaches the final tree.                                                                                                                                                                                                                                        |
| 68  | `d2daa20f473726d1a8553d28d9e35b749c6f5dfc` | CLI beta.59; operator OAuth held scopes can renew existing grants but cannot be requested by new/reconnect sign-ins, with bounded explicit refusal and own-client recovery. Cloud's Google registration holds gmail.modify; self-host operator-owned Google retains it. **OAuth contract/config gate changes, but #68 DCR registered scopes and #80 callback projection remain untouched.** |
| 69  | `56d893c24d60e76bc532400c8cfaefc8f70fa41d` | apps beta.141; linear srcset scanning; enforce private-fetch policy on off-registry tarballs/redirects, sanitize install failures and extend worker-bundler patch; add network/srcset scenarios. **Builder egress/private-registry compatibility gate expands.**                                                                                                                            |

### Plan gates changed, plainly

The 28 commits are not covered by the original plan's “no SDK source change” or “OAuth
usability refactor only” observations. They require a new immutable SDK version, held-scope
OAuth refusal/renewal evidence, multi-account schema closure checks, dependency-egress
checks and expanded storage/engine-call classification. Repeated sleeps and content-addressed
storage operations are not never-connected app RPC exchanges. No app write or workflow step
whose answer was lost is replayed. #93 is not diagnosed or fixed. The fork retains its 60-second scenario/hook limits rather than upstream's 120 seconds. No test retry,
skip or assertion allowance is added here to make these paths green.

## Conflict ledger (all 23 unmerged paths)

| Path                                                                      | Choice and reason                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/hosted/self-host/README.md`                                         | Reconcile Rust/store split with fork's persistent telemetry volume and #95 private SDK procedure. Do not copy upstream's deletion command or claim default fork telemetry is ephemeral.                                                                                                                |
| `apps/hosted/self-host/compose.yaml`                                      | Keep flat/default-organization host settings and telemetry volume; update only collector terminology.                                                                                                                                                                                                  |
| `apps/hosted/self-host/native/main.go`                                    | Keep fork separate-app-process/watchdog/proxy/cancellation paths; use upstream collector executable/socket/supervision and COLLECTOR binding, including shutdown.                                                                                                                                      |
| `apps/hosted/self-host/scripts/package-runtime.ts`                        | Keep fork shared/product/apps configurations and APPS callback bindings; replace Motel with collector external binding, remove Motel config/payload; stage the collector separately in native fixtures.                                                                                                |
| `apps/hosted/server/src/contracts/mcp-connections.ts`                     | Keep member/API confined mutations, connection-key schemas and 5-second–90-day bounds. Keep fork manage-scoped metadata listing rather than silently broadening read-key metadata; selected-tools grants still cannot list siblings.                                                                   |
| `apps/hosted/server/src/implementation/access.ts`                         | Keep request-owned access-bearing CheckedApp and pinned active-version authorization. Accept upstream AppAccountReads/selectedAppFrom and verified slug lookup; remove superseded second batch-selection read path.                                                                                    |
| `apps/hosted/server/src/implementation/mcp-connections.ts`                | Keep requireCallingScope/member-owner confinement and API management contract, not upstream browser-only mutation comment.                                                                                                                                                                             |
| `apps/hosted/server/src/implementation/mcp.ts`                            | Keep verified CurrentCaller, discoveryChecked `{app,access}`, account/connection checks and listAccountsEach. Reconcile one upstream searchReads/PrefetchHost snapshot with the fork's batched kept-row facade; misses/refusals use that same snapshot, not another query cache.                       |
| `apps/hosted/server/src/implementation/resource-lifecycle.ts`             | Keep creator/root-owner group audience semantics; accept upstream owner-batched rechecks and per-app Result failures, removing the old duplicate appsResolving implementation.                                                                                                                         |
| `apps/hosted/server/src/implementation/tools.ts`                          | Accept upstream prefetched selection for live search; retain fork batched kept-row API and policy/router/account filters, using those same upstream selections.                                                                                                                                        |
| `bun.lock`                                                                | Accept upstream resolutions/patch changes, then regenerate with bun install for the exact .141.shuv.1 workspace identity; keep Playwright 1.64.1 patch.                                                                                                                                                |
| `e2e/tests/mcp-connections.spec.ts`                                       | Keep fork API/full-grant/anti-widening assertions rather than upstream's assertion that mutation tools do not exist.                                                                                                                                                                                   |
| `packages/app-templates/src/implementation/executor-skill-digests.gen.ts` | Regenerate with bun run executor:intro after source reconciliation; never combine hash strings.                                                                                                                                                                                                        |
| `packages/apps/package.json`                                              | New immutable fork SDK 0.0.1-beta.141.shuv.1, not upstream .141 or reused .138.shuv.1.                                                                                                                                                                                                                 |
| `packages/mcp/src/implementation/execute.ts`                              | Keep dotted-path resolver and batched kept-row/account projection. Accept upstream per-search batch ownership for misses; never batch unrelated locked apps.                                                                                                                                           |
| `packages/sdk/src/contracts/executor.ts`                                  | Accept upstream owner-batched appsResolving Result contract; retain fork host-only searchableKept and caller/key extensions.                                                                                                                                                                           |
| `packages/sdk/src/implementation/declarations.ts`                         | Accept upstream batched account usability/recheck semantics and authorizeAll; retain unchanged fork caller-bearing snapshot/key behavior.                                                                                                                                                              |
| `packages/sdk/src/implementation/listings.ts`                             | Accept upstream Schema decoding/prefetch. Reconcile kept-row projection with shared prefetched rows/access so misses remain explainable without repeating reads; preserve per-catalog shared projections.                                                                                              |
| `packages/sdk/src/implementation/tool-search-store.ts`                    | Accept upstream ordered batch rows rather than fork map; adapt kept-row consumer to ordered indexing.                                                                                                                                                                                                  |
| `packages/sdk/src/implementation/tool-search.ts`                          | Accept batch-row documentation/type; retain automatic merge of fork namespace-relative dotted search.                                                                                                                                                                                                  |
| `packages/sdk/src/implementation/tools.ts`                                | Keep verified requester/approver and per-app sharedRuntime/callerConnection. Accept upstream app-entry counting and safe failure classification, including resumed calls with one prior app entry. Kept-row fast path consumes only served entries of the shared owner/actor/version/account prefetch. |
| `packages/sdk/src/implementation/worker-dependencies.ts`                  | Keep fork trailing-slash registry normalization and upstream tarballFetch/egress/redaction.                                                                                                                                                                                                            |
| `packages/sdk/src/implementation/workerd-entry.ts`                        | Keep fork durable progress/stalled-body and attempt-limit watchdogs. Integrate upstream engine fault classification/sleep semantics; do not drop crash-loop bounds.                                                                                                                                    |

### Non-conflicting preservation and fixture reconciliation

#88 resolver, #89 OpenAPI shared closures, #90 awaited feedback receipt/privacy, #91 shared
notifications/cancellation, root-owner multi-org admission, organization-only publishing,
short names, apps call, Playwright patch/Bun 1.4.4, migration mapping and #95 were reviewed
beyond conflict markers. The pending personal-account scenario remains retained and skipped;
neither hosted target is unskipped. No #68/#80/#93 feature work is included.

Native fixtures now require the staged collector executable instead of motel.capnp and find
the process by `--data=<fixture>` instead of Motel's workerd directory argument. Native Go
shutdown calls the collector supervisor, not the removed Motel supervisor.

The upstream search-statements assertion is **tightened from exactly 12 to exactly 10 SQL
statements**: the fork already carries access with its app list and does not reread those two
access folds. The original fork warm search still requires four backend operations; its
scenario is retained. Both small/large app counts, forbidden private apps and reconnect
refusals remain asserted. No assertion is relaxed to allow more work or less security.

## Migration/data impact and remaining release gates

The full 69-commit range adds **no product schema migration and no hosted/Cloud data step**.
The sole changed migration file changes a comment from Motel to telemetry collector.
Fork Cloud 14 remains immutable; upstream 14/15/16 stay fork 15/16/17. SDK/product/registry
journals and the pending personal-account decision remain unchanged. Existing installed app
versions, credentials, source pins and app data are not migrated for telemetry.

The Rust collector owns a separate SQLite store, never reads/resets/deletes nested `motel/`,
and does not import old history. Exact old image + independently preserved old telemetry bytes
are still required to read old traces. Live mounted data, old-reader restoration, existing
personal-account impact, current private builder resolution, exact-image rollback, deployed
Cloud and non-Linux-x64 platforms are not established by fresh fixture tests. These remain
lead-owned release gates, not inferred from PR CI.

## Guidance followed

Read charter/lead handoff, AGENTS, CONTEXT, RELEASING, executor-e2e skill, migration numbering,
personal-account decision, approved plan/summary/resolutions/approval/amendment, #92 and fork CI.
Missing public-export engineering notes remain known papercut `pc_dcf8902b5987`.
Rat-stack pages read: `ratstack://repo/AGENTS.md`, `ratstack://skills/ship`,
`ratstack://skills/investigate-a-failure`, `ratstack://skills/add-a-store`.
Only language-neutral fence/evidence/migration/rollback rules apply; Executor conventions win.

## Evidence

Command logs and receipts are copied from `.local/upstream-sync/` to
`/home/shuv/.cache/agent-ws/executor-upstream-sync-20261117/`. The final PR and handoff give
executed command/scenario receipts, including failures and fixes; an unmatched filter is never
a pass. Real-server diagnostics/results and privacy-safe named evidence are retained outside
the prunable `.local/e2e/`; no sessions or product databases are published.
