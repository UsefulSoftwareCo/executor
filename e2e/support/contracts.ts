import { Schema } from "effect";

/** Wire projections owned by the tests; no server or SDK implementation imports. */
export const Organization = Schema.Struct({ id: Schema.String, slug: Schema.String });
/** The saved last-organization memory; navigation only, never authority. */
export const LastOrganization = Schema.Struct({ user: Schema.String, organization: Schema.String });

export const Resource = Schema.Struct({ id: Schema.String });
export const App = Schema.Struct({ id: Schema.String, slug: Schema.String, name: Schema.String });
export const Inventory = Schema.Struct({
  apps: Schema.Array(App),
  /** The caller's linked accounts by app. Local derives them from the apps' requirements. */
  links: Schema.Array(Schema.Struct({ app: Schema.String, account: Schema.String })),
  accounts: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
});
export const Collector = Schema.Struct({ state: Schema.Literal("running"), url: Schema.String });
/**
 * The collector's span query projection (Motel's shapes). Tests assert only delivered telemetry. It
 * keeps every delivered field that can carry text, including exception events with their messages
 * and stacks, so a privacy check over the whole projection also covers error messages.
 */
export const SpanQuery = Schema.Struct({
  /**
   * The list's own facts. On a trace's spans, `truncated` with `returned` and `spanCount` says the
   * trace was answered in part: its earliest `returned` of `spanCount` spans (the collector's
   * README, "Fields and markers beyond Motel's answers"). On a search, `truncated` says more spans
   * matched than the limit returned. Axiom's adapter sends none.
   */
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
        /** ISO 8601 start time. */
        startTime: Schema.String,
        durationMs: Schema.Number,
        status: Schema.String,
        tags: Schema.Record(Schema.String, Schema.String),
        /** Span events. Effect records a failure as an `exception` event with its message. */
        events: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            attributes: Schema.Record(Schema.String, Schema.String),
          }),
        ),
        // The collector keeps only the status code; Axiom also delivers the status message.
        statusMessage: Schema.optionalKey(Schema.String),
        // The collector omits links; Axiom's adapter must supply the delivered array.
        links: Schema.optionalKey(
          Schema.Array(Schema.Struct({ traceId: Schema.String, spanId: Schema.String })),
        ),
      }),
    }),
  ),
});
