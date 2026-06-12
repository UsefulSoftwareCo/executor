# Evals — do models do what we expect without much prompting?

Real-inference evals for the agentic surface. NOT capability benchmarks: each
task asks one product question — _given a fresh workspace and a one-line user
ask, does a real agent driving our real MCP server land on the behavior we
designed?_ The tool descriptions are the only steering; if a task needs
system-prompt coaching to pass, that's a finding about the descriptions.

## How it works

- **Client**: the real OpenCode binary (`opencode run --format json`), in a
  hermetic home (own XDG dirs, recorded `open`(1) shim), against the same
  selfhost target the e2e scenarios use. The agent's MCP server is the target's
  `/mcp` — OAuth, execute, approval pause/resume all genuine.
- **Inference**: the OpenCode Go subscription (`opencode/<model>` ids). The
  host machine's Go credential (`~/.local/share/opencode/auth.json`) is copied
  into each trial's hermetic home — models and quotas below.
- **Grading**: deterministic, no LLM judges. Three buckets per trial:
  1. _Outcome_ — workspace state via the typed HTTP API (integration exists,
     auth methods derived, connection created) and provider-side evidence via
     the emulator's request ledger.
  2. _Process_ — transcript checks: the handoff URL was surfaced; the
     credential value never appears in the transcript; the agent didn't ask
     the user to paste the key into chat.
  3. _Budget_ — finished under a wall-clock timeout (per-task) without
     erroring out.
- **Scoring**: models are sampled, so single runs can't gate anything. Each
  task×model runs N trials (default 3, `EVAL_TRIALS`); the report is a
  pass-rate matrix written to `runs/evals/` (one dir per trial with the full
  JSON event transcript, plus `report.json` + `report.md` aggregates).

## Running

```sh
cd e2e
EVAL=1 npm run test:evals                 # default model set, 3 trials each
EVAL=1 EVAL_MODELS=opencode/deepseek-v4-flash EVAL_TRIALS=1 npm run test:evals
EVAL=1 E2E_SELFHOST_URL=http://localhost:4799 npm run test:evals   # attach
```

Without `EVAL=1` the project is skipped entirely — evals never run on the PR
path. They burn subscription quota and take minutes per model; run them
on-demand or nightly.

## Model notes (OpenCode Go subscription)

Quota per model (requests / 5h / week / month) as of 2026-06-11 — pick the
default matrix to spread load across separate quota pools:

| Model (Go name)   | opencode id                  | 5h     | week   | month   | notes                                 |
| ----------------- | ---------------------------- | ------ | ------ | ------- | ------------------------------------- |
| DeepSeek V4 Flash | `opencode/deepseek-v4-flash` | 31,650 | 79,050 | 158,150 | default: huge quota, cheap canary     |
| MiniMax M2.5      | `opencode/minimax-m2.5`      | 6,300  | 15,900 | 31,800  | default: mid tier                     |
| Kimi K2.5         | `opencode/kimi-k2.5`         | 1,850  | 4,630  | 9,250   | default: strong tool-caller           |
| GLM-5.1           | `opencode/glm-5.1`           | 880    | 2,150  | 4,300   | scarce — occasional runs only         |
| GLM-5             | `opencode/glm-5`             | 1,150  | 2,880  | 5,750   |                                       |
| Kimi K2.6         | `opencode/kimi-k2.6`         | 1,150  | 2,880  | 5,750   |                                       |
| MiMo-V2.5 (free)  | `opencode/mimo-v2.5-free`    | 30,100 | 75,200 | 150,400 | id is `-free`; Pro tier not exposed   |
| MiniMax M2.7      | `opencode/minimax-m2.7`      | 3,400  | 8,500  | 17,000  |                                       |
| Qwen3.6 Plus      | `opencode/qwen3.6-plus`      | 3,300  | 8,200  | 16,300  | quota table's 3.7 ids not exposed yet |
| DeepSeek V4 Pro   | `opencode/deepseek-v4-pro`   | 3,450  | 8,550  | 17,150  |                                       |

A full default run (2 tasks × 3 models × 3 trials = 18 sessions, each a
handful of requests) is well inside every 5-hour window.

## Adding a task

A task is a file in `evals/tasks/` registering with `evalTask()`: a user
prompt, a setup Effect (seed state, mint emulator credentials), and a grade
function over `{ transcript, events, api, target }`. Keep grading boolean and
observable — if you can't assert it from workspace state, the emulator ledger,
or the transcript text, reconsider the task.

## Findings log

Date-stamped observations from runs land here (what models did unexpectedly,
description tweaks made because of it):

- **2026-06-11 · harness**: `opencode run` inherits the runner's `PWD`; with
  it pointing at our repo checkout the models ignored the MCP server and
  spelunked the codebase (reading `evals/tasks.ts` — the eval's own grading —
  via glob/read). Fixed by pinning `PWD` to the hermetic project dir. Eval
  prompts also anchor "in my Executor workspace (the executor MCP server)";
  without that, models treated the ask as a coding task.
- **2026-06-11 · minimax-m2.5**: connect-handoff FAILS on discovery — its
  `tools.search` queries ("add connection integration", "add api connection")
  never surfaced `executor.openapi.addSpec`, so it gave up and asked the user
  for documentation. deepseek + kimi found it via "resend"/"openapi"-flavored
  queries. Finding: addSpec's searchable text doesn't match connection-flavored
  phrasings — worth adding "connect"/"add API" vocabulary to its description
  (ties into the tool-description audit).
- **2026-06-11 · deepseek-v4-flash**: connect-handoff PASSES (registers via
  `openapi.addSpec` with derived auth, surfaces the handoff URL, doesn't ask
  for the key). credential-hygiene FAILS: when the user volunteers the key in
  chat, the model passes it through `connections.create` directly instead of
  routing to the handoff URL — `createHandoff`'s "do not collect credential
  values in chat" instruction doesn't deter use of a key already in context.
  Candidate fixes to evaluate: strengthen `connections.create`'s description
  (only for programmatic flows; prefer createHandoff when a human supplied
  the value), or a policy-level guard.
