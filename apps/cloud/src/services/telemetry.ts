// ---------------------------------------------------------------------------
// Effect → OTEL → Axiom bridge
// ---------------------------------------------------------------------------
//
// Both the fetch path and Durable Object path install a Worker-safe
// WebTracerProvider in their own isolate. We deliberately avoid global fetch
// instrumentation libraries here: they proxy Cloudflare-native functions and
// can break `this` binding inside Worker-only clients.
//
// We install a `WebTracerProvider` once per isolate as the global provider
// (lazy on first layer provide, not at module load — `env` from
// `cloudflare:workers` is reliably populated at request time but we keep the
// lazy gate as a defensive cheap no-op). Once installed, the provider lives for
// the entire isolate lifetime, so deferred MCP SDK callbacks — which fire after
// the request Effect has resolved — still hit a live `SimpleSpanProcessor` +
// exporter.
//
// Previously the WebSdk layer was scoped per-request: when the outer
// `Effect.runPromise(...)` resolved, the layer's scope closed and
// `processor.shutdown()` ran. Engine / runtime spans created from deferred SDK
// callbacks (which captured the old runtime + tracer) then silently failed to
// export, even though they showed up in `Effect.currentSpan` traces during
// execution.
// ---------------------------------------------------------------------------

// Subpath imports — the barrel `@effect/opentelemetry` re-exports `NodeSdk`,
// which eagerly imports `@opentelemetry/sdk-trace-node` and its
// `context-async-hooks` dep. Under vitest-pool-workers that crashes module
// load (no `async_hooks` in workerd). Production bundles tree-shake the
// unused NodeSdk; vitest does not.
import * as Resource from "@effect/opentelemetry/Resource";
import * as OtelTracer from "@effect/opentelemetry/Tracer";
import { trace } from "@opentelemetry/api";
// Force the browser platform entry — the package's conditional export would
// otherwise resolve to the Node build, which uses `https.request` / `node:http`.
// Under workerd + unenv's nodejs_compat, `https.request` isn't implemented
// (surfaces as `[unenv] https.request is not implemented yet!` at export
// time) and every DO span fails to ship. The browser build uses `fetch()`,
// which workerd does support.
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http/build/esm/platform/browser/index.js";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";

const SERVICE_NAME = "executor-cloud";
const SERVICE_VERSION = "1.0.0";

// Module-scope: one provider per isolate, never shut down. The provider holds
// the SimpleSpanProcessor + OTLP exporter, so any tracer reference captured by
// deferred work keeps finding a live exporter after the request Effect resolves.
let installed = false;
const ensureGlobalTracerProvider = (): boolean => {
  if (installed) return true;
  if (!env.AXIOM_TOKEN) return false;
  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
    }),
    spanProcessors: [
      new SimpleSpanProcessor(
        new OTLPTraceExporter({
          url: env.AXIOM_TRACES_URL ?? "https://api.axiom.co/v1/traces",
          headers: {
            Authorization: `Bearer ${env.AXIOM_TOKEN}`,
            "X-Axiom-Dataset": env.AXIOM_DATASET ?? "executor-cloud",
          },
        }),
      ),
    ],
  });
  // Skip `provider.register()` — its StackContextManager / W3C propagator
  // setup wires the global OTel context API, but Effect's tracer goes
  // through `OtelTracer.layerGlobal` which only needs the global provider,
  // not the OTel context machinery.
  trace.setGlobalTracerProvider(provider);
  installed = true;
  return true;
};

const makeTelemetryLive = (): Layer.Layer<never> =>
  Layer.unwrap(
    Effect.sync(() =>
      ensureGlobalTracerProvider()
        ? OtelTracer.layerGlobal.pipe(
            Layer.provide(
              Resource.layer({ serviceName: SERVICE_NAME, serviceVersion: SERVICE_VERSION }),
            ),
          )
        : Layer.empty,
    ),
  );

export const TelemetryLive: Layer.Layer<never> = makeTelemetryLive();

export const DoTelemetryLive: Layer.Layer<never> = makeTelemetryLive();
