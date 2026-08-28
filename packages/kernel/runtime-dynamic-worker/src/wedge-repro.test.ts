// ---------------------------------------------------------------------------
// RED-ON-MAIN REPRO of the wedged-evaluate incident.
//
// A wedged `evaluate()` RPC (resolves never, rejects never) used to leave the
// host awaiting forever: `execute()` never returned, so the MCP client saw pure
// silence (SSE keepalives, no JSON-RPC frame) for the DO's whole running-work
// lease. This test drives that exact shape through the PUBLIC executor path
// with a fake WorkerLoader whose loaded worker's `evaluate` never settles.
//
// On UNPATCHED main this test HANGS and fails only via the bounded per-test
// timeout below (verified: "Test timed out in 8000ms" on c46730b5). With the
// host-timeout backstop it resolves with a delivered, descriptive error inside
// the bound. The extra host-timeout knobs are passed through a widened options
// value so this file still compiles against a checkout that predates them (they
// are simply ignored there, and the test hangs → red).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { SandboxToolInvoker } from "@executor-js/codemode-core";

import { makeDynamicWorkerExecutor, type DynamicWorkerExecutorOptions } from "./executor";

const idleInvoker: SandboxToolInvoker = { invoke: () => Effect.succeed(undefined) };

const makeFakeLoader = (evaluate: () => Promise<unknown>) => {
  const entrypoint = { evaluate };
  const stub = { getEntrypoint: () => entrypoint };
  // oxlint-disable-next-line executor/no-double-cast -- test double for the Cloudflare WorkerLoader binding; only get()/getEntrypoint()/evaluate() are exercised
  return { get: () => stub, load: () => stub } as unknown as WorkerLoader;
};

const never = <A>(): Promise<A> => new Promise<A>(() => {});

describe("wedged evaluate RPC (public execute path)", () => {
  it(
    "delivers a descriptive timeout error instead of hanging forever",
    { timeout: 8_000 },
    async () => {
      // Widened so the host-timeout knobs (absent on pre-fix checkouts) don't
      // trip excess-property checks; they shrink the backstop on the fix and
      // are ignored on main.
      const options = {
        loader: makeFakeLoader(() => never()),
        timeoutMs: 200,
        hostTimeoutGraceMs: 100,
        hostTimeoutPollMs: 20,
      } as DynamicWorkerExecutorOptions & Record<string, unknown>;

      const executor = makeDynamicWorkerExecutor(options);
      const result = await Effect.runPromise(executor.execute("return 1;", idleInvoker));

      expect(result.result).toBeNull();
      expect(result.error).toBeDefined();
      expect(result.error).toContain("unresponsive");
    },
  );
});
