/**
 * Sign-in handoff from v1 for members of moved workspaces (`notes/v1-shutdown.md`, Forwarding).
 *
 * v2 offers no WorkOS sign-in and never starts one. v1's dashboard sends a signed-in member of an
 * organization that has moved to `/api/v1-handoff?token=…` after it has verified its own WorkOS
 * session and the member's membership. The token is v1 vouching for that session, signed with a
 * secret only v1 (`V2_SESSION_HANDOFF_SECRET`) and v2 (`V1_SESSION_HANDOFF_SECRET`) hold:
 *
 *     v1hnd.<base64url JSON claims>.<base64url HMAC-SHA256 of "v1hnd.<claims>">
 *
 * The claims name the WorkOS user, the v1 organization and the v2 organization's slug, with `iat`,
 * an `exp` at most a minute later and a random `jti`. v2 accepts each `jti` once, maps the WorkOS
 * user to a v2 user only through the import map, requires that user's membership of the
 * organization the v1 organization was imported as, and starts an ordinary Better Auth session.
 * It opens the organization this browser last used in v2 when that user is still its member, and
 * the token's organization otherwise: v1 names the organization of its own session, not the one
 * the member chose last. Every refusal opens the v2 sign-in page, returning to the token's
 * organization. Nothing here reads v1.
 */
import {
  AuthenticationUnavailable,
  auditFailureCodes,
  recordSecurityAudit,
} from "@executor-js/hosted-server";
import {
  LastOrganization,
  lastOrganizationCookie,
} from "@executor-js/hosted-server/browser/contracts";
import { OrganizationSlug } from "@executor-js/hosted-server/organization";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { Clock, Effect, Option, Redacted, Result, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import { Cookies, HttpServerRequest, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";

/** The route v1's dashboard redirects to. */
export const v1HandoffPath = "/api/v1-handoff";

const prefix = "v1hnd.";
const audience = "v2-session-handoff";
/** v1 gives a token a minute; one that claims longer is refused. */
const maxLifetimeSeconds = 60;
/** How far ahead of this Worker's clock v1's may run. */
const clockSkewSeconds = 30;

const Claims = Schema.Struct({
  v: Schema.Literal(1),
  aud: Schema.Literal(audience),
  /** The WorkOS user whose v1 session v1 verified. */
  user: Schema.NonEmptyString,
  /** The v1 organization that moved, a WorkOS organization ID. */
  organization: Schema.NonEmptyString,
  /** The v2 organization to open, as v1's moved flag names it. */
  slug: OrganizationSlug,
  iat: Schema.Int,
  exp: Schema.Int,
  jti: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(128)),
});
type Claims = typeof Claims.Type;

/** Only what a refusal needs to read from a token it did not accept: where to return to. */
const Destination = Schema.Struct({ slug: Schema.optionalKey(Schema.Unknown) });

/** Why a handoff opened the sign-in page; logged, never shown, and never with the token. */
const V1HandoffRefusal = Schema.Literals([
  "disabled",
  "malformed",
  "signature",
  "version",
  "audience",
  "expired",
  "lifetime",
  "replayed",
  "unmapped_user",
  "unknown_organization",
  "organization_mismatch",
  "not_member",
  "other_session",
]);
type V1HandoffRefusal = typeof V1HandoffRefusal.Type;

export class V1HandoffRefused extends Schema.TaggedError<V1HandoffRefused>()("V1HandoffRefused", {
  reason: V1HandoffRefusal,
}) {}

const refuse = (reason: V1HandoffRefusal) => new V1HandoffRefused({ reason });
const refusalCode = auditFailureCodes(V1HandoffRefusal.literals);

/** Better Auth could not start the session. */
export class V1HandoffSessionFailed extends Schema.TaggedError<V1HandoffSessionFailed>()(
  "V1HandoffSessionFailed",
  {},
) {}

const encoder = new TextEncoder();

/** The token's parts, when it has the shape v1 signs. */
const split = (token: string) => {
  if (!token.startsWith(prefix)) return undefined;
  const [payload, signature, ...rest] = token.slice(prefix.length).split(".");
  if (payload === undefined || signature === undefined || rest.length > 0) return undefined;
  return { payload, signature };
};

/** The decoded JSON of a payload, or undefined. */
const payloadJson = (payload: string) =>
  Result.match(Base64Url.decodeString(payload), {
    onFailure: () => undefined,
    onSuccess: (json) => Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(json),
  });

/**
 * The claims of a token v1 signed with `secret` that is current. The MAC is checked with
 * `crypto.subtle.verify`, which compares in constant time, before anything in the payload is read.
 */
const verify = (secret: Redacted.Redacted<string>, token: string) =>
  Effect.gen(function* () {
    const parts = split(token);
    if (parts === undefined) return yield* refuse("malformed");
    const mac = Base64Url.decode(parts.signature);
    if (Result.isFailure(mac)) return yield* refuse("malformed");
    const valid = yield* Effect.promise(async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(Redacted.value(secret)),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      return crypto.subtle.verify(
        "HMAC",
        key,
        new Uint8Array(mac.success),
        encoder.encode(`${prefix}${parts.payload}`),
      );
    });
    if (!valid) return yield* refuse("signature");
    const json = payloadJson(parts.payload);
    if (json === undefined || Option.isNone(json)) return yield* refuse("malformed");
    const loose = Schema.decodeUnknownOption(
      Schema.Struct({ v: Schema.Unknown, aud: Schema.Unknown }),
    )(json.value);
    if (Option.isNone(loose)) return yield* refuse("malformed");
    if (loose.value.v !== 1) return yield* refuse("version");
    if (loose.value.aud !== audience) return yield* refuse("audience");
    const claims = yield* Schema.decodeUnknownEffect(Claims)(json.value).pipe(
      Effect.mapError(() => refuse("malformed")),
    );
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    if (claims.exp <= now) return yield* refuse("expired");
    if (
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > maxLifetimeSeconds ||
      claims.iat > now + clockSkewSeconds
    )
      return yield* refuse("lifetime");
    return claims;
  });

/**
 * Accept the token's `jti` once. Rows of expired tokens are deleted first: an expired token is
 * refused before it gets here, so its row no longer guards anything. The margin covers the clock
 * difference between this Worker and the database.
 */
const consume = (sql: SqlClient.SqlClient, claims: Claims) =>
  Effect.gen(function* () {
    yield* sql`
      delete from private_v1_session_handoff where expires_at < now() - interval '5 minutes'`;
    const accepted = yield* sql`
      insert into private_v1_session_handoff (jti, expires_at)
      values (${claims.jti}, to_timestamp(${claims.exp}))
      on conflict (jti) do nothing
      returning jti`;
    if (accepted.length === 0) return yield* refuse("replayed");
  });

const Target = Schema.Struct({
  userId: Schema.NullOr(Schema.String),
  imported: Schema.NullOr(Schema.String),
  organization: Schema.NullOr(Schema.String),
  role: Schema.NullOr(Schema.String),
});

/**
 * The v2 user and organization the claims stand for, in one statement. The user is the import
 * map's record of the WorkOS user, created or merged by the import; nothing is matched by email.
 * The organization is the slug's, which must be the one the v1 organization was imported as.
 */
const target = (sql: SqlClient.SqlClient, claims: Claims) =>
  Effect.gen(function* () {
    const rows = yield* sql`
      with u as (
        select v2_id from private_v1_import_map
        where v1_kind = 'user' and v1_id = ${claims.user} and status = 'imported'
          and v2_kind in ('user', 'merged_user')
      ), o as (
        select id from organization where slug = ${claims.slug}
      )
      select
        (select v2_id from u) as "userId",
        (select v2_id from private_v1_import_map
          where v1_kind = 'organization' and v1_id = ${claims.organization}
            and status = 'imported') as imported,
        (select id from o) as organization,
        (select role from member
          where "userId" = (select v2_id from u) and "organizationId" = (select id from o)) as role`;
    const row = yield* Schema.decodeUnknownEffect(Target)(rows[0]);
    if (row.userId === null) return yield* refuse("unmapped_user");
    if (row.organization === null) return yield* refuse("unknown_organization");
    if (row.imported !== row.organization) return yield* refuse("organization_mismatch");
    if (row.role === null) return yield* refuse("not_member");
    return { user: row.userId, organization: row.organization };
  });

/** The organization this browser last opened, when the memory belongs to `user`. */
const rememberedOrganization = (request: HttpServerRequest.HttpServerRequest, user: string) => {
  const value = Cookies.parseHeader(request.headers.cookie ?? "")[
    lastOrganizationCookie(request.headers.host ?? "")
  ];
  if (value === undefined) return undefined;
  const saved = Schema.decodeUnknownOption(Schema.fromJsonString(LastOrganization))(value);
  return Option.isSome(saved) && saved.value.user === user ? saved.value.organization : undefined;
};

const Remembered = Schema.Struct({ id: Schema.String, slug: OrganizationSlug });

/**
 * The remembered organization's current slug, only while `user` is a member: the cookie is
 * navigation memory, so a removed membership or deleted organization falls back to the token's.
 */
const rememberedDestination = (sql: SqlClient.SqlClient, user: string, organization: string) =>
  Effect.gen(function* () {
    const rows = yield* sql`
      select o.id, o.slug from organization o
      join member m on m."organizationId" = o.id and m."userId" = ${user}
      where o.id = ${organization}`;
    return rows.length === 0 ? undefined : yield* Schema.decodeUnknownEffect(Remembered)(rows[0]);
  });

/** Where every response sends the browser: never back to a URL that carries the token. */
const redirect = (location: string, cookies: ReadonlyArray<string> = []) => {
  const headers = new Headers({
    location,
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return HttpServerResponse.fromWeb(new Response(null, { status: 302, headers }));
};

/** The sign-in page, returning to the organization the token named when it names one. */
const signIn = (token: string) => {
  const parts = split(token);
  const json = parts === undefined ? undefined : payloadJson(parts.payload);
  const slug =
    json === undefined || Option.isNone(json)
      ? undefined
      : Option.getOrUndefined(Schema.decodeUnknownOption(Destination)(json.value))?.slug;
  const returnTo = Schema.is(OrganizationSlug)(slug) ? `/org/${slug}` : "/";
  return redirect(`/login?redirect=${encodeURIComponent(returnTo)}`);
};

export interface V1HandoffServices<R> {
  readonly secret: Option.Option<Redacted.Redacted<string>>;
  readonly withSql: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.Effect<A, E>;
  /** The user of the session the request already carries, if any. */
  readonly currentUser: (
    headers: Headers,
  ) => Effect.Effect<string | undefined, AuthenticationUnavailable>;
  /** Start a Better Auth session for the user; its `Set-Cookie` values. */
  readonly startSession: (
    headers: Headers,
    user: string,
    organization: string,
  ) => Effect.Effect<ReadonlyArray<string>, V1HandoffSessionFailed, R>;
}

/** `GET /api/v1-handoff?token=…`: a session for the member v1 vouches for, or the sign-in page. */
export const v1SessionHandoff = <R>(services: V1HandoffServices<R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const token = new URL(request.url, "http://localhost").searchParams.get("token") ?? "";
    const headers = new Headers(request.headers);
    return yield* Effect.gen(function* () {
      if (Option.isNone(services.secret)) return yield* refuse("disabled");
      const claims = yield* verify(services.secret.value, token);
      const { user, destination } = yield* services.withSql(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* consume(sql, claims);
          const found = yield* target(sql, claims);
          const remembered = rememberedOrganization(request, found.user);
          const resumed =
            remembered === undefined || remembered === found.organization
              ? undefined
              : yield* rememberedDestination(sql, found.user, remembered);
          return {
            ...found,
            destination: resumed ?? { id: found.organization, slug: claims.slug },
          };
        }),
      );
      const current = yield* services.currentUser(headers);
      // A browser already signed in to v2 keeps its session: as this user it needs no other, and
      // another user's session is never replaced by a handoff.
      if (current !== undefined && current !== user) return yield* refuse("other_session");
      const cookies =
        current === user ? [] : yield* services.startSession(headers, user, destination.id);
      return redirect(`/org/${destination.slug}`, cookies);
    }).pipe(
      Effect.catchTag("V1HandoffRefused", (error) =>
        Effect.logInfo("v1 session handoff refused", { reason: error.reason }).pipe(
          Effect.andThen(
            recordSecurityAudit({
              action: "sign_in",
              outcome: "failure",
              failure: refusalCode(error.reason),
              detail: { method: "v1_handoff" },
            }),
          ),
          Effect.as(signIn(token)),
        ),
      ),
      // Storage, decoding or Better Auth failed: the member can still sign in.
      Effect.catch(() =>
        Effect.logWarning("v1 session handoff unavailable", { reason: "unavailable" }).pipe(
          Effect.as(signIn(token)),
        ),
      ),
      Effect.withSpan("auth.v1SessionHandoff"),
    );
  });

/**
 * Better Auth's half: a session for a user the handoff has already authorized, created and set as
 * every sign-in's is, so the session hooks (verified email, sign-in analytics) run too. Server only:
 * it has no URL, and only `v1SessionHandoff` calls it.
 */
export const v1HandoffSessions = () =>
  ({
    id: "executor-v1-session-handoff",
    endpoints: {
      startV1HandoffSession: createAuthEndpoint(
        "/v1-handoff/session",
        {
          method: "POST",
          requireHeaders: true,
          body: Schema.toStandardSchemaV1(
            Schema.Struct({ userId: Schema.NonEmptyString, organizationId: Schema.NonEmptyString }),
          ),
          metadata: { SERVER_ONLY: true },
        },
        async (ctx) => {
          const user = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
          if (!user) throw new APIError("NOT_FOUND");
          const session = await ctx.context.internalAdapter.createSession(user.id, false, {
            activeOrganizationId: ctx.body.organizationId,
          });
          if (!session) throw new APIError("INTERNAL_SERVER_ERROR");
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ userId: user.id });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
