/**
 * Process-wide in-memory store of completed OAuth popup results, keyed by
 * sessionId (the `state` parameter from the auth flow).
 *
 * Exists for clients that can't use the in-browser BroadcastChannel /
 * postMessage handoff — specifically the Electron desktop's renderer
 * when the user runs the OAuth flow in their system browser. That
 * external browser has no shared origin with the desktop's renderer, so
 * the renderer instead polls the local server to learn when the flow
 * completed.
 *
 * The store is one-shot: a successful `consumeOAuthResult` removes the
 * entry, so a second poll for the same sessionId returns null. Entries
 * also expire after `RESULT_TTL_MS` to prevent abandoned flows from
 * keeping memory pinned.
 */

import type { OAuthPopupResult } from "@executor-js/sdk";

type AnyResult = OAuthPopupResult<unknown>;

interface StoredResult {
  readonly result: AnyResult;
  readonly expiresAt: number;
}

const RESULT_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough for slow MFA prompts

const store = new Map<string, StoredResult>();

/**
 * Long-poll waiters, keyed by sessionId. Each entry is the wake callback for
 * the single held `/api/oauth/await/:sessionId` request for that session.
 * `publishOAuthResult` wakes the waiter, which runs `consumeOAuthResult` and
 * answers with the result.
 *
 * Held waiters are bounded — each pins a connection, a registry entry, and a
 * deadline timer, and the route only needs a bearer, so unbounded holds are a
 * DoS surface. At most one waiter is held per session (the patched client
 * polls sequentially; an unpatched client polling every second would
 * otherwise stack ~25 holds per flow against a 25s deadline), and at most
 * `MAX_HELD_WAITERS_TOTAL` across all sessions. Over either bound,
 * `waitForOAuthResult` degrades to the pre-long-poll behavior: it answers the
 * current store value immediately (null = still pending) instead of holding,
 * so over-cap callers see exactly what an old server would have sent.
 */
const MAX_HELD_WAITERS_TOTAL = 64;

const waiters = new Map<string, () => void>();

const removeWaiter = (sessionId: string, wake: () => void): void => {
  if (waiters.get(sessionId) === wake) waiters.delete(sessionId);
};

const wakeWaiter = (sessionId: string): void => {
  const wake = waiters.get(sessionId);
  if (!wake) return;
  waiters.delete(sessionId);
  wake();
};

const cleanupExpired = (now: number) => {
  for (const [sessionId, entry] of store) {
    if (entry.expiresAt < now) store.delete(sessionId);
  }
};

/**
 * Publish a completed OAuth result. Called from `runOAuthCallback` after
 * the per-plugin `complete` Effect resolves (success or failure).
 */
export const publishOAuthResult = (result: AnyResult): void => {
  const sessionId = result.sessionId;
  if (!sessionId) return;
  const now = Date.now();
  cleanupExpired(now);
  store.set(sessionId, { result, expiresAt: now + RESULT_TTL_MS });
  wakeWaiter(sessionId);
};

/**
 * Read and remove a result. Returns null if the sessionId has no entry
 * (the OAuth flow is still in progress, or the user abandoned it).
 */
export const consumeOAuthResult = (sessionId: string): AnyResult | null => {
  const now = Date.now();
  cleanupExpired(now);
  const entry = store.get(sessionId);
  if (!entry) return null;
  store.delete(sessionId);
  return entry.result;
};

/**
 * Long-poll for a result. Consumes and resolves immediately when a result
 * is already stored; otherwise holds until `publishOAuthResult` fires for
 * the sessionId, the deadline elapses, or `signal` aborts (client gone).
 * The latter two resolve `null` — the same "still pending" answer an
 * immediate poll gives — so the caller's retry loop keeps working. A
 * waiter that times out or aborts is always removed from the registry.
 *
 * Holding is bounded (see the waiter registry above): when the session
 * already has a held waiter, or the global held-waiter ceiling is reached,
 * this answers `null` immediately instead of holding.
 */
export const waitForOAuthResult = (
  sessionId: string,
  opts: { readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<AnyResult | null> => {
  const immediate = consumeOAuthResult(sessionId);
  if (immediate !== null) return Promise.resolve(immediate);
  if (opts.timeoutMs <= 0 || opts.signal?.aborted === true) return Promise.resolve(null);
  if (waiters.has(sessionId) || waiters.size >= MAX_HELD_WAITERS_TOTAL) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = (result: AnyResult | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      removeWaiter(sessionId, wake);
      resolve(result);
    };
    const wake = () => finish(consumeOAuthResult(sessionId));
    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(null), opts.timeoutMs);

    waiters.set(sessionId, wake);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
};

/** Test-only — clears the store and resolves any held waiters as pending. */
export const __resetOAuthResultStoreForTests = (): void => {
  store.clear();
  for (const sessionId of [...waiters.keys()]) wakeWaiter(sessionId);
};

/** Test-only — number of held long-poll waiters for a sessionId (0 or 1). */
export const __oauthAwaitWaiterCountForTests = (sessionId: string): number =>
  waiters.has(sessionId) ? 1 : 0;

/** Test-only — total held long-poll waiters across all sessions. */
export const __oauthAwaitHeldWaiterTotalForTests = (): number => waiters.size;
