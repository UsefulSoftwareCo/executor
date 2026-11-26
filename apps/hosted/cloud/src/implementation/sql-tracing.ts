import { Effect, Layer } from "effect";
import * as Statement from "effect/sql/Statement";

export const sqlTracing = Layer.mergeAll(
  Layer.succeed(Statement.SpanPropagationEnabled, true),
  Layer.succeed(Statement.CurrentTransformer, (statement, sql, _fiber, span) => {
    if (
      !span.sampled ||
      !/^[0-9a-f]{32}$/.test(span.traceId) ||
      !/^[0-9a-f]{16}$/.test(span.spanId)
    ) {
      return Effect.succeed(statement);
    }
    const comment = `\n/*traceparent='00-${span.traceId}-${span.spanId}-01'*/`;
    return Effect.succeed(sql`${statement}${sql.literal(comment)}`);
  }),
);
