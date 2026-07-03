// Cloud-only (billing): the pre-execution guards that sit in front of the MCP
// session Durable Object's execution engine. Two independent gates run before
// every new `execute`:
//
//   - the BALANCE gate consults Autumn's `balances.check` and blocks once an
//     org has used its plan's included executions, and
//   - the RATE-LIMIT backstop counts executions per org per hour and blocks
//     runaway automation even when billing is down.
//
// Both FAIL OPEN: an Autumn error or timeout must never take executions down
// with the billing provider. These scenarios pin all four behaviours end to
// end against the real workerd + McpSessionDO topology, driving a real MCP
// client and reading Autumn's own ledger as ground truth — a blocked execution
// must not reach the meter, and a failed-open one must show the check was
// actually attempted (and faulted) rather than silently skipped.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import {
  EXECUTION_LIMIT_BLOCKED_MESSAGE,
  RATE_LIMIT_BLOCKED_MESSAGE,
} from "../../apps/cloud/src/engine/execution-limit-messages";
import { scenario } from "../src/scenario";
import { Autumn, Billing, Mcp, Target } from "../src/services";
import { E2E_EXECUTION_RATE_LIMIT } from "../setup/execution-limits";
import type { Identity } from "../src/target";

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

/** The org the bearer is scoped to — the Autumn customer id the guards decide
 *  against — read from the JWT's public claims. */
const orgIdOf = (bearer: string): string => {
  const claims = JSON.parse(Buffer.from(bearer.split(".")[1] ?? "", "base64url").toString()) as {
    readonly org_id?: string;
  };
  if (!claims.org_id) throw new Error("orgIdOf: bearer carries no org_id claim");
  return claims.org_id;
};

// The e2e worker is booted with a small EXECUTION_RATE_LIMIT_PER_HOUR so the
// backstop is reachable with real executions (cloud.boot.ts). The prod cap of
// 1000/hour can't be. One shared constant (setup/execution-limits.ts) keeps
// this and the boot env from drifting apart.
const RATE_LIMIT = E2E_EXECUTION_RATE_LIMIT;

scenario(
  "Billing · an org out of executions is blocked before the code ever runs",
  { timeout: 180_000 },
  Effect.gen(function* () {
    // Gates: billing is enforced here AND the Autumn ledger is observable.
    // Yield before any work so a target missing either capability skips cleanly.
    yield* Billing;
    const autumn = yield* Autumn;
    const target = yield* Target;
    const mcp = yield* Mcp;

    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    const customerId = orgIdOf(bearer);

    // Burn the whole included allotment so the org's remaining balance is zero.
    // This records one `balances.track` event (the plan's included amount) —
    // the baseline the blocked execution is measured against below.
    yield* autumn.exhaustExecutions(customerId);
    const afterExhaust = yield* autumn.usageEvents({ customerId, featureId: "executions" });
    expect(afterExhaust.length, "exhausting the balance records exactly one usage event").toBe(1);

    // A NEW MCP session => a fresh session DO => a fresh gate cache, so the
    // balance is checked live (no 60s stale-allow window from a prior session).
    const session = mcp.session(identity);
    const result = yield* session.call("execute", { code: "return 1 + 1;" });

    expect(result.ok, "a blocked execution surfaces as an MCP error result").toBe(false);
    expect(result.text, "the client sees the execution-limit message").toContain(
      EXECUTION_LIMIT_BLOCKED_MESSAGE,
    );

    // The meter is the source of truth: a blocked execution is neither run nor
    // usage-tracked. Give any (erroneous) fire-and-forget track ample time to
    // land, then assert nothing beyond the exhaust event was recorded.
    const settle = yield* autumn.usageEvents({ customerId, featureId: "executions" });
    expect(settle.length, "the blocked execution adds no 'executions' usage event").toBe(
      afterExhaust.length,
    );
  }),
);

scenario(
  "Billing · a balance-check failure fails open and still runs the execution",
  { timeout: 180_000 },
  Effect.gen(function* () {
    yield* Billing;
    const autumn = yield* Autumn;
    const target = yield* Target;
    const mcp = yield* Mcp;

    const identity = yield* target.newIdentity();

    yield* Effect.gen(function* () {
      // One-shot 500 on the very next balances.check the gate makes.
      yield* autumn.armFault({
        match: { operationId: "balances.check" },
        response: { status: 500, body: { message: "emulated billing outage" } },
        times: 1,
      });

      const session = mcp.session(identity);
      const result = yield* session.call("execute", { code: "return 6 * 7;" });

      // Fail open: the outage must not block a solvent org's execution.
      expect(result.ok, "the execution succeeds despite the billing outage").toBe(true);
      expect(result.text, "it returns its value").toContain("42");

      // Proof the gate actually CONSULTED Autumn and failed open (rather than
      // never checking): the faulted balances.check is in the emulator ledger.
      const checks = yield* autumn.ledgerFor("balances.check");
      expect(
        checks.some((entry) => entry.faulted),
        "the gate's balances.check reached Autumn and was faulted",
      ).toBe(true);
    }).pipe(Effect.ensuring(autumn.clearFaults().pipe(Effect.ignore)));
  }),
);

scenario(
  "Billing · a balance-check timeout fails open and still runs the execution",
  { timeout: 180_000 },
  Effect.gen(function* () {
    yield* Billing;
    const autumn = yield* Autumn;
    const target = yield* Target;
    const mcp = yield* Mcp;

    const identity = yield* target.newIdentity();

    yield* Effect.gen(function* () {
      // The armed check stalls 3s before returning — past the gate's 2s budget,
      // so the gate times out client-side and fails open. (The response still
      // arrives after the delay; the ~2s added latency fits the timeout.)
      yield* autumn.armFault({
        match: { operationId: "balances.check" },
        response: { status: 200, body: { allowed: true } },
        times: 1,
        delayMs: 3000,
      });

      const session = mcp.session(identity);
      const result = yield* session.call("execute", { code: "return 21 * 2;" });

      expect(result.ok, "the execution succeeds despite the slow balance check").toBe(true);
      expect(result.text, "it returns its value").toContain("42");

      const checks = yield* autumn.ledgerFor("balances.check");
      expect(checks.length, "the gate did attempt the (stalled) balances.check").toBeGreaterThan(0);
    }).pipe(Effect.ensuring(autumn.clearFaults().pipe(Effect.ignore)));
  }),
);

scenario(
  "Billing · the rate-limit backstop blocks runaway executions and doesn't meter them",
  { timeout: 180_000 },
  Effect.gen(function* () {
    yield* Billing;
    const autumn = yield* Autumn;
    const target = yield* Target;
    const mcp = yield* Mcp;

    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    const customerId = orgIdOf(bearer);

    // All executions run in ONE session so the balance cache stays allowed
    // (the org is solvent) — only the per-org hourly counter should trip.
    const session = mcp.session(identity);

    // Run exactly the limit's worth of allowed executions.
    for (let i = 1; i <= RATE_LIMIT; i++) {
      const ok = yield* session.call("execute", { code: `return ${i};` });
      expect(ok.ok, `execution ${i} (within the limit) succeeds`).toBe(true);
    }

    // The next one crosses the hourly cap: blocked with the backstop message.
    const blocked = yield* session.call("execute", { code: "return 999;" });
    expect(blocked.ok, "the execution past the cap is an MCP error result").toBe(false);
    expect(blocked.text, "the client sees the rate-limit message").toContain(
      RATE_LIMIT_BLOCKED_MESSAGE,
    );

    // A rate-limited execution is neither run nor metered: exactly the allowed
    // runs reached the Autumn meter, and the blocked one added nothing.
    const metered = yield* autumn.expectUsage({
      customerId,
      featureId: "executions",
      count: RATE_LIMIT,
    });
    expect(metered.length, "only the allowed executions are metered — the blocked one is not").toBe(
      RATE_LIMIT,
    );
  }),
);
