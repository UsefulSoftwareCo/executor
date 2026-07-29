import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeInMemoryBlobStore } from "./blob";
import {
  makePendingApprovalStore,
  PENDING_APPROVAL_TTL_MS,
  type PendingApproval,
} from "./pending-approval";

const approval = (overrides?: Partial<PendingApproval>): PendingApproval => ({
  executionId: "exec_1",
  artifactId: "art_1",
  code: 'return await tools.github.user.main.issues.create({"title":"x"})',
  address: "github.user.main.issues.create",
  expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
  ...overrides,
});

describe("makePendingApprovalStore", () => {
  it.effect("round-trips a recorded approval", () =>
    Effect.gen(function* () {
      const store = makePendingApprovalStore(makeInMemoryBlobStore(), "u:t:s");
      const recorded = approval();
      yield* store.put(recorded);

      expect(yield* store.consume("exec_1")).toStrictEqual(recorded);
    }),
  );

  // The whole point of the record: the engine that paused is gone, so the
  // approval has to be readable by a caller that never saw the pause.
  it.effect("is readable through a second store over the same partition", () =>
    Effect.gen(function* () {
      const blobs = makeInMemoryBlobStore();
      yield* makePendingApprovalStore(blobs, "u:t:s").put(approval());

      const resumingRequest = makePendingApprovalStore(blobs, "u:t:s");
      expect((yield* resumingRequest.consume("exec_1"))?.address).toBe(
        "github.user.main.issues.create",
      );
    }),
  );

  // One approval authorizes one invocation. A replayed resume must not be able
  // to run the call a second time.
  it.effect("consumes the record, so a second resume finds nothing", () =>
    Effect.gen(function* () {
      const store = makePendingApprovalStore(makeInMemoryBlobStore(), "u:t:s");
      yield* store.put(approval());

      expect(yield* store.consume("exec_1")).not.toBeNull();
      expect(yield* store.consume("exec_1")).toBeNull();
    }),
  );

  // Ownership is the partition, not a separate check that could drift from it.
  it.effect("is invisible to a different owner partition", () =>
    Effect.gen(function* () {
      const blobs = makeInMemoryBlobStore();
      yield* makePendingApprovalStore(blobs, "u:t:alice").put(approval());

      const mallory = makePendingApprovalStore(blobs, "u:t:mallory");
      expect(yield* mallory.consume("exec_1")).toBeNull();
    }),
  );

  it.effect("treats an expired record as absent", () =>
    Effect.gen(function* () {
      const blobs = makeInMemoryBlobStore();
      const now = 1_000_000;
      const store = makePendingApprovalStore(blobs, "u:t:s", () => now);
      yield* store.put(approval({ expiresAt: now - 1 }));

      expect(yield* store.consume("exec_1")).toBeNull();
    }),
  );

  it.effect("keeps a record that is still inside its window", () =>
    Effect.gen(function* () {
      const blobs = makeInMemoryBlobStore();
      const now = 1_000_000;
      const store = makePendingApprovalStore(blobs, "u:t:s", () => now);
      yield* store.put(approval({ expiresAt: now + 1 }));

      expect(yield* store.consume("exec_1")).not.toBeNull();
    }),
  );

  // A record we reject is a record nobody should be able to retry against.
  it.effect("drops an expired record rather than leaving it to be retried", () =>
    Effect.gen(function* () {
      const blobs = makeInMemoryBlobStore();
      let now = 1_000_000;
      const store = makePendingApprovalStore(blobs, "u:t:s", () => now);
      yield* store.put(approval({ expiresAt: now + 10 }));

      now += 100;
      expect(yield* store.consume("exec_1")).toBeNull();

      now = 1_000_000;
      expect(yield* store.consume("exec_1")).toBeNull();
    }),
  );

  it.effect("reads an unparseable record as absent", () =>
    Effect.gen(function* () {
      const blobs = makeInMemoryBlobStore();
      yield* blobs.put("u:t:s/@pending-approval", "exec_1", "not json");

      const store = makePendingApprovalStore(blobs, "u:t:s");
      expect(yield* store.consume("exec_1")).toBeNull();
    }),
  );

  it.effect("discard drops a record without returning it", () =>
    Effect.gen(function* () {
      const store = makePendingApprovalStore(makeInMemoryBlobStore(), "u:t:s");
      yield* store.put(approval());

      yield* store.discard("exec_1");
      expect(yield* store.consume("exec_1")).toBeNull();
    }),
  );
});
