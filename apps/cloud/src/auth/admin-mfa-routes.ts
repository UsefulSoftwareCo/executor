import { env } from "cloudflare:workers";
import { Clock, Data, Duration, Effect, Layer, Option, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { WorkOSClient } from "./workos";
import { ORG_SELECTOR_HEADER, authorizeOrganizationSelector } from "./organization";
import {
  ADMIN_MFA_COOKIE,
  ADMIN_MFA_CHALLENGE_COOKIE,
  ADMIN_MFA_TTL_SECONDS,
  readAdminMfaProof,
  signAdminMfaProof,
} from "./admin-mfa-proof";

const codeBody = Schema.Struct({ code: Schema.String.check(Schema.isPattern(/^\d{6}$/)) });
const parseCodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(codeBody));
class RateLimitError extends Data.TaggedError("AdminMfaRateLimitError")<{
  readonly cause: unknown;
}> {}
class CodeBodyTooLarge extends Data.TaggedError("CodeBodyTooLarge") {}
const cookieOptions = {
  path: "/",
  httpOnly: true,
  secure: true,
  sameSite: "strict" as const,
  maxAge: Duration.seconds(ADMIN_MFA_TTL_SECONDS),
};
const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });

const handler = (action: "status" | "start" | "verify" | "cancel" | "lock") =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const webRequest = yield* HttpServerRequest.toWeb(request);
    if (action !== "status" && request.headers.origin !== new URL(webRequest.url).origin) {
      return json({ message: "This request must come from Executor." }, 403);
    }
    const workos = yield* WorkOSClient;
    const session = yield* workos.authenticateRequest(webRequest);
    if (!session) return json({ message: "Sign in to continue." }, 401);
    const response = yield* Effect.gen(function* () {
      const selector = request.headers[ORG_SELECTOR_HEADER];
      const org = selector ? yield* authorizeOrganizationSelector(session.userId, selector) : null;
      if (!org) return json({ message: "Select an organization to continue." }, 403);
      if (action === "status") {
        return json(
          org.memberRole !== "admin"
            ? { state: "member" }
            : session.adminVerified
              ? { state: "verified", expiresAt: session.adminVerificationExpiresAt }
              : { state: "required" },
        );
      }
      if (org.memberRole !== "admin") return json({ message: "Admin access is required." }, 403);

      if (action === "lock") {
        return json({ canceled: true }).pipe(
          HttpServerResponse.setCookieUnsafe(ADMIN_MFA_COOKIE, "", {
            ...cookieOptions,
            maxAge: Duration.seconds(0),
          }),
          HttpServerResponse.setCookieUnsafe(ADMIN_MFA_CHALLENGE_COOKIE, "", {
            ...cookieOptions,
            maxAge: Duration.seconds(0),
          }),
        );
      }
      if (action === "cancel") {
        return HttpServerResponse.setCookieUnsafe(
          json({ canceled: true }),
          ADMIN_MFA_CHALLENGE_COOKIE,
          "",
          {
            ...cookieOptions,
            maxAge: Duration.seconds(0),
          },
        );
      }

      // Applies across new challenges too, so starting over cannot reset the attempt budget.
      const rateLimit = env.ADMIN_MFA_RATE_LIMITER;
      if (!rateLimit) return json({ message: "Verification is temporarily unavailable." }, 503);
      const allowed = yield* Effect.tryPromise({
        try: () => rateLimit.limit({ key: session.userId }),
        catch: (cause) => new RateLimitError({ cause }),
      });
      if (!allowed.success) return json({ message: "Wait a minute, then try again." }, 429);

      const now = yield* Clock.currentTimeMillis;
      const identity = { userId: session.userId, sessionId: session.sessionId };
      const factors = yield* workos.listMfaFactors(session.userId);
      if (action === "start") {
        const existing = factors[0];
        const started = existing
          ? {
              kind: "challenge" as const,
              factor: existing,
              challenge: yield* workos.challengeMfa(existing.id),
            }
          : yield* workos.enrollMfa(session.userId, session.email).pipe(
              Effect.map((result) => ({
                kind: "enroll" as const,
                factor: result.authenticationFactor,
                challenge: result.authenticationChallenge,
              })),
            );
        const token = yield* signAdminMfaProof(
          env.WORKOS_COOKIE_PASSWORD,
          identity,
          "challenge",
          {
            mode: started.kind,
            factorId: started.factor.id,
            challengeId: started.challenge.id,
            exp: Math.floor(now / 1000) + 5 * 60,
          },
          now,
        );
        const response =
          started.kind === "enroll"
            ? json({
                kind: "enroll",
                secret: started.factor.totp.secret,
                qrCode: started.factor.totp.qrCode,
              })
            : json({ kind: "challenge" });
        return HttpServerResponse.setCookieUnsafe(response, ADMIN_MFA_CHALLENGE_COOKIE, token, {
          ...cookieOptions,
          maxAge: Duration.minutes(5),
        });
      }

      const pending = yield* readAdminMfaProof(
        env.WORKOS_COOKIE_PASSWORD,
        identity,
        "challenge",
        request.cookies[ADMIN_MFA_CHALLENGE_COOKIE],
        now,
      );
      // AuthKit lists only verified factors. An enrollment may proceed only while
      // none is active; a stale setup must not add a factor after another setup won.
      if (
        !pending ||
        (pending.mode === "enroll"
          ? factors.length !== 0
          : !factors.some(
              (factor) => factor.id === pending.factorId && factor.userId === session.userId,
            ))
      ) {
        return json({ message: "Start verification again." }, 400);
      }
      const text = yield* request.stream.pipe(
        Stream.runFoldEffect(
          () => new Uint8Array(0),
          (body, chunk) => {
            if (body.length + chunk.length > 256) return Effect.fail(new CodeBodyTooLarge());
            const next = new Uint8Array(body.length + chunk.length);
            next.set(body);
            next.set(chunk, body.length);
            return Effect.succeed(next);
          },
        ),
        Effect.map((body) => new TextDecoder().decode(body)),
        Effect.catch(() => Effect.succeed("")),
      );
      const body = Option.getOrNull(parseCodeBody(text));
      if (!body) return json({ message: "Enter the six-digit code." }, 400);
      const result = yield* workos
        .verifyMfa(pending.challengeId, body.code)
        .pipe(
          Effect.catchTag("WorkOSError", (error) =>
            error.status === 400 || error.status === 422
              ? Effect.succeed(null)
              : Effect.fail(error),
          ),
        );
      if (
        !result ||
        !result.valid ||
        result.challenge.authenticationFactorId !== pending.factorId
      ) {
        return json(
          { message: "That code did not work. Try the current code from your authenticator." },
          400,
        );
      }
      const active = yield* workos.listMfaFactors(session.userId);
      if (
        !active.some((factor) => factor.id === pending.factorId && factor.userId === session.userId)
      ) {
        return json({ message: "Start verification again." }, 400);
      }
      const token = yield* signAdminMfaProof(
        env.WORKOS_COOKIE_PASSWORD,
        identity,
        "verified",
        {
          ...pending,
          exp: Math.floor(now / 1000) + ADMIN_MFA_TTL_SECONDS,
        },
        now,
      );
      return json({ verified: true }).pipe(
        // OAuth providers return by top-level GET. Carry the verification proof
        // on that callback so an authorized Workspace connection can finish.
        HttpServerResponse.setCookieUnsafe(ADMIN_MFA_COOKIE, token, {
          ...cookieOptions,
          sameSite: "lax",
        }),
        HttpServerResponse.setCookieUnsafe(ADMIN_MFA_CHALLENGE_COOKIE, "", {
          ...cookieOptions,
          maxAge: Duration.seconds(0),
        }),
      );
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          json({ message: "Verification is temporarily unavailable. Try again." }, 503),
        ),
      ),
    );
    // Refresh tokens rotate once. Persist the new sealed session even when
    // verification is refused, so the next request can still authenticate.
    return session.refreshedSession
      ? HttpServerResponse.setCookieUnsafe(response, "wos-session", session.refreshedSession, {
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          maxAge: Duration.days(7),
        })
      : response;
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(json({ message: "Verification is temporarily unavailable. Try again." }, 503)),
    ),
  );

/** Session-bound TOTP verification routes. Mount with the normal request-scoped directory. */
export const AdminMfaRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/api/auth/admin-mfa", handler("status")),
  HttpRouter.add("POST", "/api/auth/admin-mfa/start", handler("start")),
  HttpRouter.add("POST", "/api/auth/admin-mfa/verify", handler("verify")),
  HttpRouter.add("POST", "/api/auth/admin-mfa/cancel", handler("cancel")),
  HttpRouter.add("POST", "/api/auth/admin-mfa/lock", handler("lock")),
);
