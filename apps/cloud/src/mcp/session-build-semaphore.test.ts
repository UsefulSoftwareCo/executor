import { describe, expect, it, beforeEach } from "@effect/vitest";

import {
  acquireBuildSlot,
  releaseBuildSlot,
  resetBuildSlotsForTest,
  currentActiveBuildsForTest,
  currentQueueLengthForTest,
} from "./session-build-semaphore";

describe("session-build-semaphore", () => {
  beforeEach(() => {
    resetBuildSlotsForTest();
  });

  it("grants up to the cap immediately, with no wait", async () => {
    const results = await Promise.all([
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
    ]);
    expect(results).toEqual([
      { acquired: true, waitMs: 0, timedOut: false },
      { acquired: true, waitMs: 0, timedOut: false },
      { acquired: true, waitMs: 0, timedOut: false },
      { acquired: true, waitMs: 0, timedOut: false },
    ]);
    expect(currentActiveBuildsForTest()).toBe(4);
    expect(currentQueueLengthForTest()).toBe(0);
  });

  it("queues a build past the cap until a slot is released", async () => {
    await Promise.all([
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
    ]);
    expect(currentActiveBuildsForTest()).toBe(4);

    let fifthResolved = false;
    const fifth = acquireBuildSlot().promise.then((result) => {
      fifthResolved = true;
      return result;
    });

    expect(currentQueueLengthForTest()).toBe(1);
    // Nothing releases the pending fifth build without an explicit release —
    // it must not resolve on its own.
    await Promise.resolve();
    await Promise.resolve();
    expect(fifthResolved).toBe(false);

    releaseBuildSlot();
    const result = await fifth;
    expect(fifthResolved).toBe(true);
    expect(result.acquired).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.waitMs).toBeGreaterThanOrEqual(0);
    // The freed slot went straight to the waiter — total active stays at cap.
    expect(currentActiveBuildsForTest()).toBe(4);
    expect(currentQueueLengthForTest()).toBe(0);
  });

  it("releases queued waiters in FIFO order", async () => {
    await Promise.all([
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
    ]);

    const order: number[] = [];
    const second = acquireBuildSlot().promise.then(() => order.push(2));
    const third = acquireBuildSlot().promise.then(() => order.push(3));
    const fourth = acquireBuildSlot().promise.then(() => order.push(4));
    expect(currentQueueLengthForTest()).toBe(3);

    releaseBuildSlot();
    await second;
    releaseBuildSlot();
    await third;
    releaseBuildSlot();
    await fourth;

    expect(order).toEqual([2, 3, 4]);
  });

  it("never deadlocks: releasing a slot always makes forward progress for the next waiter", async () => {
    await Promise.all([
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
    ]);

    // 6 more builds arrive while all 4 slots are held — all 6 queue.
    const queued = Array.from({ length: 6 }, () => acquireBuildSlot().promise);
    expect(currentQueueLengthForTest()).toBe(6);

    // The 4 in-flight builds finish one at a time; each release must hand its
    // slot straight to the next queued waiter rather than sitting idle.
    for (let i = 0; i < 4; i++) releaseBuildSlot();
    await Promise.all(queued.slice(0, 4));
    expect(currentActiveBuildsForTest()).toBe(4);
    expect(currentQueueLengthForTest()).toBe(2);

    // Those 4 finish too, freeing the last 2 queued waiters.
    for (let i = 0; i < 4; i++) releaseBuildSlot();
    await Promise.all(queued.slice(4));
    expect(currentActiveBuildsForTest()).toBe(2);
    expect(currentQueueLengthForTest()).toBe(0);

    // And the last 2 finish, draining the semaphore completely.
    releaseBuildSlot();
    releaseBuildSlot();
    expect(currentActiveBuildsForTest()).toBe(0);
    expect(currentQueueLengthForTest()).toBe(0);
  });

  it("does not go negative when released more times than acquired", () => {
    releaseBuildSlot();
    releaseBuildSlot();
    expect(currentActiveBuildsForTest()).toBe(0);
  });

  it("cancelling a queued waiter dequeues it, and a subsequent release goes to the next waiter", async () => {
    await Promise.all([
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
    ]);
    expect(currentActiveBuildsForTest()).toBe(4);

    const cancelled = acquireBuildSlot();
    let cancelledSettled = false;
    void cancelled.promise.then(() => {
      cancelledSettled = true;
    });

    const next = acquireBuildSlot();
    let nextResult: Awaited<typeof next.promise> | undefined;
    void next.promise.then((r) => {
      nextResult = r;
    });

    expect(currentQueueLengthForTest()).toBe(2);

    // Interrupted before it was ever granted a slot (e.g. client disconnect
    // while queued) — this must not hand it a slot later, and must not block
    // the waiter behind it.
    cancelled.cancel();
    expect(currentQueueLengthForTest()).toBe(1);

    releaseBuildSlot();
    await next.promise;

    // The cancelled waiter's promise never resolves and never gets a slot;
    // the freed slot went straight to the next waiter instead.
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelledSettled).toBe(false);
    expect(nextResult).toEqual({ acquired: true, waitMs: expect.any(Number), timedOut: false });
    expect(currentActiveBuildsForTest()).toBe(4);
    expect(currentQueueLengthForTest()).toBe(0);
  });

  it("cancel-after-grant releases the slot instead of leaking it", async () => {
    await Promise.all([
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
    ]);
    expect(currentActiveBuildsForTest()).toBe(4);

    // Queues, then gets granted a slot by the release below.
    const grantedThenAbandoned = acquireBuildSlot();
    releaseBuildSlot();
    const result = await grantedThenAbandoned.promise;
    expect(result.acquired).toBe(true);
    // Still at the cap: the freed slot was handed straight to this waiter.
    expect(currentActiveBuildsForTest()).toBe(4);

    // The caller never gets to consume the grant (e.g. its fiber was
    // interrupted in the same tick the grant happened) and cancels instead —
    // this must give the slot back rather than leaking it forever.
    grantedThenAbandoned.cancel();
    expect(currentActiveBuildsForTest()).toBe(3);

    // Idempotent: a second cancel must not release it again.
    grantedThenAbandoned.cancel();
    expect(currentActiveBuildsForTest()).toBe(3);

    // And the freed slot is usable by a fresh acquire.
    const fresh = await acquireBuildSlot().promise;
    expect(fresh).toEqual({ acquired: true, waitMs: 0, timedOut: false });
    expect(currentActiveBuildsForTest()).toBe(4);
  });

  it("cancelling an immediately-granted (never-queued) slot releases it exactly once", async () => {
    const handle = acquireBuildSlot();
    await handle.promise;
    expect(currentActiveBuildsForTest()).toBe(1);

    handle.cancel();
    expect(currentActiveBuildsForTest()).toBe(0);

    // Idempotent.
    handle.cancel();
    expect(currentActiveBuildsForTest()).toBe(0);
  });

  it("proceeds without a slot when the queue wait exceeds the timeout, and does not count it as active", async () => {
    await Promise.all([
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
    ]);
    expect(currentActiveBuildsForTest()).toBe(4);

    const timedOutHandle = acquireBuildSlot(10);
    const result = await timedOutHandle.promise;

    expect(result).toEqual({ acquired: false, waitMs: expect.any(Number), timedOut: true });
    expect(result.waitMs).toBeGreaterThanOrEqual(10);
    // A timed-out waiter never counted against the cap.
    expect(currentActiveBuildsForTest()).toBe(4);
    expect(currentQueueLengthForTest()).toBe(0);

    // A timed-out waiter never held a slot, so cancelling it must not
    // release one that was never granted.
    timedOutHandle.cancel();
    expect(currentActiveBuildsForTest()).toBe(4);

    // The 4 originally-held slots are still releasable normally.
    releaseBuildSlot();
    releaseBuildSlot();
    releaseBuildSlot();
    releaseBuildSlot();
    expect(currentActiveBuildsForTest()).toBe(0);
  });

  it("a waiter that times out is removed from the queue and does not block waiters behind it", async () => {
    await Promise.all([
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
      acquireBuildSlot().promise,
    ]);

    const timesOut = acquireBuildSlot(10);
    const staysQueued = acquireBuildSlot();
    expect(currentQueueLengthForTest()).toBe(2);

    const timedOutResult = await timesOut.promise;
    expect(timedOutResult.timedOut).toBe(true);
    // Only the timed-out waiter left the queue; the other is still waiting.
    expect(currentQueueLengthForTest()).toBe(1);

    releaseBuildSlot();
    const staysQueuedResult = await staysQueued.promise;
    expect(staysQueuedResult).toEqual({
      acquired: true,
      waitMs: expect.any(Number),
      timedOut: false,
    });
    expect(currentQueueLengthForTest()).toBe(0);
  });
});
