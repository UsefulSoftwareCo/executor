# Witness + Executor

[Witness](https://github.com/texasich/witness) is an evidence-first QA tool that drives real desktop browsers (via [cua-driver](https://github.com/trycua/cua)) through test flows, records video evidence, and reports pass/fail — all from a simple YAML spec.

This is a direct response to [@RhysSullivan's request](https://x.com/rhyssullivan/status/2069637281963708459) for an "OpenDevin for autonomous QA":

> "the idea here is you give the agent the same tools that you use to develop and use your product, think codex computer use but if it could be turned into e2e tests as well"

## Quick start

```bash
pip install git+https://github.com/texasich/witness.git
witness init
witness test witness.yaml
```

## Example: Testing the Executor CLI

```yaml
name: "Executor CLI QA"
target: terminal
steps:
  - action: type
    value: "executor tools sources"
  - action: press_key
    key: enter
  - wait: 2
  - assert:
      text_contains: "sources"
```

## How it works with Executor

Witness can use Executor as its tool backend — any tool registered in Executor (OpenAPI, GraphQL, MCP) can be called during test flows:

```yaml
name: "API + UI E2E"
target: https://myapp.com
browser: chrome
steps:
  # Use Executor to reset test state via API
  - action: executor_call
    tool: "myapp resetTestData"
    args: '{"user": "test@example.com"}'

  # Then drive the real browser
  - action: navigate
    value: https://myapp.com/login
  - action: type
    target: "Email"
    value: "test@example.com"
  - assert:
      text_contains: "Welcome back"
```

## Architecture

```
witness.yaml → witness CLI → cua-driver → Real Chrome (background, no focus steal)
                    │
                    ├── Video recording (recording.mp4)
                    ├── Per-step screenshots
                    ├── UIA tree snapshots
                    └── results.json (structured pass/fail)
                    │
                    └── Optional: Executor tools for API/state management
```

## Status

- ✅ Real Chrome automation (no headless Playwright)
- ✅ Natural language element targeting ("checkbox near Buy groceries")
- ✅ Video evidence on every run
- ✅ Cross-platform (Windows, macOS, Linux)
- ✅ MIT license
- ⬜ CDP integration (network HAR, console logs)
- ⬜ Playwright script output
- ⬜ Self-contained report.html

Built by [@quant_papi](https://x.com/quant_papi) — feedback and contributions welcome.
