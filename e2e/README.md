# Tests with evidence

The suite uses Effect v4 and `@effect/vitest`. Scenarios use `layer` and `it.effect`.
Effect owns the servers, HTTP clients, actors, browser contexts, concurrency,
recording export, and cleanup. The test runtime uses live clocks because it talks
to real processes. It does not import Executor implementations or construct partial
application servers.

Playwright is the browser driver, behind an injected Effect adapter. Its test runner
and fixture system are not used. React renders the saved evidence report.

## Run

```sh
bun install
bunx playwright install chromium
# ffmpeg and ffprobe must also be on PATH.
bun run e2e:prepare
bun run e2e:self-host
```

`e2e:prepare` builds the dashboards and bundled Motel. Run it again after changing
either. The server runs current TypeScript source. `bun run e2e:check` runs the
boundary check and TypeScript check; the root `check` includes it.

```sh
bun run e2e:local
E2E_ROWS=12 bun run e2e:self-host
bun run e2e:self-host --test-name 'password login'
```

The default data-volume scenario remains 1,000 accounts with four concurrent
writers. Smaller runs use the same assertions. `--test-name` is a Vitest name
filter; filtered cases are not counted as executed cases in the evidence view.

## Dependency injection

`support/platform.ts` supplies target configuration and native platform services.
`support/case.ts` composes the Layers used by Effect Vitest:

- `Target`: exact origin, runtime, data directory and private configuration.
- `SessionClients`: native Effect HTTP clients with independent cookie jars.
- `Actors`: owner/admin/member sessions, shared by the hosted suite's Layer.
- `Api`: records each real request while preserving the test trace ID.
- `BrowserDriver`: scoped Playwright process, shared by a suite.
- `Browser`: isolated context per case, with an Effect `use` boundary for SDK calls.
- `Evidence`: named steps, screenshots, request timings and the final outcome.
- `Telemetry`: queries spans that actually reached Motel over HTTP.
- `McpOAuth`: public discovery, registration, PKCE, recorded browser consent, refresh and revocation.
- `McpClient`: scoped official MCP protocol clients with safe method/revision/trace evidence.
- `ClaudeClient`: real Claude Code in a Terminal Control PTY, with an injected model API.
- `RecordingFocus`: one clock and an ordered activity log for every recorded window.
- `Terminal`: scoped Terminal Control sessions; each `use` call selects that window in the recording.

Each test yields the services it needs. `withCase` provides the per-case Layers;
it does not register tests or replace Vitest's lifecycle. `@effect/vitest` owns
suite sharing and test interruption. Effect scopes close browsers, save evidence,
and stop child processes. Owned server process groups get a 15-second graceful
shutdown window before Effect escalates to SIGKILL. `Effect.forEach` bounds concurrent writes and waits for
interrupted children. Transport failures are typed and do not expose credentials.

Self-host account setup runs once through real signup/invitation HTTP endpoints
before Vitest starts. Its synthetic cookie state is stored privately in the run
directory. Reloading an actor Layer does not repeat sign-in or consume login rate
limits. Browser login tests still exercise the actual password form.

## Targets and shared behavior

The self-host release-image check runs against a prebuilt Docker image, outside
the source-server targets. It covers first-admin setup, an npm-dependent app,
tool execution, and retained login/app execution after a container restart:

```sh
EXECUTOR_E2E_DOCKER_IMAGE=<image-tag> EXECUTOR_E2E_DOCKER_ARCH=arm64 \
  bunx --no-install vitest run --config e2e/docker-release.config.ts
```

Use `amd64` when checking that image architecture. The scenario creates and
removes its own container and volume. It does not publish the image.

| Command                 | Target                                                          | Current coverage                                              |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------------------------------- |
| `bun run e2e:self-host` | Fresh Node/PGlite self-host                                     | Shared hosted scenario, password login, account volume, Motel |
| `bun run e2e:local`     | Fresh Node/PGlite local product                                 | Pairing, replay rejection, dashboard access and reload        |
| `bun run e2e:cloud`     | Managed local Cloud Worker + Postgres, or explicit attached URL | Cloud onboarding, shared hosted behavior and MCP              |
| `bun run e2e:parity`    | Self-host and Cloudflare                                        | Identical role/account and MCP scenarios on both              |
| `bun run e2e:all`       | All three                                                       | All applicable tests in one combined report                   |

With no `E2E_CLOUD_URL`, the Cloud target starts the real Alchemy Worker and a
throwaway Postgres container on fresh ports. It provisions its external services
through emulators.dev and generates its own temporary database/auth values. It
starts with a sealed environment and an empty Alchemy profile directory. No
Cloudflare, PlanetScale, Google, GitHub, Context.dev, or 1Password credentials
are needed. Docker must be running; Bun, Playwright Chromium and ffmpeg are
normal tool prerequisites.

Setting `E2E_CLOUD_URL` explicitly attaches to that server instead. A failed
attached target stays failed; it does not fall back to a local instance. The
report identifies the origin, managed/attached mode and local Worker runtime.
Deployed-stage role tests use `E2E_CLOUD_ACTORS`; attached onboarding uses the
stage's generated emulator fixture. Deployment is separate from running tests.

`tests/hosted-shared.spec.ts` contains one Effect program with no target branches
in its assertions or UI steps: signed-out rejection, owner/admin/member permissions,
app deployment, account connection, tool discovery/invocation and both dashboard
views. A scoped finalizer deletes only its created app/account, including on failure.

Cloud load capacity, cross-tenant coverage and Axiom retrieval remain separate work.
The cloud report marks remote telemetry as not collected. Do not run the large
self-host workload on the shared cloud stage database.

### MCP server scenarios

`tests/claude-mcp.spec.ts` drives the actual interactive Claude Code application.
It starts with an unauthenticated MCP URL, enters `/mcp`, selects Authenticate,
and follows the browser request opened by Claude. Self-host signs in through the
password form. Cloud uses an already signed-in synthetic browser session. Both
approve the organization, return to Claude's own loopback callback, verify its
successful connection, and invoke a tool in that same terminal session. A random
receipt absent from the prompt proves a real invocation.

The client's configured OS browser handler forwards its actual authorization URL
to the recorded browser. Claude performs discovery, client registration, PKCE,
the code exchange, and credential storage. The test never supplies an MCP token
or constructs the authorization request for this scenario.

`tests/mcp-server.spec.ts` separately checks the public OAuth/MCP protocol with
the official SDK client: anonymous rejection, browser consent, discovery, tool
execution, refresh and revocation. Both scenarios run unchanged on self-host and
Cloudflare, with target-specific browser sign-in supplied by an injected adapter.

Install Claude Code and configure its model API explicitly. We use VibeProxy's
Anthropic endpoint. The runner never falls back to a personal Claude OAuth login.
Supply `E2E_CLAUDE_BASE_URL` and `E2E_CLAUDE_API_KEY` through the environment or a
credential launcher; never put a real key in a command argument. Optional
`E2E_CLAUDE_COMMAND` defaults to `claude`; `E2E_CLAUDE_MODEL` defaults to
`claude-sonnet-4-6`. The interactive tool response has a 90-second wait limit.

```sh
# With model API variables supplied by your private launcher:
bun run e2e:self-host --test-name 'Claude Code connects'
# Also supply E2E_CLOUD_URL and E2E_CLOUD_ACTORS for both hosted targets:
bun run e2e:parity --test-name 'Claude Code connects'
```

Claude runs interactively with `--bare`, an explicit VibeProxy model API, no built-in
tools, and its own temporary configuration directory. First-run UI choices and
MCP authentication are driven through Terminal Control. Its private configuration
and cached credentials are removed on exit, and the test revokes its server grant.
One recording follows terminal → browser → terminal from the actual driver calls.
Original clips, the activity timeline and the edit plan remain in supporting
evidence. Recorded test and request durations do not change. OAuth cases discard Playwright's
network trace because it contains credentials; video, screenshots, sanitized
navigation, protocol metadata and request timings remain. Protocol revisions in
`mcp-*.json` describe the official SDK client. `claude-client.json` records the
actual CLI version, model, permission mode and model API.

Executor's native tool-policy approval and browser tool approval remain separate
coverage. Local is N/A for these hosted OAuth scenarios.
App and grant cleanup uses public endpoints. Anonymous OAuth client registrations
remain on the dedicated stage because the product has no public deletion flow;
cleanup evidence calls this out. No active grants are deliberately retained.

## Evidence

The runner prints `.local/e2e/<run>/report/index.html`. Serve that folder on loopback
with the Effect report server:

```sh
bun run e2e:report --directory .local/e2e/<run>/report
```

All assets and media use relative links. The React viewer
opens with a searchable results list, status/target filters and 50-row pages. Each
shared scenario appears once, with a separate result and duration for each target.
Selecting it leads with its recording or request evidence. Target controls switch
between that scenario's recordings without duplicating it in the sidebar. The target's exact URL remains
visible. Only the selected test loads media.
The viewer follows the system's light or dark theme, including native controls.
While dragging the seek bar, a thumbnail strip and timestamp appear above it.
Releasing the scrubber hides the strip. It overlays the footage so the scrubber
does not move. The exporter generates the eight-frame overview from the final
composed video, so it follows the same edit as playback. It loads only for the
selected test. Generation happens after
test execution. Existing reports without thumbnails retain the plain seek bar.

The player includes keyboard seeking,
five-second back/forward buttons, playback speed and fullscreen controls. Controls
stay below the footage. The report server supports byte-range requests for seeking
without downloading the entire recording first.

Local recordings automatically pace browser actions by 500ms and leave a 1-second
reading pause after browser and terminal operations. Playwright instruments the
individual actions, including multiple actions inside one `Browser.use` call.
The shared recording driver owns reading pauses; tests do not add sleeps.
`CI=true` disables both delays while retaining recordings for failures and review.
Override either default with `E2E_RECORDING_PACE_MS` (0–3000):

```sh
# Full-speed local run, with the same evidence capture
E2E_RECORDING_PACE_MS=0 bun run e2e:cloud --test-name 'Cloud onboarding'
# Watchable recording, even on CI
E2E_RECORDING_PACE_MS=500 bun run e2e:cloud --test-name 'Cloud onboarding'
```

Reading pauses last twice the configured action delay. This only changes capture
drivers; API calls, server configuration and evidence encoding are never paced.
`recording-pacing.json` records the setting. Test durations include these deliberate
waits, so use unpaced runs for timing comparisons. Request and server span durations
still measure the actual requests. Cancellation interrupts pending reading pauses.

Recording focus is automatic in the driver adapters. Browser operations, checkpoints
and actor changes select the browser; opening or using a terminal selects that
terminal. Overlapping calls use the newest call's window. An older call completing
does not change focus, and saving artifacts during cleanup does not select a window.
The exporter follows `recording-timeline.json`, so a test can switch between windows
any number of times without phase markers. It trims idle tails and leading blank
terminal startup, holds short terminal results for reading, and retains the full
source captures. Terminal Control exports include startup so their time axes stay
aligned with the browser capture.

Tests save raw terminal captures and close their live sessions. Terminal video
encoding, browser address-bar rendering, and composition start only after every
selected target's test process has exited. Rendering one target therefore cannot
compete with a still-running target. The CLI reports evidence-processing time
separately, and each recording has an `evidence-processing.json` attachment. Those
times are excluded from the test duration; raw capture and normal cleanup still
belong to the test's resource scope. Export failures fail the overall command and
retain the raw captures for diagnosis.

N/A means the test is explicitly irrelevant to that target, with the reason
available on hover. Not run means the test is relevant but has no result, or
requires infrastructure that was not available. For example, cloud scale stays
Not run until dedicated capacity exists. Recorded skipped results remain skipped.
Applicability comes from the scenario plan used by the runner and is saved in
each report; missing evidence alone never becomes N/A.

Each case saves steps, request status/timings, trace IDs, latency percentiles,
checkpoints, a Playwright trace and a video when it opens a page. Failed and
interrupted cases retain evidence. Native Vitest diagnostics remain linked from
the report. A failing target makes the command fail after report generation.

After capture, an Effect operation adds a 72px address bar with 28px text above
the recorded page. Query strings/fragments are omitted. Playwright renders the
bar images and scoped ffmpeg processes compose the MP4; the tested page is never
modified. Raw video and trace artifacts remain in the case directory.

The server log and complete Motel database remain under each target's run folder.
Saved trace samples are not a full trace archive. The telemetry test checks actual
server spans, status and SQL query count; client spans cannot satisfy it. While
running, `data/diagnostics/collector.json` identifies the collector query URL.

All runs use synthetic identities. Private run directories and session files are
ignored by Git. They can still contain session cookies and should not be published.

## State storyboard

Use `E2E_UI_OBSERVE=1 bun run e2e:cloud --test-name 'Cloud onboarding'` to capture
loading and error states as direct screenshots. The viewer supports arrow-key
stepping, journey selection, previous-frame overlays, side-by-side comparison and
movement highlights. Browser layout-shift events after recent input are retained.

This opt-in managed Cloud capture pauses API requests and driver actions for
screenshots. Its durations include those holds; normal runs do not. Every observed
candidate is retained, with an explicit status if it changed before capture.
See [the storyboard guide](../notes/ui-state-exploration.md) for the protocol,
comparison rules and coverage limits.

## Pause, take over, resume

```sh
bun run e2e:inspect --test-name 'hosted roles'
```

The headed browser pauses at named checkpoints. Use that same browser normally,
then press Resume in Playwright Inspector. Server state, cookies, recording and
telemetry remain live. Failed interactive cases pause before teardown; cancellation
closes the owned scopes. Interactive cases are annotated as manual intervention and
do not count as unattended passes. Process-crash restoration is not implemented.

## Cloud actors

### Cloud onboarding with emulators.dev

Run the complete onboarding slice without environment files or account secrets:

```sh
bun run e2e:cloud --test-name 'Cloud onboarding'
```

This is the existing E2E suite and evidence pipeline. The runner starts a real
local Cloud Worker plus Postgres and creates isolated Google, GitHub, Resend,
Context.dev and Autumn emulator instances. Company lookup has deterministic
matched and unmatched domains; the Google case verifies the actual suggested
company name before editing it. No real company-lookup key is used.

Each onboarding case begins signed out. Google and GitHub complete OAuth token
exchanges; email retrieves its actual delivered code from the mail emulator.
Passkeys use browser WebAuthn and real server registration/assertion endpoints
with a virtual authenticator. They do not exercise a native password-manager
sheet. Ordinary role fixtures use the normal running dev server's account-switch
HTTP action, which keeps setup traffic out of the email sign-in rate limit.
Onboarding cases never use those prepared sessions.

The local test origin is `http://localhost:<port>`. Browsers treat localhost as
a secure context for WebAuthn, so the run needs no installed certificate or key.
No TLS verification is disabled. Real external services still use verified HTTPS.
The Worker is the real Cloud entry point; only external service configuration and
resource lifetimes vary. No alternate auth server is constructed.

The runner ignores inherited infrastructure credentials, sets `CI=true`, and
uses an empty per-run `ALCHEMY_HOME`. Alchemy beta.79's local Worker/R2/Hyperdrive
providers require the included patch to stop resolving cloud credentials for
local identities. Live providers and bindings explicitly marked remote retain
normal credential resolution. Generated test credentials are ephemeral, not
personal or production secrets. On completion the runner stops the Worker,
removes its Postgres container, removes the emulator credential file and resets
its external emulator instances. Recordings remain in the report.

These Cloud-only scenarios have explicit N/A reasons on self-host and Local.
Their recordings cover provider selection, company loading, edited team
confirmation/retry, passkey enrollment and returning sign-in after enrollment
or Not now. The loading-state case delays the original network request; it
neither replaces the response nor presents that delay as server latency.

For an independently deployed E2E stage, provision its external configuration:

```sh
node e2e/create-emulators.ts --origin https://e2e-your-stage.executor.engineering \
  --output /absolute/private/path/onboarding-emulators.json
```

The deployer supplies that file's `services` object as `EXECUTOR_EMULATORS` when
updating the dedicated stage. The mode is permitted only for loopback Cloud dev
or `test-e2e-*` stages; production origins reject it. It does not resolve real
social-provider, email, billing, company-lookup or OAuth proxy credentials.
Google signature, issuer, audience and nonce verification remain enabled.

```sh
E2E_CLOUD_URL=https://e2e-your-stage.executor.engineering \
E2E_EMULATORS=/absolute/private/path/onboarding-emulators.json \
  bun run e2e:cloud --test-name 'Cloud onboarding'
```

That optional file contains generated emulator capabilities, not infrastructure
credentials. It is created with mode 0600 and never overwritten. Keep it private.
Provider emulation does not claim coverage of Google's/GitHub's live UI or native
Cloudflare mail delivery. The separate interactive Claude journey still takes
its model-endpoint configuration documented above; onboarding does not need it.

### Signed-in actors for other hosted tests

Deploy to a dedicated stage whose slug starts with `e2e-`, using the normal Alchemy
stack. Set `TEST_STAGE_ACCOUNTS_OUTPUT` to a new absolute path under ignored `.local/`.
The separate fixture job runs after migrations, checks the exact stage origin and
database name, and creates three one-hour sessions using the restricted stage role.
It writes mode 0600 and refuses to overwrite an existing file. A later deploy with a
new output path refreshes the sessions. No fixture auth plugin or provisioning route
is added to the Worker. Fixture setup is not a login test.

```sh
E2E_CLOUD_URL=https://e2e-your-stage.executor.engineering \
E2E_CLOUD_ACTORS=/absolute/path/to/.local/cloud-actors.json \
bun run e2e:parity
```

Missing, expired or mismatched sessions fail explicitly. For an anonymous check,
use `bun run e2e:cloud --test-name 'cloud endpoint'` with only `E2E_CLOUD_URL`.

### Workflow durability during a host deployment

The confirmed-write timeout scenario first commits a control mutation. Its
second mutation inserts and reads a row inside the transaction, then starts a
separate workflow as a durable observation before waiting beyond its timeout.
The scenario requires that observation and checks that the row remains absent
after the authored body would otherwise have returned.

The sleep scenario defaults to one second. On a dedicated deployed stage, set
`E2E_WORKFLOW_HOLD_MS=180000` to provide a three-minute host deployment window:

```sh
# Also supply E2E_CLOUD_URL and E2E_CLOUD_ACTORS as above.
E2E_WORKFLOW_HOLD_MS=180000 bun run e2e:cloud --test-name 'workflow sleep preserves'
```

Wait for `Workflow sleep window` and inspect the native Cloudflare instance to
confirm an unfinished sleep before deploying the same stage through Alchemy.
The case saves `sleeping-workflow.json` with the run ID. Capture the Worker
deployment and instance version before and after deployment, while the sleep
is still pending. After completion, `completed-workflow.json` identifies the
original run and a fresh run. Require a changed Worker deployment before the
sleep deadline, an unfinished sleep after that deployment, and successful
completion of both runs. The HTTP assertions require exactly one mutation
before and after each sleep. Record native workflow IDs separately: the
workflow `versionId` stayed unchanged across the verified Worker redeployment
and cannot be used as its Worker code version.

The suite does not deploy infrastructure itself. A passing sleep scenario alone
does not prove a host deployment overlapped it; retain the provider timestamps
and version evidence with the report. The runner only forwards the bounded
hold duration, never deployment credentials, into the test process.

## Existing failure

The original 1,000-account run preserved every account and selection but lost later
server telemetry before it reached Motel. That delivery assertion remains enabled;
this runner migration does not relax its timeout or reduce the default data volume.

## Driver references

Anomaly's [Terminal Control](https://github.com/anomalyco/terminal-control), installed
as `@kitlangton/terminal-control`, supplies the Claude PTY and terminal recording.
Its bundled native binary exports MP4 through ffmpeg. [Browser Control](https://github.com/anomalyco/browser-control)
was reviewed for existing-profile browser adoption and human handoff; browser tests
currently use isolated Playwright contexts.

### OAuth URL policy regression

`bun run e2e:self-host --test-name 'OAuth setup honors host URL policy'` exercises
the public hosted account routes. The managed self-host uses a named `.localhost`
callback with a static query parameter and one explicit HTTP origin exception.
The scenario checks HTTPS, the permitted HTTP origin and a denied different port.
It starts authorization with a synthetic manual client; it does not contact a live
provider. SDK protocol tests separately cover discovery, registration, code exchange,
refresh and callback parameter tampering through the production transport seam.

### Authored app observability

`app query traces connect browser, streamed host work, runtime and React commits`
uses a real app, checks two results while its stream is open, then closes it and
requires a complete parent graph. It checks linked source maps without embedded
source text, preserved drafts, and a deliberately failed subscription followed
by a linked retry. The failed attempt must also be present in the collector.

Self-host reads actual delivery through Motel. For a dedicated deployed Cloud
stage, bind `E2E_AXIOM_TOKEN` through the credential launcher and set
`E2E_AXIOM_DATASET=executor-next-test-traces` together with the normal attached
stage URL and private synthetic actor file. The query adapter reads only the
validated trace ID in the current run's time window. Personal Axiom tokens also
require `E2E_AXIOM_ORG_ID`; dataset-scoped API tokens do not. Partial or truncated
results fail; missing parents are never replaced by synthetic success records.
