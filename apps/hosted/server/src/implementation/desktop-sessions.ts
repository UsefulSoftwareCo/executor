import type { BetterAuthPlugin, GenericEndpointContext } from "@better-auth/core";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { GrantId } from "@executor-js/mcp-auth/grants";
import { authCall, runAuth } from "@executor-js/mcp-auth/oauth";
import { Clock, Config, Effect, Result, Schema } from "effect";
import {
  DesktopAccount,
  desktopAccountDescription,
  DesktopLinkBinding,
  DesktopLinkVerifier,
  DesktopReturnPath,
  DesktopSessionLinkRequest,
  desktopLinkCookieName,
  desktopLinkHeader,
  desktopLinkHeaderValue,
  desktopSessionDescription,
  desktopSessionLinkDescription,
  desktopSessionLinkSeconds,
  desktopSessionPath,
} from "../contracts/desktop-sessions.ts";

const Link = Schema.Struct({
  user: Schema.NonEmptyString,
  grant: GrantId,
  returnTo: DesktopReturnPath,
  binding: DesktopLinkBinding,
});
const LinkJson = Schema.fromJsonString(Link);
const Stored = Schema.Struct({ value: Schema.String, expiresAt: Schema.Date });
const OrganizationRow = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
});
const UserRow = Schema.Struct({ id: Schema.String, email: Schema.String });
const LinkCode = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

const parse = <A>(schema: Schema.Decoder<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => new APIError("BAD_REQUEST")),
  );
const linkLifetime = Config.Int("EXECUTOR_DESKTOP_SESSION_LINK_SECONDS").pipe(
  Config.withDefault(desktopSessionLinkSeconds),
  Effect.flatMap((seconds) =>
    seconds >= 1 && seconds <= desktopSessionLinkSeconds
      ? Effect.succeed(seconds)
      : Effect.fail(new APIError("SERVICE_UNAVAILABLE")),
  ),
  Effect.mapError(() => new APIError("SERVICE_UNAVAILABLE")),
);
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const digest = (code: string) =>
  authCall(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(code))).pipe(
    Effect.map((value) => hex(new Uint8Array(value))),
  );
const identifier = (hash: string) => `executor-desktop-link:v1:${hash}`;
const sameDigest = (left: string, right: string) => {
  let difference = left.length ^ right.length;
  for (let index = 0; index < left.length; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index % right.length);
  return difference === 0;
};
const refused = (message: string) => new APIError("BAD_REQUEST", { message });

const returnPath = (origin: string, value: string | undefined) =>
  Effect.gen(function* () {
    if (value === undefined) return DesktopReturnPath.make("/");
    const url = URL.parse(value, origin);
    const normalized = url === null ? undefined : `${url.pathname}${url.search}${url.hash}`;
    if (
      url === null ||
      url.origin !== origin ||
      normalized !== value ||
      !value.startsWith("/") ||
      value.startsWith("//") ||
      value.includes("\\") ||
      /%2f|%5c/iu.test(url.pathname) ||
      url.pathname === "/api" ||
      url.pathname.startsWith("/api/")
    )
      return yield* Effect.fail(
        refused("returnTo must be a normalized path on this Executor, outside /api."),
      );
    return yield* parse(DesktopReturnPath, value);
  });

class LinkRefused extends Schema.TaggedError<LinkRefused>()("LinkRefused", {
  reason: Schema.String,
}) {}
const refuse = (reason: string) => new LinkRefused({ reason });

const unavailablePage = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Executor</title><style>body{font-family:system-ui,sans-serif;margin:48px;color-scheme:light dark}</style><h1>Executor could not sign this window in</h1><p>The server could not finish signing in just now. Close this window and try again.</p></html>`;

const redeem = (ctx: GenericEndpointContext, options: DesktopSessionsOptions) =>
  Effect.gen(function* () {
    const code = yield* Schema.decodeUnknownEffect(LinkCode)(ctx.query?.["code"]).pipe(
      Effect.mapError(() => refuse("malformed code")),
    );
    const hash = yield* digest(code);
    const row = yield* authCall(() =>
      ctx.context.internalAdapter.consumeVerificationValue(identifier(hash)),
    );
    if (row === null) return yield* refuse("unknown or used code");
    const stored = yield* Schema.decodeUnknownEffect(Stored)(row).pipe(
      Effect.mapError(() => new APIError("SERVICE_UNAVAILABLE")),
    );
    if (stored.expiresAt.getTime() <= (yield* Clock.currentTimeMillis))
      return yield* refuse("expired");
    const link = yield* Schema.decodeUnknownEffect(LinkJson)(stored.value).pipe(
      Effect.mapError(() => new APIError("SERVICE_UNAVAILABLE")),
    );
    if (
      ctx.headers?.get(desktopLinkHeader) !== desktopLinkHeaderValue ||
      ctx.headers.get("sec-fetch-site") === "cross-site"
    )
      return yield* refuse("not opened by the desktop");
    const origin = options.origin;
    const cookie = desktopLinkCookieName(origin);
    const verifier = yield* Schema.decodeUnknownEffect(DesktopLinkVerifier)(
      ctx.getCookie(cookie),
    ).pipe(Effect.mapError(() => refuse("no binding cookie")));
    if (!sameDigest(yield* digest(verifier), link.binding))
      return yield* refuse("binding cookie does not match");
    ctx.setCookie(cookie, "", {
      path: "/",
      maxAge: 0,
      httpOnly: true,
      sameSite: "lax",
      secure: new URL(origin).protocol === "https:",
    });
    const current = yield* authCall(() => getSessionFromCtx(ctx));
    if (current !== null && current.user.id !== link.user)
      return yield* refuse("another user is signed in");
    if (current === null) {
      const user = yield* authCall(() => ctx.context.internalAdapter.findUserById(link.user));
      if (user === null) return yield* refuse("user removed");
      const session = yield* authCall(() => ctx.context.internalAdapter.createSession(user.id));
      if (session === null) return yield* Effect.fail(new APIError("SERVICE_UNAVAILABLE"));
      yield* options
        .bindSession(ctx, link.grant, session)
        .pipe(
          Effect.mapError((error) =>
            error.status === "UNAUTHORIZED" ? refuse("desktop sign-in revoked") : error,
          ),
        );
      yield* authCall(() => setSessionCookie(ctx, { session, user }));
    }
    return new URL(link.returnTo, origin).href;
  }).pipe(
    Effect.catchIf(Schema.is(LinkRefused), (refusal) =>
      Effect.logInfo("Desktop session link refused").pipe(
        Effect.annotateLogs({ reason: refusal.reason }),
        Effect.as(new URL("/login", options.origin).href),
      ),
    ),
  );

const grantAllowance = { window: 60, max: 20 } as const;
const RateRow = Schema.Struct({ lastRequest: Schema.Union([Schema.Number, Schema.BigInt]) });

const allow = (ctx: GenericEndpointContext, endpoint: string, grant: GrantId) =>
  Effect.gen(function* () {
    if (!ctx.context.rateLimit.enabled) return;
    const key = `executor-desktop:${endpoint}:${grant}`;
    const now = yield* Clock.currentTimeMillis;
    const windowMillis = grantAllowance.window * 1000;
    const counted = yield* authCall(() =>
      ctx.context.adapter.incrementOne({
        model: "rateLimit",
        where: [
          { field: "key", value: key },
          { field: "lastRequest", operator: "gt", value: now - windowMillis },
          { field: "count", operator: "lt", value: grantAllowance.max },
        ],
        increment: { count: 1 },
        set: { lastRequest: now },
      }),
    );
    if (counted !== null) return;
    const found = yield* authCall(() =>
      ctx.context.adapter.findOne({ model: "rateLimit", where: [{ field: "key", value: key }] }),
    );
    if (found === null) {
      yield* authCall(() =>
        ctx.context.adapter.create({
          model: "rateLimit",
          data: { key, count: 1, lastRequest: now },
        }),
      );
      return;
    }
    const row = yield* Schema.decodeUnknownEffect(RateRow)(found).pipe(
      Effect.mapError(() => new APIError("SERVICE_UNAVAILABLE")),
    );
    const last = Number(row.lastRequest);
    if (now - last < windowMillis) {
      ctx.setHeader("retry-after", String(Math.ceil((last + windowMillis - now) / 1000)));
      return yield* Effect.fail(new APIError("TOO_MANY_REQUESTS"));
    }
    const reset = yield* authCall(() =>
      ctx.context.adapter.incrementOne({
        model: "rateLimit",
        where: [
          { field: "key", value: key },
          { field: "lastRequest", operator: "lte", value: last },
        ],
        increment: {},
        set: { count: 1, lastRequest: now },
      }),
    );
    if (reset === null) return yield* Effect.fail(new APIError("TOO_MANY_REQUESTS"));
  });

interface DesktopSessionsOptions {
  readonly origin: string;
  readonly authenticate: (ctx: GenericEndpointContext) => Effect.Effect<
    {
      readonly userId: string;
      readonly resource: string;
      readonly grant: { readonly id: GrantId };
    },
    APIError
  >;
  readonly bindSession: (
    ctx: GenericEndpointContext,
    grant: GrantId,
    session: { readonly id: string; readonly expiresAt: Date },
  ) => Effect.Effect<void, APIError>;
}

export const desktopSessions = (options: DesktopSessionsOptions) =>
  ({
    id: "executor-desktop-sessions",
    endpoints: {
      createDesktopSessionLink: createAuthEndpoint(
        "/desktop/session-link",
        {
          method: "POST",
          requireHeaders: true,
          metadata: {
            openapi: {
              description: desktopSessionLinkDescription,
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        binding: { type: "string", pattern: "^[0-9a-f]{64}$" },
                        returnTo: { type: "string" },
                      },
                      required: ["binding"],
                    },
                  },
                },
              },
            },
          },
        },
        (ctx) =>
          runAuth(
            Effect.gen(function* () {
              ctx.setHeader("cache-control", "no-store");
              const grant = yield* options.authenticate(ctx);
              yield* allow(ctx, "session-link", grant.grant.id);
              const request = yield* parse(DesktopSessionLinkRequest, ctx.body);
              const returnTo = yield* returnPath(options.origin, request.returnTo);
              const code = hex(crypto.getRandomValues(new Uint8Array(32)));
              const hash = yield* digest(code);
              const now = yield* Clock.currentTimeMillis;
              const expiresAt = new Date(now + (yield* linkLifetime) * 1000);
              const value = yield* Schema.encodeEffect(LinkJson)({
                user: grant.userId,
                grant: grant.grant.id,
                returnTo,
                binding: request.binding,
              }).pipe(Effect.mapError(() => new APIError("INTERNAL_SERVER_ERROR")));
              yield* authCall(() =>
                ctx.context.internalAdapter.createVerificationValue({
                  identifier: identifier(hash),
                  value,
                  expiresAt,
                }),
              );
              const url = new URL(desktopSessionPath, options.origin);
              url.searchParams.set("code", code);
              return {
                url: url.href,
                expiresAt: expiresAt.toISOString(),
              };
            }),
          ),
      ),
      readDesktopAccount: createAuthEndpoint(
        "/desktop/account",
        {
          method: "GET",
          requireHeaders: true,
          metadata: { openapi: { description: desktopAccountDescription } },
        },
        (ctx) =>
          runAuth(
            Effect.gen(function* () {
              ctx.setHeader("cache-control", "no-store");
              const grant = yield* options.authenticate(ctx);
              yield* allow(ctx, "account", grant.grant.id);
              const [user, organization] = yield* Effect.all([
                authCall(() => ctx.context.internalAdapter.findUserById(grant.userId)).pipe(
                  Effect.flatMap((row) => parse(UserRow, row)),
                ),
                authCall(() =>
                  ctx.context.adapter.findOne({
                    model: "organization",
                    where: [{ field: "id", value: grant.resource }],
                  }),
                ).pipe(Effect.flatMap((row) => parse(OrganizationRow, row))),
              ]);
              return DesktopAccount.make({
                user: { id: user.id, email: user.email },
                organization: {
                  id: organization.id,
                  slug: organization.slug,
                  name: organization.name,
                },
              });
            }),
          ),
      ),
      openDesktopSession: createAuthEndpoint(
        "/desktop/session",
        {
          method: "GET",
          requireHeaders: true,
          metadata: { openapi: { description: desktopSessionDescription } },
        },
        async (ctx) => {
          ctx.setHeader("cache-control", "no-store");
          ctx.setHeader("referrer-policy", "no-referrer");
          const redeemed = await Effect.runPromise(
            redeem(ctx, options).pipe(
              Effect.tapError((error) =>
                Effect.logError("Could not redeem a desktop session link", error),
              ),
              Effect.result,
            ),
          );
          if (Result.isSuccess(redeemed)) throw ctx.redirect(redeemed.success);
          return new Response(unavailablePage, {
            status: 503,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
              "retry-after": "5",
            },
          });
        },
      ),
    },
    rateLimit: [{ pathMatcher: (path) => path === "/desktop/session", window: 60, max: 20 }],
  }) satisfies BetterAuthPlugin;
