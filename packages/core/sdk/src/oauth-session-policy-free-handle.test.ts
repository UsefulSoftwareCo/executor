import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { collectTables, createExecutor } from "./executor";
import { createSqliteTestFumaDb } from "./sqlite-test-db";
import { Tenant } from "./ids";

// Regression test for the "Cannot read properties of undefined (reading
// 'tenant')" StorageError that shipped when `oauth.complete`'s policy-free
// `sessionFuma` handle (packages/core/sdk/src/executor.ts:
// `makeFumaClient(rootDbUntyped)`) ran a real `findFirst`/`deleteMany` against
// an `oauth_session` row with NO query context bound.
//
// `makeTestConfig`/`makeTestWorkspaceHarness` (test-config.ts) pre-wrap
// `config.db` with `withQueryContext(testDb.db, { tenant, subject })` BEFORE
// handing it to `createExecutor`, so `rootDbUntyped` inside `executor.ts`
// already carries a bound context in every other test in this package — the
// crash never reproduces there. Production hosts (apps/local, apps/cloud) pass
// a genuinely context-free `FumaDb` (built by `createExecutorFumaDb` /
// `createSqliteFumaDb`, with no `withQueryContext` applied) as `config.db`, so
// `rootDbUntyped` has no bound context and `sessionFuma` is the raw handle.
// This test reproduces that exact production shape by constructing the
// executor directly off `createSqliteTestFumaDb(...).db` (unbound), instead of
// going through the test-config helpers.
describe("oauth session lookup on a policy-free (context-unbound) handle", () => {
  it("does not throw when the root db has no bound owner-policy context", async () => {
    const tables = collectTables();
    const testDb = await createSqliteTestFumaDb({ tables, namespace: "oauth_policy_free_test" });

    const executor = await Effect.runPromise(
      createExecutor({
        tenant: Tenant.make("test-tenant"),
        onElicitation: "accept-all",
        db: testDb.db, // NOT wrapped with withQueryContext — matches production wiring.
      }),
    );

    try {
      // Before the fix, `oauth.complete`'s `deps.sessionFuma.use("oauth_session.findFirst", ...)`
      // dereferenced `context.tenant` on an undefined context and threw a
      // StorageError ("Cannot read properties of undefined (reading 'tenant')")
      // for ANY state, even one that doesn't exist. After the fix, a
      // policy-free read with no matching row cleanly reports "not found"
      // instead of crashing.
      const result = await Effect.runPromiseExit(
        executor.oauth.complete({
          state: "nonexistent-state" as never,
          code: "unused",
          callbackDomain: null,
        } as never),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        const failure = JSON.stringify(result.cause);
        expect(failure).not.toContain("Cannot read properties of undefined");
        expect(failure).not.toContain("reading 'tenant'");
      }

      // `cancel` exercises the same policy-free handle's deleteMany path. The
      // owned-table delete policy is visibility-only (unlike create/update), so
      // an absent context is allowed and the service's explicit tenant+state
      // predicate remains the complete isolation boundary.
      await expect(
        Effect.runPromise(executor.oauth.cancel("nonexistent-state" as never)),
      ).resolves.toBeUndefined();
    } finally {
      if (executor.close) await Effect.runPromise(executor.close());
      await testDb.close();
    }
  });
});
