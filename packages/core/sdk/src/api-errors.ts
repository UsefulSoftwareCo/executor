// ---------------------------------------------------------------------------
// Wire-level HTTP errors. Lives in the SDK so plugin `HttpApiGroup`
// definitions (which sit on the SDK side of the dependency graph and
// must stay publishable) can declare them without dragging in the
// server-only `@executor-js/api` package. The HTTP edge in
// `@executor-js/api` re-exports these and pairs them with the
// translation/capture helpers used by handlers.
// ---------------------------------------------------------------------------

import { Schema } from "effect";

/** Public 500 surface. Opaque by schema: correlation plus an optional safe
 * retry signal are the only details that cross the wire. */
export class InternalError extends Schema.TaggedErrorClass<InternalError>()(
  "InternalError",
  {
    /** Opaque correlation id for backend lookup (Sentry event id, log line, etc.). */
    traceId: Schema.String,
    /** Present only when repeating the same user action can complete safely. */
    retryable: Schema.optional(Schema.Literal(true)),
  },
  { httpApiStatus: 500 },
) {}
