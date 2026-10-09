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
export {
  collectTelemetry,
  forwardTelemetry,
  makeTelemetryForwarder,
  TelemetryBatch,
} from "./relay.ts";
export { TraceContext, currentTraceContext, externalTrace, traceLinks } from "./trace-context.ts";
export { pendingSpan } from "./pending-span.ts";
export {
  makeOwnershipAccounting,
  measuredSpan,
  owned,
  ownedBy,
  ownerAttribute,
  type Owner,
  type SpanMeasure,
} from "./ownership.ts";
export { recordWorkerMeasurements } from "./measurements.ts";
export {
  allowlistedSpans,
  httpSpanAttributeAllowlist,
  recordRoute,
  routeTemplates,
  spanAttributeAllowed,
} from "./span-attributes.ts";
