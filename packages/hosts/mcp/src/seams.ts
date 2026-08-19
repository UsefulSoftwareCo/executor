import { Context, Effect, Layer, Schema } from "effect";
import type { Cause } from "effect";

// ---------------------------------------------------------------------------
// Provider-neutral MCP serving seams.
//
// The shared MCP serving envelope (see `./envelope`) depends ONLY on these TWO
// seams. Each product (self-host, cloud, local) provides its own Layer
// satisfying the same tags; the envelope never changes. The seams are kept
// deliberately small — anything provider-specific (Durable-Object trace
// propagation, response-peeking, browser-approval stores, elicitation modes,
// per-org engine construction) is configured *inside* a provider's adapter and
// never baked into the envelope.
//
// Two seams, deliberately:
//   1. McpAuthProvider — called on EVERY request. Authenticate AND authorize
//      (it may read the `mcp-session-id` header to do session-aware org-authz).
//   2. McpSessionStore — owns the serving session lifecycle: create + forward +
//      ownership, end to end, via a single `dispatch`. The store builds/forwards
//      the transport and returns the transport `Response`.
//
// There is deliberately NO envelope-level engine seam. Self-host's in-process
// store builds its engine via an INTERNAL dependency (its Layer provides it);
// cloud's Durable-Object store builds its engine inside the DO. The engine is a
// store implementation detail, not an envelope seam.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared domain — the authenticated principal.
//
// One word per concept: this is the SAME authenticated-caller noun the
// executor-API runs on (`Principal` in `@executor-js/api/server`); the shapes
// are byte-identical so the Better Auth / WorkOS adapters map onto it without
// translation. host-mcp keeps its own Schema'd copy (it does not depend on
// `@executor-js/api`) so it remains the validated boundary between auth
// (provider) and serving (envelope).
// ---------------------------------------------------------------------------

export const Principal = Schema.Struct({
  accountId: Schema.String,
  organizationId: Schema.String,
  organizationName: Schema.String,
  /** The org's URL slug, when the auth provider resolved it. Threaded into
   *  browser-handoff URLs so they open the right org's console. Optional so a
   *  provider without it (no org row loaded) still maps onto this shape. */
  organizationSlug: Schema.optional(Schema.String),
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  roles: Schema.Array(Schema.String),
});

export type Principal = Schema.Schema.Type<typeof Principal>;

/** Ownership is keyed on (accountId, organizationId) — a subset of the principal. */
export const principalOwns = (owner: Principal, principal: Principal): boolean =>
  owner.accountId === principal.accountId && owner.organizationId === principal.organizationId;

// ---------------------------------------------------------------------------
// Shared MCP resource identity.
//
// The default `/mcp` endpoint and named sub-resources such as
// `/mcp/toolkits/<slug>` share auth and transport machinery, but a serving
// session belongs to the exact resource path that minted it. This keeps a
// leaked/reused `mcp-session-id` from crossing from one exposed capability set
// into another.
// ---------------------------------------------------------------------------

export type McpResource =
  | { readonly kind: "default" }
  | { readonly kind: "toolkit"; readonly slug: string };

export const defaultMcpResource: McpResource = { kind: "default" };

// Tolerates a missing resource (null/undefined): sessions persisted before
// scoped toolkits existed have no `resource` field, and every such session was
// minted against the default `/mcp` endpoint, so a missing resource keys to
// "default". Keeping this guard here means no caller can throw on legacy data.
export const mcpResourceKey = (resource: McpResource | null | undefined): string =>
  resource && resource.kind !== "default" ? `toolkit:${resource.slug}` : "default";

// ---------------------------------------------------------------------------
// AuthOutcome — the result of `McpAuthProvider.authenticate`.
//
// A typed, never-failing discriminated union (NOT `Principal | null`, NOT an
// error channel) so a provider can distinguish the cases the envelope renders
// differently:
//
//   Authenticated -> proceed to session dispatch
//   Unauthorized  -> 401 + RFC 9728 `WWW-Authenticate` challenge
//   Forbidden     -> 403 JSON-RPC error (cloud: "No organization in session …",
//                    default code -32001) — a VALID bearer that lacks the
//                    authorization the resource requires (e.g. no org). Because
//                    `authenticate` runs on EVERY request, a provider can return
//                    Forbidden on a reused session too; the envelope then
//                    disposes that session before rendering the 403.
//   Unavailable   -> 503 JSON-RPC error (cloud: "Authentication temporarily
//                    unavailable …") — a transient verification failure the
//                    client should retry.
//
// Plain tagged objects (consumed in-process by the envelope's `Match`), with
// constructors so providers never hand-roll the shape. `Principal` is the
// only field that is itself Schema-validated; the union does not cross a
// serialization boundary, so it stays a TS union rather than a decoded Schema.
// ---------------------------------------------------------------------------

export interface McpAuthenticated {
  readonly _tag: "Authenticated";
  readonly principal: Principal;
}

export interface McpUnauthorized {
  readonly _tag: "Unauthorized";
  /**
   * The full `WWW-Authenticate: Bearer …` challenge value to emit on the 401.
   * When omitted the envelope synthesizes a default from
   * {@link McpAuthProvider.resourceMetadataUrl}. A provider that needs a
   * reason-sensitive challenge (cloud: `missing_bearer` -> no `error=` param,
   * `invalid_token` -> `error="invalid_token", error_description=…`) supplies
   * the exact string here.
   */
  readonly challenge?: string;
}

export interface McpForbidden {
  readonly _tag: "Forbidden";
  /** JSON-RPC error code; defaults to -32001 (cloud's no-org code). */
  readonly code?: number;
  readonly message: string;
}

export interface McpUnavailable {
  readonly _tag: "Unavailable";
  readonly message: string;
}

export type AuthOutcome = McpAuthenticated | McpUnauthorized | McpForbidden | McpUnavailable;

export const authenticated = (principal: Principal): McpAuthenticated => ({
  _tag: "Authenticated",
  principal,
});

export const unauthorized = (challenge?: string): McpUnauthorized =>
  challenge === undefined ? { _tag: "Unauthorized" } : { _tag: "Unauthorized", challenge };

export const forbidden = (message: string, code?: number): McpForbidden =>
  code === undefined ? { _tag: "Forbidden", message } : { _tag: "Forbidden", code, message };

export const unavailable = (message: string): McpUnavailable => ({
  _tag: "Unavailable",
  message,
});

// ===========================================================================
// SEAM 1 — McpAuthProvider: OAuth metadata + per-request authn/authz + challenge.
//
// The envelope serves the provider-DECLARED `/.well-known/oauth-*` docs from
// here and calls `authenticate` on EVERY `/mcp` request (create, forward,
// GET, DELETE). The OAuth endpoints themselves (/authorize, /token, /register)
// are NOT part of this seam — they are served by the provider's own handler
// (self-host: Better Auth at /api/auth; cloud: WorkOS, external), because the
// envelope only needs discovery routes + authenticate + resource URL.
// ===========================================================================

/**
 * One provider-served discovery document the envelope mounts as `GET path`.
 * The provider OWNS its paths (self-host serves the bare origin-root docs;
 * cloud serves `/.well-known/oauth-protected-resource/mcp`), so the envelope
 * never hard-codes them.
 */
export interface McpDiscoveryRoute {
  /** Absolute path the envelope mounts as `GET path` (an `HttpRouter` PathInput). */
  readonly path: `/${string}`;
  readonly handler: (request: Request) => Effect.Effect<Response>;
}

export class McpAuthProvider extends Context.Service<
  McpAuthProvider,
  {
    /**
     * The discovery routes this provider serves (at minimum the protected-
     * resource metadata document). The envelope registers a `GET` for each.
     */
    readonly discoveryRoutes: ReadonlyArray<McpDiscoveryRoute>;
    /**
     * The absolute `resource_metadata` URL clients should follow from a 401,
     * derived from the request (so it carries the live origin). Used by the
     * envelope ONLY to build a default challenge when an `Unauthorized` outcome
     * does not carry its own `challenge` string. Self-host =
     * bare `…/.well-known/oauth-protected-resource`; cloud =
     * `…/.well-known/oauth-protected-resource/mcp`.
     */
    readonly resourceMetadataUrl: (request: Request) => string;
    /**
     * Resolve a request to a typed {@link AuthOutcome}. Never fails: provider
     * errors collapse into `Unauthorized`/`Unavailable` outcomes.
     *
     * Called on EVERY request, so the provider may read the `mcp-session-id`
     * header to do session-aware org-authorization (cloud re-checks live org
     * membership on reused sessions and returns `Forbidden` when revoked; the
     * envelope then disposes the session). Self-host pins one org and never
     * returns Forbidden/Unavailable.
     *
     * MUST enforce token expiry itself — Better Auth's `getMcpSession` does NOT
     * validate `accessTokenExpiresAt`, so an expired token must resolve to
     * `Unauthorized` here.
     */
    readonly authenticate: (request: Request) => Effect.Effect<AuthOutcome>;
  }
>()("@executor-js/host-mcp/McpAuthProvider") {}

// ===========================================================================
// SEAM 2 — McpSessionStore: the ENTIRE MCP serving-session lifecycle.
//
// `dispatch` owns create + forward + ownership end to end:
//   - sessionId null  + POST initialize -> build/forward, returns the transport
//     `Response` (incl. the minted `mcp-session-id` header).
//   - sessionId present -> reuse/forward the existing session's transport.
//   - cross-bearer       -> `"forbidden"` (403 -32003).
//   - unknown / timed out -> `"not-found"` (404 -32001).
//
// The store receives the full inbound `Request` (so a cross-isolate forward can
// stream the body and inject identity/trace headers) and the `method` (so it can
// distinguish GET peek-vs-stream from POST/DELETE). It owns transport creation,
// `server.connect`, `handleRequest`, the session id, ownership, and lifetime.
//
// There is no envelope-level engine seam: the store builds its engine itself
// (self-host: an INTERNAL dependency the store's Layer provides; cloud: inside
// the DO).
// ===========================================================================

export interface McpDispatchInput {
  readonly request: Request;
  readonly principal: Principal;
  readonly resource: McpResource;
  readonly sessionId: string | null;
  readonly method: string;
}

/**
 * The result of `dispatch`. A `Response` is returned verbatim (SSE-safe);
 * `"not-found"` and `"forbidden"` are DISTINCT discriminants the envelope maps
 * to 404 -32001 and 403 -32003 respectively.
 */
export type McpDispatchResult = Response | "not-found" | "forbidden";

export class McpSessionStore extends Context.Service<
  McpSessionStore,
  {
    /**
     * Serve one `/mcp` request end to end. Owns create (no session id + POST
     * initialize), forward (session id present), and ownership (cross-bearer ->
     * `"forbidden"`). Returns the transport `Response` to pass through, or a
     * `"not-found"` / `"forbidden"` discriminant for the envelope to render.
     */
    readonly dispatch: (input: McpDispatchInput) => Effect.Effect<McpDispatchResult>;
    /**
     * Tear down a session by id (idempotent).
     *
     * `request` carries the inbound `Request` SO a cross-isolate store (cloud's
     * Durable Object) can forward it and propagate the request's W3C trace
     * context (tracestate/baggage) onto the disposal RPC, stitching the teardown
     * into the same trace. A single-node store (self-host / local) IGNORES it —
     * the dispose runs in-process and carries no inbound trace context — which is
     * why it is optional. The envelope passes it on the Forbidden-with-session
     * teardown (the only call site that has a live request).
     */
    readonly dispose: (sessionId: string, request?: Request) => Effect.Effect<void>;
  }
>()("@executor-js/host-mcp/McpSessionStore") {}

// ===========================================================================
// SEAM 3 (optional) — McpErrorReporter: observe a request-orchestration defect.
//
// The envelope wraps the entire `/mcp` handling in a top-level `catchCause` and
// renders a JSON-RPC 500 -32603 (the streamable-HTTP transport never sees the
// raw defect; the client gets a stable error envelope + CORS). Because the
// envelope swallows the cause into a `Response`, a provider's existing error
// pipeline (cloud: Sentry `captureException`; self-host: `ErrorCapture`) would
// otherwise NEVER see it. This OPTIONAL seam restores that observability: the
// envelope yields `reporter.report(cause)` before rendering the 500.
//
// The default Layer ({@link McpErrorReporterNoop}) is a no-op, so host-mcp stays
// decoupled — a provider overrides it to forward the cause to its own capture.
// ===========================================================================

export class McpErrorReporter extends Context.Service<
  McpErrorReporter,
  {
    /**
     * Report an orchestration defect the envelope is about to render as a
     * JSON-RPC 500. Never fails (the 500 is rendered regardless); a provider
     * forwards the cause to Sentry / its `ErrorCapture` here.
     */
    readonly report: (cause: Cause.Cause<unknown>) => Effect.Effect<void>;
  }
>()("@executor-js/host-mcp/McpErrorReporter") {}

/**
 * The no-op default. host-mcp ships this so the envelope can always resolve the
 * seam; providers override it (cloud: Sentry capture + console; self-host:
 * `ErrorCapture`) to regain orchestration-defect observability.
 */
export const McpErrorReporterNoop: Layer.Layer<McpErrorReporter> = Layer.succeed(McpErrorReporter)({
  report: () => Effect.void,
});
