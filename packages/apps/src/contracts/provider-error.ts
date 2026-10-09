import { Schema } from "effect";
import { FailurePhase, UpstreamError } from "./failure.ts";
import { AccountId } from "./schema.ts";

/**
 * A recognized service failure. App authors can throw this ordinary Error from
 * async code. Supply only a known reason and the account used for that request.
 * Never include response bodies, messages, URLs or credentials. A bare 403 is
 * `rejected`; `forbidden` requires explicit evidence of insufficient permission.
 *
 * The framework adds the phase the failure happened in, and `upstream`: the error code and
 * description the service stated in its documented error format, such as a Bearer challenge's
 * `error` and `error_description`. Account secrets in that text are replaced.
 */
export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  reason: Schema.Literals(["unauthorized", "forbidden", "rate_limited", "unavailable", "rejected"]),
  status: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
  accountId: Schema.optional(AccountId),
  phase: Schema.optional(FailurePhase),
  upstream: Schema.optional(UpstreamError),
}) {}
