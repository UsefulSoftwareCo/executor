/**
 * How many MCP session execution runtimes are resident in THIS isolate.
 *
 * A single session Durable Object holds at most one runtime, so a per-instance
 * flag would say nothing useful. The pressure that matters is per-ISOLATE:
 * workerd colocates many Durable Objects onto one isolate with one heap, and a
 * session runtime — the execution engine and its executor closure, the built
 * tool catalog, and a live database handle — is the largest thing any of them
 * holds. Several resident at once is the condition under which the isolate runs
 * out of memory, and the allocation that fails is whichever comes next, which
 * is why the symptom tends to name storage rather than the runtimes that
 * actually consumed the heap.
 *
 * Note this counts SESSION runtimes only. The QuickJS WASM module is preloaded
 * once per isolate and shared by every session on it, so it is deliberately not
 * part of this gauge: disposal cannot release it and counting it would imply
 * otherwise.
 *
 * Module scope is exactly isolate scope on Workers, so this counter measures
 * the thing we want and resets naturally when the isolate is recycled.
 */
let residentRuntimeCount = 0;

/** Peak residency seen in this isolate, so a gauge sampled per request still
 *  reveals a burst that had already receded by the time anything asked. */
let peakResidentRuntimeCount = 0;

export const acquireResidentRuntime = (): number => {
  residentRuntimeCount += 1;
  if (residentRuntimeCount > peakResidentRuntimeCount) {
    peakResidentRuntimeCount = residentRuntimeCount;
  }
  return residentRuntimeCount;
};

export const releaseResidentRuntime = (): number => {
  residentRuntimeCount = Math.max(0, residentRuntimeCount - 1);
  return residentRuntimeCount;
};

export const currentResidentRuntimeCount = (): number => residentRuntimeCount;

export const peakResidentRuntimeCountInIsolate = (): number => peakResidentRuntimeCount;

/** Test-only: isolate-scoped module state outlives a single test case. */
export const resetResidentRuntimeCountForTest = (): void => {
  residentRuntimeCount = 0;
  peakResidentRuntimeCount = 0;
};

type MemoryCapablePerformance = {
  readonly memory?: {
    readonly usedJSHeapSize?: unknown;
    readonly totalJSHeapSize?: unknown;
    readonly jsHeapSizeLimit?: unknown;
  };
};

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Isolate heap usage, when the runtime exposes it.
 *
 * workerd does not currently implement `performance.memory` (nor the async
 * `measureUserAgentSpecificMemory`), so on production Workers this returns an
 * empty object and the attributes are simply absent. It is feature-detected
 * rather than omitted so that the day workerd does expose it, the gauge starts
 * reporting with no further change — and so the local `workerd`/Node harnesses
 * that DO expose a heap size record one today.
 */
export const isolateMemoryAttributes = (): Record<string, number> => {
  const perf = (globalThis as { readonly performance?: MemoryCapablePerformance }).performance;
  const memory = perf?.memory;
  if (!memory) return {};
  const used = finiteNumber(memory.usedJSHeapSize);
  const total = finiteNumber(memory.totalJSHeapSize);
  const limit = finiteNumber(memory.jsHeapSizeLimit);
  return {
    ...(used === undefined ? {} : { "mcp.isolate.heap_used_bytes": used }),
    ...(total === undefined ? {} : { "mcp.isolate.heap_total_bytes": total }),
    ...(limit === undefined ? {} : { "mcp.isolate.heap_limit_bytes": limit }),
  };
};

/**
 * The residency gauge as span attributes. Attached to every runtime build and
 * every idle disposal, so production can confirm the mechanism directly:
 * residency should now fall back toward zero as sessions go idle instead of
 * climbing with the number of connected-but-quiet clients.
 */
export const residencyAttributes = (): Record<string, number> => ({
  "mcp.isolate.resident_runtimes": currentResidentRuntimeCount(),
  "mcp.isolate.peak_resident_runtimes": peakResidentRuntimeCountInIsolate(),
  ...isolateMemoryAttributes(),
});
