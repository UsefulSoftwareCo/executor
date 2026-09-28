import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Connected clients API — what is signed in as you, and how to cut it off
// (app-local, self-host only).
//
// Two credential kinds live here because nothing else serves them: the MCP
// clients that connected over OAuth (Claude Code, Cursor, Codex, …) and the
// browser sessions you are signed in with. Personal API keys already have the
// shared /account/api-keys surface, which the console page reuses rather than
// duplicating.
//
// Everything is scoped to the caller's OWN credentials, and every route is
// refused unless the request is the signed-in browser itself (see handlers.ts):
// an agent holding an API key or an OAuth token must not be able to list, let
// alone revoke, the credentials of the person it acts for.
//
// Browser-safe: schemas + the HttpApi value only (no server imports), so the
// web client can build a typed AtomHttpApi from it.
// ---------------------------------------------------------------------------

export class AccessError extends Schema.TaggedErrorClass<AccessError>()(
  "AccessError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

export class AccessUnauthorized extends Schema.TaggedErrorClass<AccessUnauthorized>()(
  "AccessUnauthorized",
  {},
  { httpApiStatus: 401 },
) {}

/** Refused: not the signed-in browser, a cross-origin request, or an attempt
 *  to revoke the session making the request. */
export class AccessForbidden extends Schema.TaggedErrorClass<AccessForbidden>()(
  "AccessForbidden",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

export class AccessNotFound extends Schema.TaggedErrorClass<AccessNotFound>()(
  "AccessNotFound",
  {},
  { httpApiStatus: 404 },
) {}

/** An MCP client that connected to this instance as you, over OAuth. */
export const OAuthClientEntry = Schema.Struct({
  clientId: Schema.String,
  /** The name the client registered ("Claude Code"). Client-chosen text,
   *  cleaned and bounded before it is served. */
  name: Schema.NullOr(Schema.String),
  /** Epoch ms. When the client registered itself. */
  registeredAt: Schema.NullOr(Schema.Number),
  /** Epoch ms. The latest token issued to it for you — its last sign-in or
   *  refresh. */
  lastAuthorizedAt: Schema.NullOr(Schema.Number),
  /** Tokens that can still be used or refreshed. Zero means the client has
   *  to sign in again before it can call anything. */
  activeTokens: Schema.Number,
});

/** A browser (or other cookie) session you are signed in with. */
export const SessionEntry = Schema.Struct({
  id: Schema.String,
  /** Epoch ms. */
  createdAt: Schema.Number,
  /** Epoch ms. The session's last refresh — roughly its last use. */
  lastActiveAt: Schema.Number,
  /** Epoch ms. */
  expiresAt: Schema.Number,
  userAgent: Schema.NullOr(Schema.String),
  ipAddress: Schema.NullOr(Schema.String),
  /** The session making this request — it cannot revoke itself here. */
  current: Schema.Boolean,
});

export const ConnectedClientsResponse = Schema.Struct({
  oauthClients: Schema.Array(OAuthClientEntry),
  sessions: Schema.Array(SessionEntry),
});

export const RevokeResponse = Schema.Struct({
  /** How many credentials were removed. */
  revoked: Schema.Number,
});

const accessErrors = [AccessError, AccessUnauthorized, AccessForbidden, AccessNotFound];

// Paths are `/access/*` (no `/api`): the server mounts this on the same
// `/api`-prefixed router as the core API, and the client prepends the `/api`
// base — symmetric with the admin API.
export const AccessApi = HttpApiGroup.make("access")
  .add(
    HttpApiEndpoint.get("listConnectedClients", "/access/clients", {
      success: ConnectedClientsResponse,
      error: accessErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("revokeOAuthClient", "/access/oauth-clients/:clientId", {
      params: { clientId: Schema.String.check(Schema.isMaxLength(256)) },
      success: RevokeResponse,
      error: accessErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("revokeSession", "/access/sessions/:sessionId", {
      params: { sessionId: Schema.String.check(Schema.isMaxLength(256)) },
      success: RevokeResponse,
      error: accessErrors,
    }),
  );

/**
 * Standalone HttpApi wrapping the access group — used to build the self-host
 * `AccessApiClient` atoms in the web app, and mounted server-side as an
 * extension route layer.
 */
export const AccessHttpApi = HttpApi.make("executor-self-host-access").add(AccessApi);
