import { Schema } from "effect";

/** Wire projections owned by the tests; no server or SDK implementation imports. */
export const Organization = Schema.Struct({ id: Schema.String, slug: Schema.String });
/** Browser display and navigation metadata; no credential or permission fields are allowed. */
export const SessionHint = Schema.Struct({
  session: Schema.Struct({
    user: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      email: Schema.String,
      image: Schema.NullOr(Schema.String),
    }),
  }),
  expiresAt: Schema.Number,
  lastOrganization: Schema.optionalKey(Schema.NonEmptyString),
});
export const Resource = Schema.Struct({ id: Schema.String });
export const App = Schema.Struct({ id: Schema.String, slug: Schema.String, name: Schema.String });
export const Inventory = Schema.Struct({
  apps: Schema.Array(App),
  accounts: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
});
export const Collector = Schema.Struct({ state: Schema.Literal("running"), url: Schema.String });
/** Motel's exported span query projection. Tests assert only delivered telemetry. */
export const SpanQuery = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      traceId: Schema.String,
      span: Schema.Struct({
        spanId: Schema.String,
        parentSpanId: Schema.NullOr(Schema.String),
        operationName: Schema.String,
        serviceName: Schema.String,
        durationMs: Schema.Number,
        status: Schema.String,
        tags: Schema.Record(Schema.String, Schema.String),
        // Motel omits links; Axiom's adapter must supply the delivered array.
        links: Schema.optionalKey(
          Schema.Array(Schema.Struct({ traceId: Schema.String, spanId: Schema.String })),
        ),
      }),
    }),
  ),
});
