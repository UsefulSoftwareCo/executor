// ---------------------------------------------------------------------------
// MCP bearer JWT verify/classify (formerly mcp-auth.ts).
//
// Kept as its own `cloudflare:workers`-free leaf: the node-pool test
// (mcp-auth.node.test.ts) imports these verifiers at runtime, and
// `mcp/auth.ts` (which DOES read `cloudflare:workers` env) imports this leaf;
// the dependency points one way only.
// ---------------------------------------------------------------------------

import { Data, Effect, Result, Schema } from "effect";
import { jwtVerify, type JWTVerifyGetKey } from "jose";
import { JWKSInvalid, JWKSTimeout, JWTExpired } from "jose/errors";

export type VerifiedToken = {
  /** The WorkOS account ID (user ID). */
  accountId: string;
  /** The WorkOS organization ID, if the session has org context. */
  organizationId: string | null;
};

export class McpJwtVerificationError extends Data.TaggedError("McpJwtVerificationError")<{
  readonly cause: unknown;
  readonly reason: "expired" | "invalid" | "system";
}> {}

const JoseErrorCode = Schema.Struct({ code: Schema.String });
const isJoseErrorCodeShape = Schema.is(JoseErrorCode);

const getJoseErrorCode = (cause: unknown): string | null =>
  isJoseErrorCodeShape(cause) ? cause.code : null;

const isJoseErrorCode = (code: string): boolean => code.startsWith("ERR_J");

const classifyJwtVerificationError = (cause: unknown): McpJwtVerificationError =>
  new McpJwtVerificationError({
    cause,
    reason: (() => {
      const code = getJoseErrorCode(cause);
      if (code === JWTExpired.code) return "expired";
      if (
        code === JWKSTimeout.code ||
        code === JWKSInvalid.code ||
        code === null ||
        !isJoseErrorCode(code)
      ) {
        return "system";
      }
      return "invalid";
    })(),
  });

const isExpectedJwtVerificationError = (error: McpJwtVerificationError): boolean =>
  error.reason === "expired" || error.reason === "invalid";

const withJwtVerificationSpan = <A>(
  effect: Effect.Effect<A, McpJwtVerificationError>,
): Effect.Effect<A, McpJwtVerificationError> =>
  effect.pipe(
    Effect.result,
    Effect.flatMap((outcome) =>
      Effect.gen(function* () {
        if (Result.isSuccess(outcome)) {
          yield* Effect.annotateCurrentSpan({ "mcp.auth.jwt_verify.outcome": "verified" });
          return outcome;
        }

        yield* Effect.annotateCurrentSpan({
          "mcp.auth.jwt_verify.outcome": outcome.failure.reason,
        });

        return isExpectedJwtVerificationError(outcome.failure)
          ? outcome
          : yield* Effect.fail(outcome.failure);
      }),
    ),
    Effect.withSpan("mcp.auth.jwt_verify"),
    Effect.flatMap((outcome) =>
      Result.isSuccess(outcome) ? Effect.succeed(outcome.success) : Effect.fail(outcome.failure),
    ),
  );

export const verifyMcpAccessToken = (
  token: string,
  jwks: JWTVerifyGetKey,
  options: {
    readonly issuer: string;
    readonly audience: string;
  },
) =>
  Effect.gen(function* () {
    const { payload } = yield* Effect.tryPromise({
      try: () =>
        jwtVerify(token, jwks, {
          issuer: options.issuer,
          audience: options.audience,
        }),
      catch: classifyJwtVerificationError,
    }).pipe(withJwtVerificationSpan);

    if (!payload.sub) return null;

    return {
      accountId: payload.sub,
      organizationId: (payload.org_id as string | undefined) ?? null,
    } satisfies VerifiedToken;
  });

export const verifyWorkOSMcpAccessToken = (
  token: string,
  jwks: JWTVerifyGetKey,
  options: {
    readonly issuer: string;
    readonly audience: string;
  },
) =>
  Effect.gen(function* () {
    const verified = yield* verifyMcpAccessToken(token, jwks, {
      issuer: options.issuer,
      audience: options.audience,
    });
    yield* Effect.annotateCurrentSpan({
      "mcp.auth.audience_mode": "workos_client",
    });
    return verified;
  });
