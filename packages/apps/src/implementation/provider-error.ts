import { Option, Schema } from "effect";
import { ProviderError } from "../contracts/provider-error.ts";
import { AccountId } from "../contracts/schema.ts";

/** Parse and rebuild the allowlisted fields, including when the input is already an Error instance. */
export function parseProviderError(error: unknown): Option.Option<ProviderError> {
  return Schema.decodeUnknownOption(ProviderError)(error).pipe(
    Option.map(({ reason, status, accountId }) => new ProviderError({ reason, status, accountId })),
  );
}

/** Classify only explicit HTTP evidence. Raw provider content never enters the error. */
export function httpProviderError(
  status: number,
  headers: Readonly<Record<string, string>> = {},
): ProviderError | undefined {
  if (status >= 500 && status <= 599) return new ProviderError({ reason: "unavailable", status });
  if (status === 401) return new ProviderError({ reason: "unauthorized", status });
  if (status === 429) return new ProviderError({ reason: "rate_limited", status });
  if (status !== 403) return undefined;
  const retry = headers["retry-after"];
  if (
    headers["x-ratelimit-remaining"] === "0" ||
    (retry !== undefined && (/^\d+$/.test(retry) || Number.isFinite(Date.parse(retry))))
  )
    return new ProviderError({ reason: "rate_limited", status });
  if (/\bBearer\b.*\berror="insufficient_scope"/i.test(headers["www-authenticate"] ?? ""))
    return new ProviderError({ reason: "forbidden", status });
  return new ProviderError({ reason: "rejected", status });
}

/** Attach the account used by the enclosing operation, without preserving arbitrary thrown fields. */
export function accountProviderError<E>(error: E, accountId: string): E | ProviderError {
  const parsed = parseProviderError(error);
  const account = Schema.decodeUnknownOption(AccountId)(accountId);
  if (Option.isNone(parsed) || Option.isNone(account)) return error;
  return new ProviderError({
    reason: parsed.value.reason,
    status: parsed.value.status,
    accountId: account.value,
  });
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
