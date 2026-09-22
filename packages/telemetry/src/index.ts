/** Effect-native observability shared by Executor hosts and framework operations. */
export {
  CurrentTelemetryConfig,
  TelemetryConfig,
  TelemetryTarget,
  telemetryConfig,
} from "./config.ts";
export { telemetryLayer, telemetryFromConfig } from "./layer.ts";
export {
  captureTelemetry,
  traceHeaders,
  withRemoteSpan,
  invocationFetch,
  type InvocationTelemetry,
} from "./context.ts";
export { collectTelemetry, forwardTelemetry, TelemetryBatch } from "./relay.ts";
export { TraceContext, currentTraceContext, externalTrace, traceLinks } from "./trace-context.ts";
export { pendingSpan } from "./pending-span.ts";
export { recordWorkerMeasurements } from "./measurements.ts";
export {
  allowlistedSpans,
  httpSpanAttributeAllowlist,
  spanAttributeAllowed,
} from "./span-attributes.ts";
