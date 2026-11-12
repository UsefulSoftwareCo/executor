/**
 * Parse only platform timing metadata. Request bodies, credentials and logs are discarded; the
 * request's URL and user agent are read only to classify the invocation, never recorded.
 */
import { Schema } from "effect";

const milliseconds = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
export const CloudInvocation = Schema.Struct({
  scriptName: Schema.NullOr(Schema.String),
  scriptVersion: Schema.optional(Schema.Struct({ id: Schema.String })),
  /** The exported class or entrypoint, such as a Durable Object class; absent for the default. */
  entrypoint: Schema.optional(Schema.NullOr(Schema.String)),
  executionModel: Schema.optional(Schema.NullOr(Schema.String)),
  eventTimestamp: Schema.NullOr(milliseconds),
  cpuTime: milliseconds,
  wallTime: milliseconds,
  outcome: Schema.String,
  event: Schema.Unknown,
  truncated: Schema.Boolean,
  logs: Schema.Array(Schema.Struct({ message: Schema.Array(Schema.Unknown) })),
  exceptions: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
});

/** Fixed bridge phases have no product data and remain distinct from platform CPU measurements. */
export const InvocationPhase = Schema.Struct({
  type: Schema.Literal("alchemy.phase"),
  name: Schema.Literals([
    "alchemy.runtime.initialize",
    "alchemy.runtime.wait",
    "alchemy.response",
    "alchemy.cleanup",
    "alchemy.do.initialize",
    "alchemy.do.wait",
    "alchemy.do.response",
  ]),
  durationMs: milliseconds,
});

/** A Worker or Durable Object RPC names only the called method. */
export const InvocationRpc = Schema.Struct({ rpcMethod: Schema.String });

/** HTTP is optional: scheduled and RPC invocations still contribute native timings. */
export const InvocationHttp = Schema.Struct({
  request: Schema.Struct({
    method: Schema.String,
    url: Schema.optional(Schema.String),
    headers: Schema.Struct({
      "cf-ray": Schema.optional(Schema.String),
      traceparent: Schema.optional(Schema.String),
      "user-agent": Schema.optional(Schema.String),
    }),
  }),
  response: Schema.optional(Schema.Struct({ status: Schema.Int })),
});
