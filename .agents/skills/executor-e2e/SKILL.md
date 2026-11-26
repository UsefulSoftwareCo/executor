---
name: executor-e2e
description: Add and run focused end-to-end coverage for Executor application features, bug fixes, and behavior-preserving refactors. Documentation and cosmetic-only edits do not need new scenarios.
---

# Verify through E2E

Read [e2e/README.md](../../../e2e/README.md) and the nearest scenario before writing a test. Follow [coding style](../../../notes/coding-style.md). All tests live in `e2e/` — unit tests are banned everywhere else.

## What to prove

- Trace the changed behavior to a real user journey or public API caller and add/extend the smallest scenario that proves it.
- For async UI, assert behavior across loading, failure, retry, and navigation transitions — and verify drafts/selections/dialogs survive refresh errors.
- Prove a new assertion fails against the unfixed code (or a temporary violation) before reporting it green.

## Boundary & conventions

- Scenarios live in `e2e/tests/` and must be registered in `e2e/test-plan.ts`.
- Use `@effect/vitest` (`layer`, `it.effect`) and injected services in `e2e/support/`. Never import product implementations, replace internal services, use Playwright's test runner, or wrap whole tests in `Effect.promise`.
- Wait on observable events (never arbitrary sleeps); release request holds in Effect scopes.
- Run only managed local targets with isolated ports/data; never run against shared stages or production.

## Run & report

- Build served assets first (`bun run e2e:prepare` for local/self-host), then run only named scenarios:
  `bun run e2e:self-host --test-name '<scenario name>'`
- Inspect the actual executed scenario count so a zero-match filter is never reported green.
- Report commands run, scenario outcomes, evidence path (`.local/e2e` prunes older runs), and anything unverified.
- Select all caller spec files in the PR's fenced ` ```e2e ` block (see [AGENTS.md](../../../AGENTS.md#prs-releases--workflow)).
- Delete obsolete scenarios (with their `test-plan.ts` entry) when they no longer guard real behavior. Fix flakes — never skip, retry, or pad deadlines.
