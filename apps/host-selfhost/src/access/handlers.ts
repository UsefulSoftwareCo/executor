import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { Effect, Layer, Predicate, Schema } from "effect";

import {
  AccessError,
  AccessForbidden,
  AccessHttpApi,
  AccessNotFound,
  AccessUnauthorized,
  type OAuthClientEntry,
  type SessionEntry,
} from "./api";
import { BetterAuth, type BetterAuthHandle } from "../auth/better-auth";

// ---------------------------------------------------------------------------
// Handlers for the connected-clients API. Two rules carry the security:
//
//  1. ONLY THE SIGNED-IN BROWSER. A request carrying `Authorization` or
//     `x-api-key` is refused before any lookup, even though Better Auth would
//     happily resolve it: the credentials this plane lists and revokes are
//     exactly the ones an agent holds, and an agent must not be able to see or
//     cut off the person it acts for (or quietly re-authorize itself).
//  2. ONLY YOUR OWN. Every read and delete is filtered on the caller's user
//     id; a client id or session id that belongs to someone else reads as
//     not found, never as forbidden, so ids cannot be probed.
//
// Mutations additionally require a same-origin `Origin` — a browser always
// sends one on a DELETE — so a page elsewhere cannot drive them with the
// user's cookie. Tokens, key hashes and client secrets never leave the server.
// ---------------------------------------------------------------------------

/** Longest client name served. A client names itself at registration. */
const NAME_LIMIT = 80;
/** Upper bound on credential rows read per list — a user with more OAuth
 *  tokens than this has a problem this page is not the tool for. */
const ROW_LIMIT = 5000;

const requestHeaders = Effect.map(
  HttpServerRequest.HttpServerRequest.asEffect(),
  (request): Headers => new Headers({ ...request.headers }),
);

interface Caller {
  readonly userId: string;
  readonly sessionId: string;
}

/** Rule 1 + 2: a cookie session and nothing else, resolved to its user. */
const requireBrowserSession = (headers: Headers) =>
  Effect.gen(function* () {
    if (headers.has("authorization") || headers.has("x-api-key")) {
      return yield* new AccessForbidden({
        message: "Connected clients can only be managed from the signed-in web console.",
      });
    }
    const { auth } = yield* BetterAuth;
    const resolved = yield* Effect.tryPromise({
      try: () => auth.api.getSession({ headers }),
      catch: () => new AccessError({ message: "Session lookup failed" }),
    });
    if (!resolved) return yield* new AccessUnauthorized();
    return { userId: resolved.user.id, sessionId: resolved.session.id } satisfies Caller;
  });

/** Mutations only from this instance's own pages. */
const requireSameOrigin = (headers: Headers, allowedOrigins: ReadonlySet<string>) => {
  const origin = headers.get("origin");
  return origin !== null && allowedOrigins.has(origin)
    ? Effect.void
    : Effect.fail(new AccessForbidden({ message: "Cross-origin request refused." }));
};

// What the adapter hands back is untyped, so each row is decoded at this
// boundary; extra columns (tokens, secrets) are dropped by construction.
const Timestamp = Schema.Union([Schema.Date, Schema.String, Schema.Number]);
const TokenRow = Schema.Struct({
  clientId: Schema.String,
  createdAt: Schema.NullishOr(Timestamp),
  accessTokenExpiresAt: Schema.NullishOr(Timestamp),
  refreshTokenExpiresAt: Schema.NullishOr(Timestamp),
});
const ConsentRow = Schema.Struct({ clientId: Schema.String });
const ApplicationRow = Schema.Struct({
  clientId: Schema.String,
  name: Schema.NullishOr(Schema.String),
  createdAt: Schema.NullishOr(Timestamp),
});
const SessionRow = Schema.Struct({
  id: Schema.String,
  token: Schema.String,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  expiresAt: Timestamp,
  userAgent: Schema.NullishOr(Schema.String),
  ipAddress: Schema.NullishOr(Schema.String),
});

const decodeTokens = Schema.decodeUnknownEffect(Schema.Array(TokenRow));
const decodeConsents = Schema.decodeUnknownEffect(Schema.Array(ConsentRow));
const decodeApplications = Schema.decodeUnknownEffect(Schema.Array(ApplicationRow));
const decodeSessions = Schema.decodeUnknownEffect(Schema.Array(SessionRow));

const toMs = (value: Date | string | number | null | undefined): number | null => {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
};

// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/g;

/** Collapse whitespace, drop control characters, bound the length. */
const cleanName = (value: string | null | undefined): string | null => {
  if (value == null) return null;
  const cleaned = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > NAME_LIMIT ? `${cleaned.slice(0, NAME_LIMIT)}…` : cleaned;
};

type Adapter = Awaited<BetterAuthHandle["auth"]["$context"]>["adapter"];

const adapterOf = Effect.gen(function* () {
  const { auth } = yield* BetterAuth;
  const { adapter } = yield* Effect.promise(() => auth.$context);
  return adapter;
});

const read = <A>(op: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: () => new AccessError({ message: `Failed to ${op}` }) });

const undecodable = (op: string) => () => new AccessError({ message: `Unreadable rows (${op})` });

/** The MCP OAuth clients holding a token or a consent for this user. */
const listOAuthClients = (adapter: Adapter, userId: string, now: number) =>
  Effect.gen(function* () {
    const byUser = [{ field: "userId", value: userId }];
    const tokens = yield* read("list OAuth tokens", () =>
      adapter.findMany({ model: "oauthAccessToken", where: byUser, limit: ROW_LIMIT }),
    ).pipe(Effect.flatMap(decodeTokens), Effect.mapError(undecodable("oauthAccessToken")));
    const consents = yield* read("list OAuth consents", () =>
      adapter.findMany({ model: "oauthConsent", where: byUser, limit: ROW_LIMIT }),
    ).pipe(Effect.flatMap(decodeConsents), Effect.mapError(undecodable("oauthConsent")));

    const clientIds = [...new Set([...tokens, ...consents].map((row) => row.clientId))];
    if (clientIds.length === 0) return [];
    const applications = yield* read("list OAuth clients", () =>
      adapter.findMany({
        model: "oauthApplication",
        where: [{ field: "clientId", operator: "in", value: clientIds }],
        limit: clientIds.length,
      }),
    ).pipe(Effect.flatMap(decodeApplications), Effect.mapError(undecodable("oauthApplication")));
    const appById = new Map(applications.map((app) => [app.clientId, app]));

    const entries = clientIds.map((clientId): typeof OAuthClientEntry.Type => {
      const own = tokens.filter((token) => token.clientId === clientId);
      const issued = own.map((token) => toMs(token.createdAt)).filter(Predicate.isNotNull);
      const usable = own.filter((token) => {
        const access = toMs(token.accessTokenExpiresAt);
        const refresh = toMs(token.refreshTokenExpiresAt);
        return (access !== null && access > now) || (refresh !== null && refresh > now);
      });
      const app = appById.get(clientId);
      return {
        clientId,
        name: cleanName(app?.name),
        registeredAt: toMs(app?.createdAt),
        lastAuthorizedAt: issued.length > 0 ? Math.max(...issued) : null,
        activeTokens: usable.length,
      };
    });
    // Most recently used first; never-authorized registrations last.
    return entries.sort((a, b) => (b.lastAuthorizedAt ?? 0) - (a.lastAuthorizedAt ?? 0));
  });

const listSessions = (headers: Headers, caller: Caller, now: number) =>
  Effect.gen(function* () {
    const { auth } = yield* BetterAuth;
    const sessions = yield* read("list sessions", () => auth.api.listSessions({ headers })).pipe(
      Effect.flatMap(decodeSessions),
      Effect.mapError(undecodable("session")),
    );
    return sessions
      .map((session): typeof SessionEntry.Type => ({
        id: session.id,
        createdAt: toMs(session.createdAt) ?? 0,
        lastActiveAt: toMs(session.updatedAt) ?? 0,
        expiresAt: toMs(session.expiresAt) ?? 0,
        userAgent: session.userAgent ?? null,
        ipAddress: session.ipAddress ?? null,
        current: session.id === caller.sessionId,
      }))
      .filter((session) => session.expiresAt > now)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  });

const makeAccessHandlers = (allowedOrigins: ReadonlySet<string>) =>
  HttpApiBuilder.group(AccessHttpApi, "access", (handlers) =>
    handlers
      .handle("listConnectedClients", () =>
        Effect.gen(function* () {
          const headers = yield* requestHeaders;
          const caller = yield* requireBrowserSession(headers);
          const adapter = yield* adapterOf;
          const now = Date.now();
          return {
            oauthClients: yield* listOAuthClients(adapter, caller.userId, now),
            sessions: yield* listSessions(headers, caller, now),
          };
        }),
      )
      .handle("revokeOAuthClient", ({ params }) =>
        Effect.gen(function* () {
          const headers = yield* requestHeaders;
          yield* requireSameOrigin(headers, allowedOrigins);
          const caller = yield* requireBrowserSession(headers);
          const adapter = yield* adapterOf;
          // The caller's rows for this client only — another user's tokens for
          // the same client are theirs to revoke.
          const where = [
            { field: "clientId", value: params.clientId },
            { field: "userId", value: caller.userId },
          ];
          // Tokens AND consent: without the consent row the client cannot
          // silently mint a new token — it must bring the user back through
          // the approval screen.
          const tokens = yield* read("revoke OAuth tokens", () =>
            adapter.deleteMany({ model: "oauthAccessToken", where }),
          );
          const consents = yield* read("revoke OAuth consent", () =>
            adapter.deleteMany({ model: "oauthConsent", where }),
          );
          if (tokens + consents === 0) return yield* new AccessNotFound();
          return { revoked: tokens };
        }),
      )
      .handle("revokeSession", ({ params }) =>
        Effect.gen(function* () {
          const headers = yield* requestHeaders;
          yield* requireSameOrigin(headers, allowedOrigins);
          const caller = yield* requireBrowserSession(headers);
          if (params.sessionId === caller.sessionId) {
            return yield* new AccessForbidden({
              message: "This is the session you are using — sign out instead.",
            });
          }
          const { auth } = yield* BetterAuth;
          // Better Auth revokes by token and checks ownership itself; the id →
          // token lookup happens here, server-side, over the caller's own list.
          const sessions = yield* read("list sessions", () =>
            auth.api.listSessions({ headers }),
          ).pipe(Effect.flatMap(decodeSessions), Effect.mapError(undecodable("session")));
          const target = sessions.find((session) => session.id === params.sessionId);
          if (!target) return yield* new AccessNotFound();
          yield* read("revoke session", () =>
            auth.api.revokeSession({ headers, body: { token: target.token } }),
          );
          return { revoked: 1 };
        }),
      ),
  );

export interface SelfHostAccessApiDeps {
  readonly betterAuth: BetterAuthHandle;
  readonly mountPrefix: `/${string}`;
  /** The instance's own origins (`webBaseUrl` + configured aliases); a
   *  mutation from any other origin is refused. */
  readonly trustedOrigins: readonly string[];
}

/**
 * The mountable extension route layer: registers the access routes on the
 * `mountPrefix`-prefixed view of the ambient router (so `/access/*` is served
 * at `/api/access/*`), with the Better Auth handle provided per request — the
 * same construction as the admin API layer.
 */
export const makeSelfHostAccessApiLayer = ({
  betterAuth,
  mountPrefix,
  trustedOrigins,
}: SelfHostAccessApiDeps) => {
  const allowedOrigins = new Set(
    trustedOrigins.flatMap((value) => {
      const origin = URL.canParse(value) ? new URL(value).origin : null;
      return origin === null ? [] : [origin];
    }),
  );
  const prefixedRouter = Layer.effect(HttpRouter.HttpRouter)(
    Effect.map(HttpRouter.HttpRouter.asEffect(), (router) => router.prefixed(mountPrefix)),
  );
  return HttpApiBuilder.layer(AccessHttpApi).pipe(
    Layer.provide(makeAccessHandlers(allowedOrigins)),
    Layer.provide(prefixedRouter),
    HttpRouter.provideRequest(Layer.succeed(BetterAuth)(betterAuth)),
  );
};
