// ---------------------------------------------------------------------------
// OtcStore — one-time codes for the web bootstrap exchange.
//
// The local daemon's bearer token is the single credential gating every
// surface. The web bootstrap previously shipped it in the URL (`?_token=`)
// and persisted it to localStorage — both are XSS/leak-adjacent surfaces
// (browser history, logs, screen recordings, localStorage read by any script
// on the origin). The OTC flow replaces the URL-token with a one-time code:
//
//   1. `executor web` / `executor open` mints a code from the running daemon
//      (bearer-gated endpoint; the CLI already holds the bearer).
//   2. The browser loads `/?_otc=<code>`, POSTs it to the unauthenticated
//      `/api/auth/exchange` endpoint, and receives the bearer in the response
//      body PLUS an HttpOnly SameSite=strict cookie (transport hardening —
//      the cookie is not the request gate, the bearer is; see serve-shared
//      makeIsAuthorized).
//   3. The client applies the bearer to the in-memory connection and strips
//      the query. Nothing is written to localStorage.
//
// Codes are single-use, TTL-bounded (≤60s), high-entropy (≥128 bits), bound
// to the daemon instance (the in-memory map dies with the process, so a code
// can never be replayed against a future daemon generation), and never
// logged.
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";

export const OTC_TTL_MS = 60 * 1000;
const OTC_ENTROPY_BYTES = 16; // 128 bits

interface OtcEntry {
  readonly code: string;
  readonly expiresAt: number;
}

export interface OtcStore {
  /** Mint a single-use code valid for OTC_TTL_MS. */
  readonly issue: () => string;
  /**
   * Consume a code. Returns the code's id on success (after which the code is
   * dead), or null if the code is unknown, already consumed, or expired.
   * Consumption is destructive: a consumed code can never be redeemed again.
   */
  readonly consume: (code: string) => string | null;
}

/** In-memory OTC store. Instance-bound by construction. */
export const makeOtcStore = (now: () => number = Date.now): OtcStore => {
  const codes = new Map<string, OtcEntry>();

  const pruneExpired = (): void => {
    const t = now();
    for (const [code, entry] of codes) {
      if (entry.expiresAt <= t) codes.delete(code);
    }
  };

  return {
    issue: () => {
      pruneExpired();
      // Collision odds are negligible at 128 bits, but loop anyway so a
      // pathological collision can never silently clobber a live code.
      let code = randomBytes(OTC_ENTROPY_BYTES).toString("base64url");
      while (codes.has(code)) {
        code = randomBytes(OTC_ENTROPY_BYTES).toString("base64url");
      }
      codes.set(code, { code, expiresAt: now() + OTC_TTL_MS });
      return code;
    },

    consume: (code) => {
      pruneExpired();
      const entry = codes.get(code);
      if (entry === undefined) return null;
      codes.delete(code);
      return entry.expiresAt > now() ? entry.code : null;
    },
  };
};
