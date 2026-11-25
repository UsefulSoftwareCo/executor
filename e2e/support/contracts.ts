import { Schema } from "effect";

export const Organization = Schema.Struct({ id: Schema.String, slug: Schema.String });
export const LastOrganization = Schema.Struct({ user: Schema.String, organization: Schema.String });

export const Resource = Schema.Struct({ id: Schema.String });
export const App = Schema.Struct({ id: Schema.String, slug: Schema.String, name: Schema.String });
export const Inventory = Schema.Struct({
  apps: Schema.Array(App),
  links: Schema.Array(Schema.Struct({ app: Schema.String, account: Schema.String })),
  accounts: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
});
export const Collector = Schema.Struct({ state: Schema.Literal("running"), url: Schema.String });
export const SpanQuery = Schema.Struct({
  meta: Schema.optionalKey(
    Schema.Struct({
      truncated: Schema.Boolean,
      returned: Schema.optionalKey(Schema.Number),
      spanCount: Schema.optionalKey(Schema.Number),
    }),
  ),
  data: Schema.Array(
    Schema.Struct({
      traceId: Schema.String,
      span: Schema.Struct({
        spanId: Schema.String,
        parentSpanId: Schema.NullOr(Schema.String),
        operationName: Schema.String,
        serviceName: Schema.String,
        startTime: Schema.String,
        durationMs: Schema.Number,
        status: Schema.String,
        tags: Schema.Record(Schema.String, Schema.String),
        events: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            attributes: Schema.Record(Schema.String, Schema.String),
          }),
        ),
        statusMessage: Schema.optionalKey(Schema.String),
        links: Schema.optionalKey(
          Schema.Array(Schema.Struct({ traceId: Schema.String, spanId: Schema.String })),
        ),
      }),
    }),
  ),
});
