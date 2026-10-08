import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Which credential shape a bearer token last resolved as.
//
// Every MCP request authenticates from scratch, and a bearer can be one of
// three things: an mcp() OAuth access token, a bearer session token, or an API
// key presented as a bearer. The resolver tries them in that order, so an API
// key pays for two database lookups that can never match it before the one
// that does. The portal in front of production opens a new session for every
// tool call, so that waste repeats three to four times per call.
//
// This memo records, per Better Auth instance, the digests of tokens that last
// resolved as API keys so the next request can go straight to the API key
// lookup. It is a routing hint, never a credential cache: the key itself is
// still verified against the database on every request, so a revoked, expired
// or disabled key fails exactly as before — and is forgotten on that failure.
// Digests only, bounded, oldest first.
// ---------------------------------------------------------------------------

const MAX_REMEMBERED = 1024;

export interface BearerShapeMemo {
  /** Whether `token` last resolved as an API key. */
  readonly isApiKey: (token: string) => boolean;
  readonly rememberApiKey: (token: string) => void;
  readonly forget: (token: string) => void;
  readonly size: () => number;
}

const digest = (token: string): string => createHash("sha256").update(token).digest("hex");

export const makeBearerShapeMemo = (): BearerShapeMemo => {
  const remembered = new Set<string>();
  return {
    isApiKey: (token) => remembered.has(digest(token)),
    rememberApiKey: (token) => {
      const key = digest(token);
      if (remembered.has(key)) return;
      if (remembered.size >= MAX_REMEMBERED) {
        const oldest = remembered.values().next().value;
        if (oldest !== undefined) remembered.delete(oldest);
      }
      remembered.add(key);
    },
    forget: (token) => {
      remembered.delete(digest(token));
    },
    size: () => remembered.size,
  };
};

const memos = new WeakMap<object, BearerShapeMemo>();

/** The memo for one Better Auth instance (the MCP auth seam and the identity
 *  seam share it, so a key learned by either is a hint for both). */
export const bearerShapeMemoFor = (auth: object): BearerShapeMemo => {
  const existing = memos.get(auth);
  if (existing) return existing;
  const created = makeBearerShapeMemo();
  memos.set(auth, created);
  return created;
};

export const bearerTokenOf = (headers: Headers): string | undefined => {
  const authorization = headers.get("authorization");
  if (!authorization) return undefined;
  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim() || undefined
    : undefined;
};
