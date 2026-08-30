// ---------------------------------------------------------------------------
// The per-isolate MCP auth runtime memo, keyed on the bindings it captures.
//
// Cloudflare reuses warm isolates across binding-only deployments, and its
// docs call out exactly the `client ??= new Client(env.SECRET)` pattern as
// retaining stale credentials: a plain `runtime ??= ManagedRuntime.make(...)`
// would keep authenticating with the OLD WorkOS credentials after a
// WORKOS_API_KEY rotation until the isolate happened to be evicted — an auth
// outage once the old key is revoked. So the memo is keyed on a fingerprint
// of exactly the binding values the layer captures at build: same
// fingerprint -> reuse (one string compare per request), changed fingerprint
// -> build fresh. The ApiKeyService validation cache is NOT tied to the
// runtime — its map is module-scope in api-keys.ts (shared with the /api/*
// plane so revocation can invalidate it everywhere), so after a rotation its
// remaining entries age out within the 60s TTL rather than dropping with the
// rebuild.
//
// The superseded runtime is DROPPED, not disposed. `ManagedRuntime.dispose`
// tears down the runtime's scope, and requests already in flight may still be
// running programs against the old runtime's services — pulling the scope out
// from under them is not safe. Nothing is leaked by dropping: the MCP auth
// layer registers no finalizers (the WorkOS client is plain config; the
// org-auth postgres socket is built and closed per `authorize` call), so an
// unreferenced runtime is simply GC'd once the last in-flight request
// finishes. Rotations only happen on deploys, and at most one previous
// runtime is ever still referenced by in-flight work.
//
// This lives in its own `cloudflare:workers`-free leaf so the node-pool unit
// tests can exercise the rebuild semantics; agent-handler.ts is the one
// production consumer.
// ---------------------------------------------------------------------------

import type { ManagedRuntime } from "effect";

/** The env subset the MCP auth layer reads at build time. */
export type McpAuthBindings = Pick<
  Env,
  "WORKOS_API_KEY" | "WORKOS_CLIENT_ID" | "WORKOS_COOKIE_PASSWORD" | "WORKOS_API_URL"
>;

/**
 * The exact binding values `cloudMcpAuth` captures when its runtime is built —
 * `WorkOSClient`'s `make` (auth/workos.ts) reads precisely these four. A
 * joined string is enough to answer "did any of them change"; it CONTAINS the
 * live WORKOS_API_KEY, so it must never reach a log, span, or error message.
 * `WORKOS_API_URL` is genuinely optional (unset in production), so absence is
 * encoded as the empty string — the same "no override" the client resolves it
 * to (see `workosApiUrlOptions`).
 *
 * JSON-encoded rather than delimiter-joined: bindings may contain any byte
 * (workerd Text permits embedded NUL), so a raw join is not injective — a
 * delimiter byte inside one value could make two different binding sets
 * collide and suppress the rebuild a rotation requires. JSON escapes every
 * byte, so distinct value tuples always produce distinct fingerprints.
 *
 * Not included: the module-scope env reads in mcp/auth.ts (AUTHKIT_DOMAIN,
 * RESOURCE_ORIGIN, the JWKS cache, the JWT audience). Those are frozen at the
 * isolate's first module evaluation, so rebuilding the runtime cannot refresh
 * them — keying on them would force rebuilds that change nothing.
 */
export const mcpAuthBindingsFingerprint = (env: McpAuthBindings): string =>
  JSON.stringify([
    env.WORKOS_API_KEY,
    env.WORKOS_CLIENT_ID,
    env.WORKOS_COOKIE_PASSWORD,
    env.WORKOS_API_URL ?? "",
  ]);

/**
 * Memoize one built runtime per fingerprint value (holding only the latest):
 * an unchanged fingerprint returns the existing runtime, a changed one drops
 * it (see the header for why dropping, not disposing, is correct) and builds
 * a fresh runtime via `build`.
 */
export const makeBindingKeyedRuntime = <R, E>(
  build: () => ManagedRuntime.ManagedRuntime<R, E>,
): ((fingerprint: string) => ManagedRuntime.ManagedRuntime<R, E>) => {
  let runtime: ManagedRuntime.ManagedRuntime<R, E> | undefined;
  let fingerprint: string | undefined;
  return (next) => {
    if (runtime === undefined || fingerprint !== next) {
      runtime = build();
      fingerprint = next;
    }
    return runtime;
  };
};
