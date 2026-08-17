// ---------------------------------------------------------------------------
// Span header redaction for fibers composed under the cloud telemetry layers
// (the Effect HTTP server tracer and any request-scoped client use). The
// allowlist itself lives beside the hosted HTTP client in
// `@executor-js/sdk/host-internal`, which also binds it directly to that
// client: consumers capture the client value at construction, so a context
// layer alone cannot reach their request fibers. This layer is the
// server-side/defense-in-depth half of the same decision; see
// hosted-http-client.ts for the rationale and the allowlist.
// ---------------------------------------------------------------------------

import { Layer } from "effect";
import { Headers } from "effect/unstable/http";
import { spanRedactedHeaderNames } from "@executor-js/sdk/host-internal";

export const SpanHeaderRedactionLive: Layer.Layer<never> = Layer.succeed(
  Headers.CurrentRedactedNames,
  spanRedactedHeaderNames,
);
