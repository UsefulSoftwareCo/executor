import { Cause, Effect, Option, Schema } from "effect";
import {
  type HostContext,
  type HostError,
  HostOperationNotFound,
  HostInputInvalid,
  HostOutputInvalid,
  HostOperationFailed,
} from "../contracts/host.ts";
import { ResponseStatusError } from "../contracts/http.ts";
import { accountProviderError, httpProviderError, parseProviderError } from "./provider-error.ts";
import { accountSecrets, failureDetail, leavingProviderError } from "./failure-detail.ts";

/** The same errors and credential redaction apply to provider and app-owned checks. */
export function classifyAccountCheck(context: HostContext, accountId?: string) {
  return Effect.catchCause((cause): Effect.Effect<never, HostError> => {
    if (Cause.hasInterrupts(cause)) return Effect.interrupt;
    const error = Cause.squash(cause);
    if (
      Schema.is(HostOperationNotFound)(error) ||
      Schema.is(HostInputInvalid)(error) ||
      Schema.is(HostOutputInvalid)(error) ||
      Schema.is(HostOperationFailed)(error)
    )
      return Effect.fail(error);
    const status = Schema.decodeUnknownOption(ResponseStatusError)(error);
    const classified = Option.isSome(status)
      ? Option.fromNullishOr(httpProviderError(status.value.status))
      : parseProviderError(error);
    const secrets = accountSecrets(context.accounts);
    return Effect.fail(
      Option.isSome(classified)
        ? leavingProviderError(
            accountId === undefined
              ? classified.value
              : accountProviderError(classified.value, accountId),
            secrets,
          )
        : new HostOperationFailed(failureDetail(error, secrets)),
    );
  });
}
