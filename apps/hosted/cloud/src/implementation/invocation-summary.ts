/** Native invocation totals include background cleanup; they are not response latency. */
import { Effect, Option, Schema } from "effect";
import { providerFailureCode } from "./provider-failure.ts";
import { invocationSurface } from "./invocation-surface.ts";
import {
  TraceContext,
  externalTrace,
  traceLinks,
  recordWorkerMeasurements,
} from "@executor-js/telemetry";
import {
  CloudInvocation,
  InvocationHttp,
  InvocationPhase,
  InvocationRpc,
} from "../contracts/invocation-telemetry.ts";
import type { CloudHosts } from "../infrastructure/stage.ts";

const phase = Schema.decodeUnknownOption(
  Schema.Union([InvocationPhase, Schema.fromJsonString(InvocationPhase)]),
);
const RequestContext = Schema.Struct({
  message: Schema.Literal("executor.request.context"),
  annotations: Schema.Struct({
    "executor.trace_id": TraceContext.fields.traceId,
    "executor.span_id": TraceContext.fields.spanId,
    "executor.trace_sampled": Schema.Boolean,
  }),
});
const requestContext = Schema.decodeUnknownOption(
  Schema.Union([RequestContext, Schema.fromJsonString(RequestContext)]),
);
const phaseAttribute = {
  "alchemy.runtime.initialize": "executor.initialize_ms",
  "alchemy.runtime.wait": "executor.runtime_wait_ms",
  "alchemy.response": "executor.response_ready_ms",
  "alchemy.cleanup": "executor.cleanup_ms",
  "alchemy.do.initialize": "executor.do_initialize_ms",
  "alchemy.do.wait": "executor.do_wait_ms",
  "alchemy.do.response": "executor.do_response_ready_ms",
};

/**
 * Produce an explicit, credential-free projection for one platform callback. `hosts`, the
 * deployment's host layout when it loaded, names the role of the host an HTTP invocation's request
 * was sent to.
 */
export const invocationSummary = (hosts: Option.Option<CloudHosts>, input: unknown) =>
  Schema.decodeUnknownEffect(CloudInvocation)(input).pipe(
    Effect.map((event) => {
      const attributes: Record<string, string | number | boolean> = {
        "cloudflare.cpu_time_ms": event.cpuTime,
        "cloudflare.wall_time_ms": event.wallTime,
        "cloudflare.outcome": event.outcome,
        "cloudflare.truncated": event.truncated,
      };
      if (event.exceptions !== undefined && event.exceptions.length > 0) {
        attributes["cloudflare.exception.count"] = event.exceptions.length;
        attributes["cloudflare.exception.codes"] = [
          ...new Set(
            event.exceptions.map(({ message }) => providerFailureCode(new Error(message))),
          ),
        ].join(",");
      }
      for (const log of event.logs)
        for (const message of log.message) {
          const request = requestContext(message);
          if (Option.isSome(request)) {
            Object.assign(attributes, request.value.annotations);
            attributes["executor.context_source"] = "server";
          }
          const timing = phase(message);
          if (Option.isSome(timing)) {
            attributes["executor.phase_clock"] = "cloudflare-io";
            attributes[phaseAttribute[timing.value.name]] = timing.value.durationMs;
            if (timing.value.name === "alchemy.runtime.initialize")
              attributes["executor.initialization_observed"] = true;
            // The object was constructed in this invocation, after it was evicted or hibernated.
            if (timing.value.name === "alchemy.do.initialize")
              attributes["executor.do_initialization_observed"] = true;
          }
        }
      if (event.eventTimestamp !== null)
        attributes["cloudflare.event.timestamp_ms"] = event.eventTimestamp;
      if (event.scriptName !== null) attributes["cloudflare.script_name"] = event.scriptName;
      if (event.scriptVersion !== undefined)
        attributes["cloudflare.script_version.id"] = event.scriptVersion.id;
      if (typeof event.entrypoint === "string")
        attributes["cloudflare.entrypoint"] = event.entrypoint;
      if (typeof event.executionModel === "string")
        attributes["cloudflare.execution_model"] = event.executionModel;
      const rpc = Schema.decodeUnknownOption(InvocationRpc)(event.event);
      if (Option.isSome(rpc)) attributes["cloudflare.rpc.method"] = rpc.value.rpcMethod;
      const http = Schema.decodeUnknownOption(InvocationHttp)(event.event);
      if (Option.isSome(http)) {
        attributes["http.request.method"] = http.value.request.method;
        Object.assign(
          attributes,
          invocationSurface(hosts, {
            url: http.value.request.url,
            userAgent: http.value.request.headers["user-agent"],
          }),
        );
        if (http.value.response !== undefined)
          attributes["http.response.status_code"] = http.value.response.status;
        const ray = http.value.request.headers["cf-ray"];
        if (ray !== undefined && /^[a-f0-9]{16,32}(?:-[A-Z]{3})?$/i.test(ray))
          attributes["cloudflare.ray_id"] = ray.replace(/-[A-Z]{3}$/i, "");
        const trace = http.value.request.headers.traceparent?.match(
          /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/,
        );
        const incoming = externalTrace({
          traceId: trace?.[1],
          spanId: trace?.[2],
          sampled: trace?.[3] !== undefined && (Number.parseInt(trace[3], 16) & 1) === 1,
        });
        if (attributes["executor.trace_id"] === undefined && Option.isSome(incoming)) {
          attributes["executor.trace_id"] = incoming.value.traceId;
          attributes["executor.span_id"] = incoming.value.spanId;
          attributes["executor.trace_sampled"] = incoming.value.sampled;
          attributes["executor.context_source"] = "incoming-parent";
        }
      }
      return attributes;
    }),
  );

/** Keep valid events if a future platform payload fails to decode; never log that raw payload. */
export const recordInvocations = (
  hosts: Option.Option<CloudHosts>,
  events: ReadonlyArray<unknown>,
) =>
  Effect.forEach(
    events,
    (event) =>
      Schema.decodeUnknownEffect(CloudInvocation)(event).pipe(
        Effect.tap((event) =>
          recordWorkerMeasurements(
            event.scriptName ?? "unknown",
            event.outcome,
            event.cpuTime,
            event.wallTime,
          ),
        ),
        Effect.flatMap((event) => invocationSummary(hosts, event)),
        Effect.flatMap((attributes) =>
          Effect.logInfo("cloudflare.invocation").pipe(
            Effect.annotateLogs(attributes),
            Effect.withSpan("cloudflare.invocation", {
              root: true,
              attributes: { ...attributes, "executor.measurement.kind": "native-invocation" },
              links: traceLinks(
                {
                  traceId: attributes["executor.trace_id"],
                  spanId: attributes["executor.span_id"],
                  sampled: attributes["executor.trace_sampled"],
                },
                "native-invocation",
              ),
            }),
          ),
        ),
        Effect.catchTag("SchemaError", () =>
          Effect.logError("Invalid Cloudflare invocation timing record"),
        ),
      ),
    { discard: true },
  );
