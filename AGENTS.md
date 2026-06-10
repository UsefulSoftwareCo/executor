# AGENTS.md

## Task Completion Requirements

- Use Effect Vitest for tests.
- Run targeted tests with `vitest run ...` when working on a scoped area.
- The root/package `bun run test` scripts are allowed because they delegate to
  Vitest.
- NEVER run `bun test`.
- For code changes, run the narrowest useful verification before handing back.
- For broad or merge-ready changes, the full gates are `bun run format:check`,
  `bun run lint`, `bun run typecheck`, and `bun run test`.

## Attribution

Do not add any AI assistant, Claude, Anthropic, or Co-Authored-By
attribution/trailers to commits, commit messages, PRs, or generated files.

Pull request titles and descriptions are going to a public GitHub repo, so
avoid using specific names or internal info unless explicitly stated to.

## Collaboration Notes

The user uses speech to text occasionally, so if sentences are weird or words
are not right, infer the likely intent and ask only when needed.

Code is very cheap to write. Do not give time estimates; with agents, code is
practically instant to generate. Unless stated otherwise, time to implement is
not a blocker.

## Reference Repos

Repos in `.reference`, such as Effect and effect-atom, are available for
patterns. If given a Git URL for reference, clone it into `.reference` and
inspect it there. Make sure to pull the latest changes from the reference repo
before using it.

## Engineering Priorities

- Prefer correctness and predictable behavior over short-term convenience.
- Preserve runtime behavior when changing lint, typing, or test structure.
- Keep package boundaries clear; use public package exports instead of relative
  imports across package roots.
- Extract shared logic only when the shared behavior is real and local patterns
  support it. Avoid broad generic abstractions for one-off duplication.

## Package Roles

- `packages/core/sdk`: executor core contracts, plugin wiring, scopes, sources,
  secrets, policies, and test fixtures. The `@executor-js/sdk/http-auth`
  subpath carries the shared placements-based auth-method vocabulary the HTTP
  protocol plugins compose (core itself never imports it — composition, not
  location, keeps core carrier-agnostic).
- `packages/core/storage-*`: storage adapters and storage test support.
- `packages/plugins/*`: protocol and provider plugins. Plugin-specific
  runtime, React, API, and testing helpers should live with the owning plugin.
- `packages/react`: shared React UI and atom/client integration.
- `packages/hosts/mcp`: MCP host surface for exposing Executor through MCP.
- `packages/kernel/*`: execution runtimes and code execution substrate.
- `apps/local`, `apps/cloud`, `apps/cli`, and `apps/desktop`: product entry
  points that compose the packages.

## Other

Please make note of mistakes you make in MISTAKES.md. If you find you wish you had more context or tools, write that down in DESIRES.md. If you learn anything about your env write that down in LEARNINGS.md.
