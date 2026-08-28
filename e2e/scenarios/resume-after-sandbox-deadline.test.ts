// Cross-target: approval durability against the sandbox clock — the "a human
// is allowed to take a few minutes" promise. A paused execution suspends the
// sandbox mid-call, but the sandbox's execution deadline (5 minutes) used to
// keep ticking while the human decided. Each pause advertises its own
// approval window, so with chained approvals a later window legitimately
// extends past the sandbox's absolute clock: the human answers every window
// on time, yet the fiber is already dead and the final approval lands on an
// unknown execution.
//
// The journey drives exactly that shape: ONE execution with TWO approval
// gates. The first approval is granted late (70% of the sandbox budget in),
// so the second pause's window reaches well past the budget. The second
// approval arrives at ~115% of the budget after execution start — inside its
// OWN advertised window, but past the old absolute deadline. The subject is
// that RATIO, not any absolute duration, so the delays scale off the budget
// the target was booted with: selfhost boots with a seconds-long
// EXECUTOR_SANDBOX_TIMEOUT_MS (setup/sandbox-timeout.ts) and proves the race
// in ~25s; a target on the production 5-minute budget runs the original
// ~6-minute journey (the elapsed time IS the subject — nothing is mocked). A
// single-pause variant cannot express this cross-target — hosts that
// advertise a 4-minute window would expire it legitimately before the
// sandbox clock even matters.
//
// The gate is `policies.create`'s own `requiresApproval` annotation
// (hermetic, same device as policy-tool-approval.test.ts); both approvals
// happen in the same MCP session, so the only variable is elapsed time.
import { randomUUID } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";
import { configuredMcpPausedSessionIdleTimeoutMs } from "../setup/mcp-session-timeouts";
import { configuredSandboxTimeoutMs } from "../setup/sandbox-timeout";

const coreApi = composePluginApi([] as const);

const SANDBOX_BUDGET_MS = configuredSandboxTimeoutMs();

// Grant the first approval at 70% of the budget — late but inside its window
// (was 3.5 of 5 min). The second pause then opens a fresh window reaching
// past the budget.
const FIRST_APPROVAL_DELAY_MS = 0.7 * SANDBOX_BUDGET_MS;
// Grant the second approval 45% of the budget later: ~115% of the budget
// after execution start, past the sandbox clock but inside the second window
// (was 2.25 of 5 min → ~5.75 min total).
const SECOND_APPROVAL_DELAY_MS = 0.45 * SANDBOX_BUDGET_MS;
// The whole journey plus scheduling slack, for the idle-window guard and the
// vitest timeout.
const JOURNEY_MS = FIRST_APPROVAL_DELAY_MS + SECOND_APPROVAL_DELAY_MS;

/** Sandbox code that creates two policies through the approval-gated core
 *  tool. Patterns are unique-per-run and match no real tool, so the rules are
 *  inert even if leaked. */
const createPoliciesCode = (firstPattern: string, secondPattern: string) => `
const first = await tools.executor.coreTools.policies.create({
  owner: "user",
  pattern: ${JSON.stringify(firstPattern)},
  action: "block",
});
const second = await tools.executor.coreTools.policies.create({
  owner: "user",
  pattern: ${JSON.stringify(secondPattern)},
  action: "block",
});
return JSON.stringify({ first: first.ok, second: second.ok });
`;

// The journey spans the whole paused waiting time, so the host must keep the
// paused session alive that long. The suite's default e2e override shrinks
// the paused-session idle teardown to seconds (to keep teardown tests fast),
// which would evict the session mid-scenario for reasons unrelated to the
// clock under test — require a window that outlasts the journey instead.
// With a shrunken sandbox budget the journey shrinks too, so even the short
// e2e idle window can suffice; the guard compares the two rather than
// hardcoding either.
const PAUSED_IDLE_WINDOW_TOO_SHORT =
  configuredMcpPausedSessionIdleTimeoutMs() < JOURNEY_MS + 60_000
    ? `the target's paused-session idle teardown (${configuredMcpPausedSessionIdleTimeoutMs()}ms) evicts the session before this ${Math.round(JOURNEY_MS / 1000)}s journey completes; boot the target with MCP_PAUSED_SESSION_IDLE_TIMEOUT_MS >= ${JOURNEY_MS + 60_000} or a smaller E2E_SANDBOX_TIMEOUT_MS to run it`
    : undefined;

scenario(
  "MCP · chained approvals granted within their windows survive the sandbox clock",
  { timeout: Math.max(120_000, JOURNEY_MS + 120_000), skip: PAUSED_IDLE_WINDOW_TOO_SHORT },
  Effect.gen(function* () {
    const target = yield* Target;
    const apiSurface = yield* Api;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const client = yield* apiSurface.client(coreApi, identity);
    const runId = randomUUID().slice(0, 8);
    const firstPattern = `resume-deadline-a-${runId}.*`;
    const secondPattern = `resume-deadline-b-${runId}.*`;

    const cleanup = client.policies.list().pipe(
      Effect.flatMap((list) =>
        Effect.forEach(
          list.filter((p) => p.pattern === firstPattern || p.pattern === secondPattern),
          (p) =>
            client.policies
              .remove({ params: { policyId: p.id }, payload: { owner: "user" } })
              .pipe(Effect.ignore),
        ),
      ),
      Effect.ignore,
    );

    yield* Effect.gen(function* () {
      const session = mcp.session(identity);
      const tools = yield* session.listTools();
      expect(tools).toContain("execute");

      const paused = yield* session.call("execute", {
        code: createPoliciesCode(firstPattern, secondPattern),
      });
      expect(paused.text, "the first gated call paused for approval").toContain("Execution paused");
      const firstMatch = /\bexecutionId:\s*(\S+)/.exec(paused.text);
      expect(firstMatch, "the first pause carries an executionId").not.toBeNull();

      // The human takes most of the first approval window before deciding.
      yield* Effect.sleep(`${FIRST_APPROVAL_DELAY_MS} millis`);

      const secondPaused = yield* session.call("resume", {
        executionId: firstMatch![1]!,
        action: "accept",
        content: JSON.stringify({}),
      });
      expect(
        secondPaused.text,
        "the on-time first approval reaches its pause and surfaces the second gate",
      ).toContain("Execution paused");
      const secondMatch = /\bexecutionId:\s*(\S+)/.exec(secondPaused.text);
      expect(secondMatch, "the second pause carries an executionId").not.toBeNull();

      // The second decision lands past the sandbox's 5-minute budget (counted
      // from execution start) but well inside the second advertised window.
      yield* Effect.sleep(`${SECOND_APPROVAL_DELAY_MS} millis`);

      const resumed = yield* session.call("resume", {
        executionId: secondMatch![1]!,
        action: "accept",
        content: JSON.stringify({}),
      });

      expect(
        resumed.text,
        "the second on-time approval reaches a live pause instead of a dead or unknown execution",
      ).not.toMatch(/Paused execution is unknown|Paused execution expired|timed out after/);
      expect(resumed.ok, "the fully approved execution completed without error").toBe(true);

      // Both approvals took effect: the gated tool ran twice.
      const afterApproval = yield* client.policies.list();
      expect(
        afterApproval.some((p) => p.pattern === firstPattern),
        "the first gated tool ran after its approval",
      ).toBe(true);
      expect(
        afterApproval.some((p) => p.pattern === secondPattern),
        "the second gated tool ran after the late-but-in-window approval",
      ).toBe(true);
    }).pipe(Effect.ensuring(cleanup));
  }),
);
