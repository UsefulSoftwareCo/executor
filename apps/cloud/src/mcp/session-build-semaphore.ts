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

let activeBuilds = 0;
const waitQueue: Array<() => void> = [];

/**
 * Reserve a build slot, queueing FIFO when the cap is already held. Resolves
 * with the number of milliseconds spent waiting for a slot — 0 when one was
 * immediately free, which is the common case outside a burst.
 *
 * Always resolves, never rejects: there is nothing to fail here, only to
 * wait for.
 */
export const acquireBuildSlot = (): Promise<number> => {
  const requestedAt = Date.now();
  if (activeBuilds < MAX_CONCURRENT_BUILDS) {
    activeBuilds += 1;
    return Promise.resolve(0);
  }
  return new Promise<number>((resolve) => {
    waitQueue.push(() => {
      activeBuilds += 1;
      resolve(Date.now() - requestedAt);
    });
  });
};

/**
 * Release a build slot. Must be called exactly once per slot a caller
 * actually acquired (i.e. `acquireBuildSlot` resolved) — callers release from
 * a `finally`/`ensuring` so a build that throws still frees its slot and
 * never deadlocks the queue behind it.
 *
 * Wakes the next FIFO waiter, if any, handing it the freed slot directly
 * rather than making it race a fresh `acquireBuildSlot` caller.
 */
export const releaseBuildSlot = (): void => {
  activeBuilds = Math.max(0, activeBuilds - 1);
  const next = waitQueue.shift();
  if (next) next();
};

/** Test-only: isolate-scoped module state outlives a single test case. */
export const resetBuildSlotsForTest = (): void => {
  activeBuilds = 0;
  waitQueue.length = 0;
};

export const currentActiveBuildsForTest = (): number => activeBuilds;

export const currentQueueLengthForTest = (): number => waitQueue.length;
