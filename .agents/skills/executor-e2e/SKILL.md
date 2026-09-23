---
name: executor-e2e
description: Add and run focused end-to-end coverage for Executor application features, bug fixes, and behavior-preserving refactors. Use the existing real-server suite and evidence reports. Documentation and cosmetic-only edits do not need new scenarios.
---

# Verify the feature through the product

Read [the suite guide](../../../e2e/README.md) and the nearest relevant scenario
before writing a test. Follow the project's [engineering guidance](../../../notes/coding-style.md).
Keep verification proportional to the requested change; respect explicit prototype
or discussion-only limits.

## Choose what the test must prove

Trace the changed behavior to a real user journey or public API caller. Identify
the observable outcome before editing the implementation. Add or extend the
smallest scenario that proves it; reuse existing coverage when it already does.

For asynchronous UI, exercise a user interaction across the loading, failure,
retry, or navigation transitions relevant to the change. Assert the required
behavior at those checkpoints. A final screenshot or successful request alone
does not prove the intermediate behavior. Choose the journey from the actual
callers of the changed code, not merely a nearby page that is easy to test.

When the affected view owns a draft, selection, or open dialog, carry that state
through the relevant transition and assert it survives. Keep intentional resets
when the user changes resources. See [the refresh scenarios](../../../e2e/tests/query-refresh.spec.ts)
and [local live-read scenarios](../../../e2e/tests/local-query-state.spec.ts) for
examples through actual product surfaces.

Check that the new assertion can reject the behavior it is meant to prevent.
For a bug fix, run it against the unfixed code. For a feature or refactor, use a
small, temporary violation of the selected requirement when practical. Restore
the intended implementation, rebuild affected assets, and rerun the scenario.
Record the failing assertion; a setup error or unrelated timeout is not proof.

Review coverage separately from implementation: compare the required behavior
with the assertions that actually ran. If a transition cannot be reached, keep
that gap explicit. Replacing it with an easier state does not verify the original
requirement, even when the narrower test passes.

## Use the existing boundary

Scenarios live in `e2e/tests/`; register new scenarios and their target applicability
in `e2e/test-plan.ts`. Use `@effect/vitest` and the existing injected services in
`e2e/support/`. Keep browser SDK calls inside `Browser.use` or focused adapters.
Do not add a second runner, import application implementations, replace internal
services, or weaken the boundary checker.

Use real servers, synthetic actors, and public HTTP, MCP, or browser interactions.
Control slow or failed requests at the external boundary when the scenario needs
them. Wait for observable events instead of arbitrary sleeps. Effect scopes must
release request holds and clean up resources, including on assertion failure.
Confirm that an intercepted request actually arrived before asserting its pending
state. Hosted reads can change from a URL slug to a verified organization ID;
the [query transition helper](../../../e2e/support/query-transition.ts) accepts both paths.

Use a managed local target for ordinary development. Shared environments,
deployments, and production data are not test fixtures. Each working area owns
its ports, test data, and subprocesses; do not stop another worker's services.

## Execute and retain evidence

Build the assets the scenario serves. For self-host and local targets, run
`bun run e2e:prepare` after application changes. Run the relevant named scenario,
for example `bun run e2e:self-host --test-name '<scenario name>'`. Follow the suite
guide for Cloud and other prerequisites; run only the targets the change needs.

`bun run e2e:check` and `bun run check` validate test code but do not execute the
browser journeys. Inspect the run's actual scenario count and outcome so a
filtered-out test cannot be reported as passing.

For loading or layout changes, use the existing [storyboard workflow](../../../notes/ui-state-exploration.md)
and review relevant captured states. Screenshots explain the result; assertions
make behavioral regressions fail automatically.

Report the commands and scenario that ran, the outcome, the saved evidence path,
and any behavior or target left unverified. Diagnose failures within the task's
scope; do not skip cases, loosen assertions, or call a blocked run a pass.
