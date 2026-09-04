import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeInMemoryBlobStore } from "./blob";
import {
  CompletedExecutionReceipt,
  ExecutionId,
  ExecutionIdempotencyKey,
  RunningResumeReservation,
  makeExecutionReceiptStore,
} from "./execution-receipt";
import { StorageError } from "./fuma-runtime";

const hash = `sha256:${"a".repeat(64)}`;

describe("ExecutionReceiptStore", () => {
  it.effect("atomically reserves a stable owner-scoped execution id", () =>
    Effect.gen(function* () {
      const blobs = makeInMemoryBlobStore();
      const store = makeExecutionReceiptStore(blobs, "u:tenant:subject");
      const idempotencyKey = ExecutionIdempotencyKey.make("request-1");

      const first = yield* store.reserve({
        idempotencyKey,
        requestHash: hash,
        startedAt: 1,
      });
      const replay = yield* store.reserve({
        idempotencyKey,
        requestHash: hash,
        startedAt: 2,
      });

      expect(first.created).toBe(true);
      expect(replay.created).toBe(false);
      expect(replay.execution.executionId).toBe(first.execution.executionId);
      expect(replay.execution.startedAt).toBe(1);
    }),
  );

  it.effect("isolates identical keys by owner partition", () =>
    Effect.gen(function* () {
      const blobs = makeInMemoryBlobStore();
      const first = makeExecutionReceiptStore(blobs, "u:tenant:first");
      const second = makeExecutionReceiptStore(blobs, "u:tenant:second");
      const idempotencyKey = ExecutionIdempotencyKey.make("request-1");
      const reserved = yield* first.reserve({
        idempotencyKey,
        requestHash: hash,
        startedAt: 1,
      });

      expect(yield* second.get(reserved.execution.executionId)).toBeNull();
    }),
  );

  it.effect("admits one resume per pause sequence", () =>
    Effect.gen(function* () {
      const store = makeExecutionReceiptStore(makeInMemoryBlobStore(), "u:t:s");
      const execution = yield* store.reserve({
        idempotencyKey: ExecutionIdempotencyKey.make("execute"),
        requestHash: hash,
        startedAt: 1,
      });
      const resume = RunningResumeReservation.make({
        status: "running",
        executionId: execution.execution.executionId,
        pauseSequence: 0,
        idempotencyKey: ExecutionIdempotencyKey.make("resume"),
        requestHash: hash,
        startedAt: 2,
      });

      expect((yield* store.reserveResume(resume)).created).toBe(true);
      expect((yield* store.reserveResume(resume)).created).toBe(false);
    }),
  );

  it.effect("never overwrites a completed receipt", () =>
    Effect.gen(function* () {
      const store = makeExecutionReceiptStore(makeInMemoryBlobStore(), "u:t:s");
      const reserved = yield* store.reserve({
        idempotencyKey: ExecutionIdempotencyKey.make("immutable"),
        requestHash: hash,
        startedAt: 1,
      });
      const completed = CompletedExecutionReceipt.make({
        ...reserved.execution,
        status: "completed",
        text: "first",
        structured: { value: 1 },
        isError: false,
        resultHash: hash,
        completedAt: 2,
      });
      yield* store.put(completed);
      yield* store.put({ ...completed, text: "second", completedAt: 3 });

      expect(yield* store.get(completed.executionId)).toStrictEqual(completed);
    }),
  );

  it.effect("refuses malformed stored receipts", () =>
    Effect.gen(function* () {
      const blobs = makeInMemoryBlobStore();
      const store = makeExecutionReceiptStore(blobs, "u:t:s");
      const executionId = ExecutionId.make("exec_invalid");
      yield* blobs.put("u:t:s/@execution", executionId, "not json");

      const error = yield* store.get(executionId).pipe(Effect.flip);
      expect(error).toBeInstanceOf(StorageError);
    }),
  );
});
