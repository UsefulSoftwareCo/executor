import { Schema } from "effect";

const milliseconds = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
export const CloudInvocation = Schema.Struct({
  scriptName: Schema.NullOr(Schema.String),
  scriptVersion: Schema.optional(Schema.Struct({ id: Schema.String })),
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

export const InvocationRpc = Schema.Struct({ rpcMethod: Schema.String });

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
