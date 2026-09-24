import { Effect, Layer } from "effect";
import * as Statement from "effect/unstable/sql/Statement";

/** Join native SQL wire spans and server observations to the exact SQL statement. */
export const sqlTracing = Layer.mergeAll(
  Layer.succeed(Statement.SpanPropagationEnabled, true),
  Layer.succeed(Statement.CurrentTransformer, (statement, sql, _fiber, span) => {
    // Inbound trace context is external input. Only fixed-width hexadecimal IDs
    // may enter the SQL comment; parameters and application data never enter it.
    if (
      !span.sampled ||
      !/^[0-9a-f]{32}$/.test(span.traceId) ||
      !/^[0-9a-f]{16}$/.test(span.spanId)
    ) {
      return Effect.succeed(statement);
    }
    // pg_stat_activity truncates long statements. Keep correlation in its prefix.
    const comment = `/*traceparent='00-${span.traceId}-${span.spanId}-01'*/\n`;
    return Effect.succeed(sql`${sql.literal(comment)}${statement}`);
  }),
);
