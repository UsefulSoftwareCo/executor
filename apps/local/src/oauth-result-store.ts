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

/** Test-only — clears the entire store between tests. */
export const __resetOAuthResultStoreForTests = (): void => {
  store.clear();
};
