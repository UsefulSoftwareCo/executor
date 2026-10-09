import { Option, Schema } from "effect";
import type { FailurePhase, UpstreamError } from "../contracts/failure.ts";
import { ProviderError } from "../contracts/provider-error.ts";
import { AccountId } from "../contracts/schema.ts";
import { challengeUpstreamError } from "./upstream-error.ts";

/** A provider failure's fields, each optional one possibly absent. */
interface ProviderErrorFields {
  readonly reason: ProviderError["reason"];
  readonly status?: number | undefined;
  readonly accountId?: AccountId | undefined;
  readonly phase?: FailurePhase | undefined;
  readonly upstream?: UpstreamError | undefined;
}

/**
 * Construct a provider failure without keys for absent fields. Failures inside a catalog cross the
 * boundary as JSON values, which have no `undefined`.
 */
export const providerError = ({
  reason,
  status,
  accountId,
  phase,
  upstream,
}: ProviderErrorFields) =>
  new ProviderError({
    reason,
    ...(status === undefined ? {} : { status }),
    ...(accountId === undefined ? {} : { accountId }),
    ...(phase === undefined ? {} : { phase }),
    ...(upstream === undefined ? {} : { upstream }),
  });

/** Parse and rebuild the allowlisted fields, including when the input is already an Error instance. */
export function parseProviderError(error: unknown): Option.Option<ProviderError> {
  return Schema.decodeUnknownOption(ProviderError)(error).pipe(Option.map(providerError));
}

/**
 * The same failure with detail its raiser could not know: the phase it happened in, and the
 * error the service stated. Detail the failure already carries is kept.
 */
export function providerErrorDetail(
  error: ProviderError,
  detail: { readonly phase?: FailurePhase; readonly upstream?: UpstreamError | undefined },
) {
  return providerError({
    ...error,
    phase: error.phase ?? detail.phase,
    upstream: error.upstream ?? detail.upstream,
  });
}

/**
 * Classify only explicit HTTP evidence. Raw provider content never enters the error; a Bearer
 * challenge's documented error code and description do.
 */
export function httpProviderError(
  status: number,
  headers: Readonly<Record<string, string>> = {},
): ProviderError | undefined {
  const upstream = challengeUpstreamError(headers["www-authenticate"]);
  if (status >= 500 && status <= 599)
    return providerError({ reason: "unavailable", status, upstream });
  if (status === 401) return providerError({ reason: "unauthorized", status, upstream });
  if (status === 429) return providerError({ reason: "rate_limited", status, upstream });
  if (status !== 403) return undefined;
  const retry = headers["retry-after"];
  if (
    headers["x-ratelimit-remaining"] === "0" ||
    (retry !== undefined && (/^\d+$/.test(retry) || Number.isFinite(Date.parse(retry))))
  )
    return providerError({ reason: "rate_limited", status, upstream });
  if (typeof upstream?.code === "string" && upstream.code.toLowerCase() === "insufficient_scope")
    return providerError({ reason: "forbidden", status, upstream });
  return providerError({ reason: "rejected", status, upstream });
}

/** Attach the account used by the enclosing operation, without preserving arbitrary thrown fields. */
export function accountProviderError<E>(error: E, accountId: string): E | ProviderError {
  const parsed = parseProviderError(error);
  const account = Schema.decodeUnknownOption(AccountId)(accountId);
  if (Option.isNone(parsed) || Option.isNone(account)) return error;
  return providerError({ ...parsed.value, accountId: account.value });
}

/** GraphQL has no standard auth code; recognize these documented codes without guessing from prose. */
export function graphqlProviderError(errors: readonly unknown[], status: number) {
  const codes = errors.flatMap((error) => {
    const parsed = Schema.decodeUnknownOption(
      Schema.Struct({
        type: Schema.optional(Schema.String),
        extensions: Schema.optional(Schema.Struct({ code: Schema.optional(Schema.String) })),
      }),
    )(error);
    return Option.isSome(parsed) ? [parsed.value.type, parsed.value.extensions?.code] : [];
  });
  if (codes.includes("RATE_LIMITED") || codes.includes("TOO_MANY_REQUESTS"))
    return new ProviderError({ reason: "rate_limited", status });
  if (codes.includes("UNAUTHENTICATED"))
    return new ProviderError({ reason: "unauthorized", status });
  if (codes.includes("FORBIDDEN")) return new ProviderError({ reason: "forbidden", status });
  return undefined;
}
