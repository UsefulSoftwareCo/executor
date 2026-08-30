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
 * Long-poll waiters, keyed by sessionId. Each entry is a wake callback for
 * one held `/api/oauth/await/:sessionId` request. `publishOAuthResult` wakes
 * every waiter for the session; each waker runs `consumeOAuthResult`, so the
 * store's one-shot semantics decide which request receives the result (the
 * rest see null, which clients treat as "still pending").
 */
const waiters = new Map<string, Set<() => void>>();

const removeWaiter = (sessionId: string, wake: () => void): void => {
  const pending = waiters.get(sessionId);
  if (!pending) return;
  pending.delete(wake);
  if (pending.size === 0) waiters.delete(sessionId);
};

const wakeWaiters = (sessionId: string): void => {
  const pending = waiters.get(sessionId);
  if (!pending) return;
  waiters.delete(sessionId);
  for (const wake of pending) wake();
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
  wakeWaiters(sessionId);
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
 */
export const waitForOAuthResult = (
  sessionId: string,
  opts: { readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<AnyResult | null> => {
  const immediate = consumeOAuthResult(sessionId);
  if (immediate !== null) return Promise.resolve(immediate);
  if (opts.timeoutMs <= 0 || opts.signal?.aborted === true) return Promise.resolve(null);

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

    const pending = waiters.get(sessionId) ?? new Set<() => void>();
    pending.add(wake);
    waiters.set(sessionId, pending);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
};

/** Test-only — clears the store and resolves any held waiters as pending. */
export const __resetOAuthResultStoreForTests = (): void => {
  store.clear();
  for (const sessionId of [...waiters.keys()]) wakeWaiters(sessionId);
};

/** Test-only — number of held long-poll waiters for a sessionId. */
export const __oauthAwaitWaiterCountForTests = (sessionId: string): number =>
  waiters.get(sessionId)?.size ?? 0;
