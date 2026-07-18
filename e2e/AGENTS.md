# E2E policy

Detailed target setup, commands, ports, desktop VM operation, endpoint
discovery, viewer usage, and recording workflows live in
[RUNNING.md](RUNNING.md). Read only the relevant section for the task.

## Scenario structure

- Put cross-target scenarios in `scenarios/*.test.ts`; target-specific suites
  stay under their target directory.
- Declare capabilities by yielding services from `src/services.ts` (`Target`,
  `Api`, `Browser`, `Mcp`, `Billing`, `Cli`, `Telemetry`, and others). Do not
  add a separate capability list. Unsupported targets skip and record why.
- Create fresh identities and organizations through `Target`. Never depend on
  shared state or customer-derived fixtures.
- Clean up created resources with `Effect.ensuring`; trailing cleanup statements
  are insufficient because mid-test failures must not leak state.
- Assert through the real typed API, browser, MCP, CLI, emulator ledger, or
  exported telemetry surface. Do not reach into implementation internals to
  make a scenario pass.

## Browser and telemetry

- Wrap browser work in `browser.session(identity, ...)` and use `step` labels
  phrased as user actions. Prefer role-based locators and wait for navigation or
  network settling after actions that change pages.
- Browser sessions produce screenshots, video, and a Playwright trace. Do not
  add separate recording machinery for ordinary scenarios.
- Telemetry assertions target spans that reached the motel store, not values
  stamped only inside application memory. Export is eventually consistent, so
  use the provided polling helpers.

## Isolation and quality

- Never hardcode ports or attach to an arbitrary existing server. Use the
  checkout's claimed port block or explicit `E2E_<TARGET>_URL` attachment.
- Test the user-visible contract and important failure path, not selectors or
  implementation details alone.
- Run the narrowest relevant target while iterating. Before handoff, provide the
  viewer/run URL, recording or trace, and the exact outcome to inspect.
- Do not weaken, skip, or rewrite a failing assertion merely to make the suite
  green. Fix the product, fixture, or scenario contract.
