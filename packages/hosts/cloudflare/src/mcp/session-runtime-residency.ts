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

/**
 * How many cold builds are currently in flight in this isolate — reserved at
 * admission, the same moment `evictForCapIfNeeded` runs, and released exactly
 * once the reserving session either becomes counted-as-resident
 * (`acquireResidentRuntime`) or its build fails or is interrupted.
 *
 * `residentRuntimeCount` only moves once a build actually finishes, so N
 * overlapping cold inits at the cap each read it, see themselves still under
 * the cap, and none of them evicts anything — residency then blows past the
 * cap by N once every build lands. This counter closes that gap: the cap
 * check becomes `currentResidentRuntimeCount() + currentInFlightColdBuildCount()`,
 * so a second (or third, ...) concurrent admission sees the first's
 * reservation and triggers eviction instead of also passing the check for
 * free.
 */
let inFlightColdBuildCount = 0;

/** Reserve a cold-build slot at admission. Paired with exactly one of
 *  {@link releaseColdBuildSlot} per reservation — see the doc comment above. */
export const reserveColdBuildSlot = (): number => {
  inFlightColdBuildCount += 1;
  return inFlightColdBuildCount;
};

/** Release a previously-reserved cold-build slot. Floors at zero so a stray
 *  extra release (there should never be one; callers gate this on their own
 *  per-init flag) cannot drive the counter negative. */
export const releaseColdBuildSlot = (): number => {
  inFlightColdBuildCount = Math.max(0, inFlightColdBuildCount - 1);
  return inFlightColdBuildCount;
};

export const currentInFlightColdBuildCount = (): number => inFlightColdBuildCount;

/** Test-only: isolate-scoped module state outlives a single test case. */
export const resetInFlightColdBuildCountForTest = (): void => {
  inFlightColdBuildCount = 0;
};

/**
 * The isolate-wide ceiling on resident session runtimes, past which `init`
 * evicts the least-recently-active evictable session to make room instead of
 * letting residency climb unbounded.
 *
 * Production isolates have been observed OOM-killing every co-resident
 * session somewhere between roughly 10 and 64 residents, and isolate memory
 * is already sitting at the platform's 128MB limit at the fleet-wide median
 * before this mechanism runs at all — there is no headroom left to discover
 * the ceiling empirically per-isolate. 32 sits inside that failure band, so it
 * bounds the COUNT-driven failure mode (an isolate cannot pile up unbounded
 * residents no matter how many quiet-but-connected sessions land on it) while
 * per-session footprint reduction, a separate effort, addresses the rest.
 * It is a soft cap: an isolate that cannot find anything evictable is still
 * allowed past it (see `pickEvictionCandidate`) rather than failing an init.
 */
export const RESIDENT_RUNTIME_SOFT_CAP = 32;

/**
 * One resident session runtime, as far as the isolate-wide eviction registry
 * needs to know about it: when it was last active, whether it is safe to tear
 * down right now, and how to ask it to tear itself down.
 *
 * `canEvict` is consulted by `pickEvictionCandidate` to choose AMONG entries
 * and is expected to be cheap and synchronous — it does not have to be the
 * final word. `dispose` sends this session an eviction REQUEST — it does not
 * run this session's own teardown itself. The owning Durable Object instance
 * is the only thing allowed to tear down its own runtime (see
 * `requestSelfEviction` on the base class for why: teardown does I/O bound to
 * this session's own request context, and a caller running it directly would
 * be running that I/O under ITS OWN context instead). `dispose` is expected to
 * re-check liveness itself before actually releasing anything, using whatever
 * signals it has (including ones `canEvict` could not afford to read), so a
 * candidate that became active between the pick and the dispose call is left
 * alone rather than torn down. It resolving does not guarantee the candidate
 * was actually torn down — only that the request was sent — so callers that
 * fire it in the background (see `evictForCapIfNeeded`) call
 * `markEvictionRequested` rather than assuming success.
 */
export type ResidentSessionEntry = {
  readonly sessionId: string;
  lastActivityMs: number;
  evictionRequestedAt?: number;
  readonly canEvict: () => boolean;
  readonly dispose: (reason: "cap") => Promise<void>;
  /**
   * Cheap, synchronous "does this session currently have an active stream"
   * check, so the registry can explain WHY residency will not budge — a
   * cap-overflow isolate full of streaming sessions looks identical to one
   * full of paused-but-not-evictable sessions unless this is broken out
   * separately. Optional because not every registrant can answer it for
   * free; when absent, `residencyCounts` simply omits the streaming count
   * rather than reporting a misleading zero.
   */
  readonly isStreaming?: () => boolean;
};

/**
 * Every session runtime currently resident in THIS isolate, keyed by session
 * id. Dependency-free by design: this module is a leaf that both the session
 * Durable Object and its tests import directly, and it must never need to
 * know what an Effect, a Durable Object, or a storage API is.
 *
 * An entry lives here for exactly as long as its runtime is resident. It is
 * added once, at the same moment `acquireResidentRuntime` counts it, and
 * removed once, at the same moment `releaseResidentRuntime` releases it — the
 * two are meant to move together, though this module does not enforce that;
 * see `closeRuntime` on the Durable Object for where they are actually paired.
 */
const residentSessions = new Map<string, ResidentSessionEntry>();

/** Start tracking a newly-resident session runtime for isolate-wide eviction. */
export const registerResidentSession = (entry: ResidentSessionEntry): void => {
  residentSessions.set(entry.sessionId, entry);
};

/** Record that a resident session just did something, so it sorts last for eviction. */
export const touchResidentSession = (sessionId: string, lastActivityMs = Date.now()): void => {
  const entry = residentSessions.get(sessionId);
  if (entry) entry.lastActivityMs = lastActivityMs;
};

/**
 * Stop tracking a session's runtime because it is no longer resident.
 *
 * Idempotent on purpose: `Map.delete` on an absent key is already a no-op, so
 * this can be called from every path that might end a session's residency —
 * a clean disposal, a failed one, a repeat call — without any caller having to
 * first ask whether the entry is still there.
 */
export const releaseResidentSession = (sessionId: string): void => {
  residentSessions.delete(sessionId);
};

/**
 * How long a resident session stays skipped by `pickEvictionCandidate` after
 * an eviction request was sent to it. The request is fire-and-forget (see
 * `evictForCapIfNeeded` on the base class) — the sender never learns whether
 * it succeeded, failed, or is still in flight — so this grace window is the
 * only thing standing between one stuck or repeatedly-failing candidate and
 * it squatting the LRU pick forever, re-requested by every subsequent init.
 * Long enough that a healthy eviction (self-request, own teardown, registry
 * removal) always finishes well inside it; short enough that a genuinely
 * stuck candidate stops blocking the LRU pick soon after.
 */
export const EVICTION_REQUEST_GRACE_MS = 15_000;

/**
 * Record that an eviction request was just sent to this entry, so
 * `pickEvictionCandidate` skips it until the grace period elapses. A no-op
 * when the entry is already gone (it was evicted, or removed some other way)
 * — nothing left to mark, and nothing wrong with that.
 */
export const markEvictionRequested = (sessionId: string, requestedAtMs = Date.now()): void => {
  const entry = residentSessions.get(sessionId);
  if (entry) entry.evictionRequestedAt = requestedAtMs;
};

/**
 * The least-recently-active resident session that is currently safe to evict,
 * or `undefined` when every resident is streaming, paused, recently asked to
 * evict itself already, or otherwise ineligible right now.
 *
 * `undefined` is a legitimate, expected answer — it means the isolate is over
 * its soft cap but everything resident is doing real work (or already has an
 * eviction request outstanding), and the caller must let the new session
 * build anyway rather than block or fail on it.
 */
export const pickEvictionCandidate = (nowMs = Date.now()): ResidentSessionEntry | undefined => {
  let candidate: ResidentSessionEntry | undefined;
  for (const entry of residentSessions.values()) {
    if (!entry.canEvict()) continue;
    if (
      entry.evictionRequestedAt !== undefined &&
      nowMs - entry.evictionRequestedAt < EVICTION_REQUEST_GRACE_MS
    ) {
      continue;
    }
    if (!candidate || entry.lastActivityMs < candidate.lastActivityMs) {
      candidate = entry;
    }
  }
  return candidate;
};

/** Test-only: isolate-scoped module state outlives a single test case. */
export const resetResidentSessionRegistryForTest = (): void => {
  residentSessions.clear();
};

/** Test-only: read without mutating, to assert on registry membership directly. */
export const residentSessionIdsForTest = (): ReadonlyArray<string> =>
  Array.from(residentSessions.keys());

/**
 * Breaks the registry down by WHY a resident session is or is not eligible
 * for eviction right now, computed in one synchronous pass over the same
 * entries `pickEvictionCandidate` walks. This exists because "nothing was
 * evictable" (`mcp.isolate.cap_overflow`) is not, on its own, actionable: an
 * isolate full of legitimately-streaming sessions and one full of sessions
 * that are merely mid-request look identical from the outside without this
 * breakdown.
 *
 * `evictable` and `pinned` are computed from `canEvict()` alone and always
 * sum to the registry's size. `evictionPending` is a separate, possibly
 * overlapping count — an entry can report `canEvict() === true` and still be
 * sitting out the post-request grace window that `pickEvictionCandidate`
 * also honors, which is exactly the case that makes a healthy-looking
 * registry still fail to yield a candidate. `streaming` is omitted entirely
 * (rather than reported as zero) unless at least one registered entry
 * supplies {@link ResidentSessionEntry.isStreaming}, since a registrant that
 * cannot answer it cheaply should not be silently counted as non-streaming.
 */
export const residencyCounts = (
  nowMs = Date.now(),
): {
  readonly evictable: number;
  readonly pinned: number;
  readonly evictionPending: number;
  readonly streaming?: number;
} => {
  let evictable = 0;
  let pinned = 0;
  let evictionPending = 0;
  let streaming = 0;
  let sawStreamingSignal = false;
  for (const entry of residentSessions.values()) {
    if (entry.canEvict()) {
      evictable += 1;
    } else {
      pinned += 1;
    }
    if (
      entry.evictionRequestedAt !== undefined &&
      nowMs - entry.evictionRequestedAt < EVICTION_REQUEST_GRACE_MS
    ) {
      evictionPending += 1;
    }
    if (entry.isStreaming) {
      sawStreamingSignal = true;
      if (entry.isStreaming()) streaming += 1;
    }
  }
  return { evictable, pinned, evictionPending, ...(sawStreamingSignal ? { streaming } : {}) };
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
 *
 * The `resident_evictable`/`resident_pinned`/`resident_eviction_pending`
 * (and, when available, `resident_streaming`) attributes exist so a sampled
 * span can answer WHY residency is or is not shrinking, without needing a
 * heap snapshot Workers cannot provide: a cap-overflow isolate full of
 * `resident_pinned` looks nothing like one full of `resident_streaming`, and
 * only one of those is the eviction policy's own doing.
 */
export const residencyAttributes = (): Record<string, number> => {
  const counts = residencyCounts();
  return {
    "mcp.isolate.resident_runtimes": currentResidentRuntimeCount(),
    "mcp.isolate.peak_resident_runtimes": peakResidentRuntimeCountInIsolate(),
    "mcp.isolate.resident_evictable": counts.evictable,
    "mcp.isolate.resident_pinned": counts.pinned,
    ...(counts.streaming === undefined
      ? {}
      : { "mcp.isolate.resident_streaming": counts.streaming }),
    "mcp.isolate.resident_eviction_pending": counts.evictionPending,
    "mcp.isolate.in_flight_cold_builds": currentInFlightColdBuildCount(),
    ...isolateMemoryAttributes(),
  };
};
