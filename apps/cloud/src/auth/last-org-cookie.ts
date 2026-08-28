// ---------------------------------------------------------------------------
// Last-visited-org cookie — the browser's "which org was I working in" memory.
//
// Org switching is stateless by design (the URL slug scopes every request; see
// organization.ts), which leaves nothing that remembers the last org across
// entries: the sealed session still carries the org pinned at LOGIN time, so a
// bare URL (`executor.sh/`) would always canonicalize onto that first org. This
// cookie fills the gap: the client records the slug of the org it's verifiably
// viewing, and the two bare-entry deciders honor it —
//
//   - the document auth gate redirects bare document paths onto it (doc-gate.ts)
//   - the login callback prefers it when picking the org for a fresh session
//     with a bare returnTo (handlers.ts)
//
// It is a PREFERENCE, never an authority: both readers re-check live membership
// through the same authorize path as any org selector, so a stale or forged
// value at worst falls back to today's behavior. Not HttpOnly — the client is
// the writer. Deliberately NOT cleared on logout: surviving the session is what
// lets the next login land on the last-used org.
// ---------------------------------------------------------------------------

export const LAST_ORG_COOKIE = "executor-last-org";

/** Outlives the 7d session on purpose — it spans logins. */
const LAST_ORG_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Browser-side write. Slugs are `[a-z0-9-]` by grammar, so no encoding. */
export const writeLastOrgCookie = (slug: string): void => {
  document.cookie = `${LAST_ORG_COOKIE}=${slug}; Path=/; Max-Age=${LAST_ORG_MAX_AGE_SECONDS}; SameSite=Lax${
    window.location.protocol === "https:" ? "; Secure" : ""
  }`;
};
