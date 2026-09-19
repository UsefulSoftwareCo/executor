import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";

import { makeInMemoryBlobStore, type BlobStore } from "./blob";
import {
  makePendingApprovalStore,
  PENDING_APPROVAL_TTL_MS,
  type PendingApproval,
} from "./pending-approval";

// ---------------------------------------------------------------------------
// Focused tests — pending-approval consume atomicity, deterministic layer.
//
// These tests pin the exactly-once consume invariant deterministically,
// plus the expiry/corrupt semantics required to survive the consume
// restructure. A companion fast-check property (concurrent consumes ⇒
// exactly one non-null) lives elsewhere.
//
// NOTE on test infrastructure:
// - it.effect runs under @effect/vitest's TestContext scheduler, where
//   Effect.sleep never advances — any async boundary deadlocks the test.
//   Sync-only effects work; async ones must go through Effect.runPromise in
//   a plain vitest test.
// - The concurrency proof needs the real scheduler AND an explicit
//   read-barrier: without one, the synchronous Map store completes each
//   consume before the next fiber starts, so the double-resume race can
//   never manifest and the test would be vacuous as a concurrency proof.
// ---------------------------------------------------------------------------

const approval = (overrides?: Partial<PendingApproval>): PendingApproval => ({
  executionId: "exec_1",
  artifactId: "art_1",
  code: 'return await tools.github.user.main.issues.create({"title":"x"})',
  address: "github.user.main.issues.create",
  expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
  ...overrides,
});

describe("approval consume atomicity (compareAndDelete gate)", () => {
  it("exactly one of N concurrent consumes wins (single-winner invariant)", async () => {
    const N = 8;
    const backing = makeInMemoryBlobStore();
    // Promise-latch barrier: every fiber increments the arrival count after
    // its read and parks on the shared promise, which resolves only when
    // all N have arrived — every read happens before any delete. Pure JS
    // promise semantics, immune to Effect scheduler/runtime differences.
    let arrived = 0;
    let releaseAll!: () => void;
    const allArrived = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const barrier: BlobStore = {
      ...backing,
      get: (ns, key) =>
        backing.get(ns, key).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              arrived++;
              if (arrived === N) releaseAll();
            }),
          ),
          // tap (not andThen — that would discard the payload): park until
          // every fiber has read, then pass the payload through untouched.
          Effect.tap(() => Effect.promise(() => allArrived)),
        ),
    };

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const store = makePendingApprovalStore(barrier, "u:t:s");
        yield* store.put(approval());

        const results = yield* Effect.all(
          Array.from({ length: N }, () => store.consume("exec_1")),
          { concurrency: "unbounded" },
        );
        const winners = results.filter(Predicate.isNotNull);

        // Post-condition: the record is gone for everyone.
        const after = yield* store.consume("exec_1");
        return { winners: winners.map((w) => w.address), after };
      }),
    );

    expect(outcome.winners.length).toBe(1);
    expect(outcome.winners[0]).toBe("github.user.main.issues.create");
    expect(outcome.after).toBeNull();
  });

  it.effect("a replayed consume after a win reads absent", () =>
    Effect.gen(function* () {
      const store = makePendingApprovalStore(makeInMemoryBlobStore(), "u:t:s");
      yield* store.put(approval());
      expect(yield* store.consume("exec_1")).not.toBeNull();
      expect(yield* store.consume("exec_1")).toBeNull();
      expect(yield* store.consume("exec_1")).toBeNull();
    }),
  );

  it.effect("expired records are consumed-and-dropped (never retried)", () =>
    Effect.gen(function* () {
      const blobs = makeInMemoryBlobStore();
      let now = 1_000_000;
      const store = makePendingApprovalStore(blobs, "u:t:s", () => now);
      yield* store.put(approval({ expiresAt: now + 10 }));

      now += 100; // expires
      expect(yield* store.consume("exec_1")).toBeNull();

      // The record is gone — rolling the clock back does not resurrect it.
      now = 1_000_000;
      expect(yield* store.consume("exec_1")).toBeNull();
    }),
  );

  it.effect("corrupt records are consumed-and-dropped (never surfaced)", () =>
    Effect.gen(function* () {
      const blobs = makeInMemoryBlobStore();
      yield* blobs.put("u:t:s/@pending-approval", "exec_1", "not-json{{");

      const store = makePendingApprovalStore(blobs, "u:t:s");
      expect(yield* store.consume("exec_1")).toBeNull();

      // Gone for good — a second consume finds nothing.
      expect(yield* store.consume("exec_1")).toBeNull();
    }),
  );
});
