import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeInMemoryBlobStore } from "./blob";
import { makeExecutionRecordStore, type ExecutionRecord } from "./execution-records";

const record = (overrides?: Partial<ExecutionRecord>): ExecutionRecord => ({
  executionId: "exec_1",
  status: "paused",
  updatedAt: 1_000,
  ...overrides,
});

const partition = "u:t:s";

describe("makeExecutionRecordStore", () => {
  it.effect(
    "round-trips a record and reads it through a second store over the same partition",
    () =>
      Effect.gen(function* () {
        // The whole point of the tombstone: the engine that paused is gone, so
        // the record has to be readable by a caller that never saw the pause.
        const blobs = makeInMemoryBlobStore();
        yield* makeExecutionRecordStore(blobs, partition).put(record());

        const restarted = makeExecutionRecordStore(blobs, partition);
        expect(yield* restarted.get("exec_1")).toStrictEqual(record());
      }),
  );

  it.effect("reads absent for an unknown execution id", () =>
    Effect.gen(function* () {
      const store = makeExecutionRecordStore(makeInMemoryBlobStore(), partition);
      expect(yield* store.get("never_existed")).toBeNull();
    }),
  );

  it.effect("is owner-scoped: a different partition does not see the record", () =>
    Effect.gen(function* () {
      const blobs = makeInMemoryBlobStore();
      yield* makeExecutionRecordStore(blobs, "u:t:other-subject").put(record());

      // The namespace includes the partition — this caller's store reads a
      // different namespace and simply does not see the record.
      const otherStore = makeExecutionRecordStore(blobs, "u:t:s");
      expect(yield* otherStore.get("exec_1")).toBeNull();
    }),
  );

  it.effect("treats a corrupt record as absent (never surfaces garbage)", () =>
    Effect.gen(function* () {
      const blobs = makeInMemoryBlobStore();
      yield* blobs.put("u:t:s/@execution-records", "exec_1", "not-json{{");

      const store = makeExecutionRecordStore(blobs, partition);
      expect(yield* store.get("exec_1")).toBeNull();
    }),
  );

  it.effect("sweep marks running|paused records interrupted and clears the live index", () =>
    Effect.gen(function* () {
      const blobs = makeInMemoryBlobStore();
      const store = makeExecutionRecordStore(blobs, partition);
      yield* store.put(record({ executionId: "exec_running", status: "running", updatedAt: 1 }));
      yield* store.put(record({ executionId: "exec_paused", status: "paused", updatedAt: 2 }));
      yield* store.put(record({ executionId: "exec_done", status: "completed", updatedAt: 3 }));

      const swept = yield* store.sweepInterrupted();
      expect(swept.interrupted).toBe(2);

      expect((yield* store.get("exec_running"))?.status).toBe("interrupted");
      expect((yield* store.get("exec_paused"))?.status).toBe("interrupted");
      // completed is immutable
      expect((yield* store.get("exec_done"))?.status).toBe("completed");

      // A second sweep finds nothing live to mark.
      expect((yield* store.sweepInterrupted()).interrupted).toBe(0);
    }),
  );

  it.effect("re-putting a terminal record removes it from the live index (no re-sweep)", () =>
    Effect.gen(function* () {
      const blobs = makeInMemoryBlobStore();
      const store = makeExecutionRecordStore(blobs, partition);
      yield* store.put(record({ executionId: "exec_1", status: "running" }));
      // Execution completes before any restart.
      yield* store.put(record({ executionId: "exec_1", status: "completed", updatedAt: 2 }));

      expect((yield* store.sweepInterrupted()).interrupted).toBe(0);
      expect((yield* store.get("exec_1"))?.status).toBe("completed");
    }),
  );
});
