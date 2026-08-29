/**
 * Module-scope (== per-isolate, same reasoning as
 * `packages/hosts/cloudflare/src/mcp/session-runtime-residency.ts`) semaphore
 * bounding concurrent COLD `buildMcpServer` builds.
 *
 * A burst of new sessions can land on one isolate at once. Each cold build
 * runs execution-stack setup and MCP server construction, which is real CPU
 * — concentrating several of those builds at the same instant is what drags
 * the isolate's request p95 during a wave. Capping how many builds run at
 * once smooths that burst into a short FIFO queue instead of letting every
 * arrival pay full concurrent cost.
 *
 * Deliberately dependency-free: a tiny promise-chain queue, not a library.
 */

const MAX_CONCURRENT_BUILDS = 4;

/**
 * Max time a build waits in the FIFO queue for a slot before proceeding
 * without one. Admission control exists only to smooth bursts into a short
 * queue — it must never turn a *slow* build into a *stuck* one. If the
 * isolate is wedged behind a hung dependency (e.g. a stalled DB during an
 * incident) and a slot never frees up, every waiter behind it would otherwise
 * block forever. Past this timeout a waiter gives up on the queue and builds
 * uncapped instead, same as if the semaphore did not exist, and reports
 * `timedOut: true` so it is visible in telemetry rather than silently
 * degrading.
 */
export const MAX_QUEUE_WAIT_MS = 10_000;

let activeBuilds = 0;

/** Lifecycle of one queued waiter. See `acquireBuildSlot` for the full state machine. */
type WaiterState = "queued" | "granted" | "timed-out" | "cancelled";

interface Waiter {
  state: WaiterState;
  readonly grant: () => void;
}

const waitQueue: Waiter[] = [];

export interface BuildSlotResult {
  /** False only when the wait timed out; the caller must NOT call `releaseBuildSlot` for it. */
  readonly acquired: boolean;
  /** Milliseconds spent waiting for a slot (0 when one was immediately free). */
  readonly waitMs: number;
  /** True when the wait hit `MAX_QUEUE_WAIT_MS` and proceeded without a slot. */
  readonly timedOut: boolean;
}

export interface BuildSlotHandle {
  /** Resolves exactly once, with the outcome of this acquisition. Never rejects. */
  readonly promise: Promise<BuildSlotResult>;
  /**
   * Cancel this acquisition. Safe to call at any point in its lifecycle,
   * including redundantly or after `promise` has already settled — it is
   * idempotent and only ever frees a slot once:
   *  - Still queued: dequeues the waiter. Nothing was ever granted, so there
   *    is nothing to release.
   *  - Already granted a slot — this races `releaseBuildSlot` handing the
   *    slot to this waiter (that happens synchronously inside
   *    `releaseBuildSlot`) against this `cancel` — releases that slot
   *    immediately so it is not held with no owner, and wakes the next FIFO
   *    waiter.
   *  - Already timed out or already cancelled: no-op.
   *
   * Callers should call this from a `finally`/`ensuring` unconditionally
   * (success, failure, or interruption alike) rather than trying to track
   * separately whether a slot was actually granted — idempotency here makes
   * that bookkeeping unnecessary and closes the acquire/release race that
   * bookkeeping was prone to.
   */
  readonly cancel: () => void;
}

/**
 * Reserve a build slot, queueing FIFO when the cap is already held, up to
 * `maxQueueWaitMs` (defaults to `MAX_QUEUE_WAIT_MS`; overridable for tests).
 *
 * Returns a handle rather than a bare promise so a caller that stops waiting
 * — most notably an `Effect` fiber interrupted mid-queue on a client
 * disconnect — can cancel cleanly instead of leaking the slot a later
 * `releaseBuildSlot` would otherwise hand to a waiter nobody is listening to
 * anymore.
 */
export const acquireBuildSlot = (maxQueueWaitMs: number = MAX_QUEUE_WAIT_MS): BuildSlotHandle => {
  const requestedAt = Date.now();

  if (activeBuilds < MAX_CONCURRENT_BUILDS) {
    activeBuilds += 1;
    let released = false;
    return {
      promise: Promise.resolve({ acquired: true, waitMs: 0, timedOut: false }),
      cancel: () => {
        if (released) return;
        released = true;
        releaseBuildSlot();
      },
    };
  }

  let resolvePromise!: (value: BuildSlotResult) => void;
  const promise = new Promise<BuildSlotResult>((resolve) => {
    resolvePromise = resolve;
  });

  const waiter: Waiter = {
    state: "queued",
    grant: () => {
      // Guaranteed "queued" here: `releaseBuildSlot` only reaches a waiter by
      // shifting it out of `waitQueue`, and both other transitions
      // (timeout, cancel) remove the waiter from the queue in the same tick
      // they change its state, so a granted waiter can't have been anything
      // else.
      waiter.state = "granted";
      activeBuilds += 1;
      resolvePromise({ acquired: true, waitMs: Date.now() - requestedAt, timedOut: false });
    },
  };
  waitQueue.push(waiter);

  const timer = setTimeout(() => {
    if (waiter.state !== "queued") return;
    waiter.state = "timed-out";
    const idx = waitQueue.indexOf(waiter);
    if (idx !== -1) waitQueue.splice(idx, 1);
    resolvePromise({ acquired: false, waitMs: Date.now() - requestedAt, timedOut: true });
  }, maxQueueWaitMs);

  return {
    promise,
    cancel: () => {
      clearTimeout(timer);
      if (waiter.state === "queued") {
        waiter.state = "cancelled";
        const idx = waitQueue.indexOf(waiter);
        if (idx !== -1) waitQueue.splice(idx, 1);
        return;
      }
      if (waiter.state === "granted") {
        // Grant already happened (raced with a concurrent `releaseBuildSlot`
        // shifting this waiter off the queue) before this cancel ran, and
        // the caller never got to consume the slot — hand it back now
        // instead of leaking it.
        waiter.state = "cancelled";
        releaseBuildSlot();
        return;
      }
      // "timed-out": never held a slot. "cancelled": a prior call already
      // handled this. Either way, nothing to do — idempotent no-op.
    },
  };
};

/**
 * Release a build slot. Must be called exactly once per slot a caller
 * actually acquired (i.e. `acquireBuildSlot`'s `promise` resolved with
 * `acquired: true`) — callers release from a `finally`/`ensuring` (typically
 * via the returned handle's `cancel`, which is idempotent) so a build that
 * throws, or is interrupted, still frees its slot and never deadlocks the
 * queue behind it.
 *
 * Wakes the next FIFO waiter, if any, handing it the freed slot directly
 * rather than making it race a fresh `acquireBuildSlot` caller.
 */
export const releaseBuildSlot = (): void => {
  activeBuilds = Math.max(0, activeBuilds - 1);
  const next = waitQueue.shift();
  if (next) next.grant();
};

/** Test-only: isolate-scoped module state outlives a single test case. */
export const resetBuildSlotsForTest = (): void => {
  activeBuilds = 0;
  waitQueue.length = 0;
};

export const currentActiveBuildsForTest = (): number => activeBuilds;

export const currentQueueLengthForTest = (): number => waitQueue.length;
