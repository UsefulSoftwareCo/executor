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
    const waits = await Promise.all([
      acquireBuildSlot(),
      acquireBuildSlot(),
      acquireBuildSlot(),
      acquireBuildSlot(),
    ]);
    expect(waits).toEqual([0, 0, 0, 0]);
    expect(currentActiveBuildsForTest()).toBe(4);
    expect(currentQueueLengthForTest()).toBe(0);
  });

  it("queues a build past the cap until a slot is released", async () => {
    await Promise.all([
      acquireBuildSlot(),
      acquireBuildSlot(),
      acquireBuildSlot(),
      acquireBuildSlot(),
    ]);
    expect(currentActiveBuildsForTest()).toBe(4);

    let fifthResolved = false;
    const fifth = acquireBuildSlot().then((waitedMs) => {
      fifthResolved = true;
      return waitedMs;
    });

    expect(currentQueueLengthForTest()).toBe(1);
    // Nothing releases the pending fifth build without an explicit release —
    // it must not resolve on its own.
    await Promise.resolve();
    await Promise.resolve();
    expect(fifthResolved).toBe(false);

    releaseBuildSlot();
    const waitedMs = await fifth;
    expect(fifthResolved).toBe(true);
    expect(waitedMs).toBeGreaterThanOrEqual(0);
    // The freed slot went straight to the waiter — total active stays at cap.
    expect(currentActiveBuildsForTest()).toBe(4);
    expect(currentQueueLengthForTest()).toBe(0);
  });

  it("releases queued waiters in FIFO order", async () => {
    await Promise.all([
      acquireBuildSlot(),
      acquireBuildSlot(),
      acquireBuildSlot(),
      acquireBuildSlot(),
    ]);

    const order: number[] = [];
    const second = acquireBuildSlot().then(() => order.push(2));
    const third = acquireBuildSlot().then(() => order.push(3));
    const fourth = acquireBuildSlot().then(() => order.push(4));
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
      acquireBuildSlot(),
      acquireBuildSlot(),
      acquireBuildSlot(),
      acquireBuildSlot(),
    ]);

    // 6 more builds arrive while all 4 slots are held — all 6 queue.
    const queued = Array.from({ length: 6 }, () => acquireBuildSlot());
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
});
