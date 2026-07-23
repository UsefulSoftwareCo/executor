# Executor policy

Stable contracts live here. Current setup and server mechanics are in
[RUNNING.md](RUNNING.md); e2e invariants are in
[e2e/AGENTS.md](e2e/AGENTS.md). Run `bun run bootstrap` in every fresh rift.

## Verification and evidence

- Tests use Effect Vitest. Run scoped tests with `vitest run ...` or the
  package script. Never use `bun test`.
- Use the narrowest meaningful verification while iterating. Merge-ready gates
  are `bun run format:check`, `lint`, `typecheck`, and `test`.
- Run `bun run format` before a PR and include only files owned by the branch.
- User-visible work requires a specific e2e run, a browsable dev instance, and
  the recording or trace showing what to inspect. Add a scenario when none
  covers the changed behavior.

## Service emulators

Tests and demos that need an upstream API, OAuth/OIDC provider, or webhook use
the published `@executor-js/emulate` emulators rather than stubs. They provide
wire-level state, real-shaped credentials, OpenAPI descriptions, and request
ledgers. Create per-run hosted instances through the service's
`/_emulate/instances` control route.

Emulate is a separate project. Make emulator changes there and consume the
published package here; never re-vendor or create a parallel fake inside
executor.

## Engineering boundaries

- Prefer correctness and predictable behavior over short-term convenience.
- Preserve runtime behavior during lint, typing, and test-structure changes.
- Use public package exports; never cross package boundaries with relative
  imports.
- Extract shared logic only for genuinely shared behavior. Avoid generic
  abstractions for one-off duplication.
- Public PRs, commits, generated files, and documentation contain no private
  names, internal context, customer-derived data, or AI attribution.

## Package ownership

- `packages/core/sdk`: contracts, plugin wiring, scopes, integrations, secrets,
  policies, and fixtures. Shared HTTP auth vocabulary lives in
  `@executor-js/sdk/http-auth`; core remains carrier-agnostic.
- `packages/core/storage-*`: storage adapters and test support.
- `packages/plugins/*`: protocol/provider implementations and their runtime,
  React, API, and testing helpers.
- `packages/react`: shared React UI and client/atom integration.
- `packages/hosts/mcp`: MCP host surface.
- `packages/kernel/*`: execution runtimes and code-execution substrate.
- `apps/{local,cloud,cli,desktop}`: product composition roots.

Record mistakes in `MISTAKES.md`, missing capabilities in `DESIRES.md`, and
environment discoveries in `LEARNINGS.md`.
