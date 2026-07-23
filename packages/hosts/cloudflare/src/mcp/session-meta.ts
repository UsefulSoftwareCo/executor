import type { McpSessionInit, SessionMeta } from "./agent-session-durable-object";

/**
 * Merge the host-resolved meta with the fields the base carries verbatim from
 * `McpSessionInit`: `webOrigin` and the verified `principal`. Carrying them
 * here (rather than in every host's `resolveSessionMeta`) keeps each host's
 * resolver lossless without it knowing about either field, and mirrors what
 * the in-memory session store gives `buildServer`: the whole principal.
 */
export const carrySessionInit = (
  resolved: SessionMeta,
  token: Pick<McpSessionInit, "webOrigin" | "principal">,
): SessionMeta => ({
  ...resolved,
  ...(token.webOrigin ? { webOrigin: token.webOrigin } : {}),
  ...(token.principal ? { principal: token.principal } : {}),
});
