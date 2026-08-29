// ---------------------------------------------------------------------------
// OAuth callback × telemetry — the authorization code must never be exported.
//
// `/api/oauth/callback` is an app-owned path, so Effect's
// `HttpMiddleware.tracer` opens its `http.server` span and stamps `url.full`
// and `url.query` unconditionally (`effect/unstable/http/HttpMiddleware.ts`).
// It redacts URL userinfo and configured header names — nothing else — so the
// provider's `?code=…&state=…` reached the trace backend on every connect.
//
// This drives a real callback request through the real core API web handler,
// with the real Effect→OTel tracer bridge exporting into an in-memory
// exporter behind the production span-processor chain, and asserts that no
// exported span attribute contains the code or the state.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import * as Resource from "@effect/opentelemetry/Resource";
import * as OtelTracer from "@effect/opentelemetry/Tracer";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { ExecutorApi, observabilityMiddleware } from "@executor-js/api";
import { CoreHandlers, ExecutionEngineService, ExecutorService } from "@executor-js/api/server";
import { createExecutor } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";

import { UrlRedactingSpanProcessor } from "./redact-span-urls";

// Synthetic placeholders — never a real authorization code or CSRF state.
const CODE = "synthetic-authorization-code-9f2c";
const STATE = "synthetic-csrf-state-4b7e";

const makeTracing = () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    // The same wrapper order production installs in `telemetry.ts`: the
    // redactor sits outermost, so nothing downstream ever sees the secret.
    spanProcessors: [new UrlRedactingSpanProcessor(new SimpleSpanProcessor(exporter))],
  });
  const tracerLayer = OtelTracer.layer.pipe(
    Layer.provide(Layer.succeed(OtelTracer.OtelTracerProvider)(provider)),
    Layer.provide(Resource.layer({ serviceName: "executor-cloud-test" })),
  );
  return { exporter, provider, tracerLayer };
};

describe("oauth callback telemetry", () => {
  it.effect("exports no span attribute containing the authorization code or state", () =>
    Effect.gen(function* () {
      const { exporter, provider, tracerLayer } = makeTracing();
      const executor = yield* createExecutor(makeTestConfig({}));

      const web = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(ExecutorApi).pipe(
              Layer.provide(CoreHandlers),
              Layer.provide(observabilityMiddleware(ExecutorApi)),
              Layer.provide(Layer.succeed(ExecutorService)(executor)),
              Layer.provide(
                Layer.succeed(ExecutionEngineService)({} as ExecutionEngineService["Service"]),
              ),
              Layer.provideMerge(HttpServer.layerServices),
              Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
              // The Effect→OTel bridge: HttpMiddleware.tracer's span is created
              // by this tracer, so it lands in the exporter below.
              Layer.provideMerge(tracerLayer),
            ),
            { disableLogger: true },
          ),
        ),
        (handle) => Effect.promise(() => handle.dispose()),
      );

      const context = Context.make(ExecutorService, executor).pipe(
        Context.add(ExecutionEngineService, {} as ExecutionEngineService["Service"]),
      );

      // The provider round-trip: a real callback carries the grant and the
      // CSRF state in the query string.
      yield* Effect.promise(() =>
        web.handler(
          new Request(
            `http://app.test/oauth/callback?code=${CODE}&state=${STATE}&domain=example.test`,
          ),
          context,
        ),
      );

      yield* Effect.promise(() => provider.forceFlush());
      const spans: readonly ReadableSpan[] = exporter.getFinishedSpans();

      // The middleware must actually have opened a server span — otherwise
      // this test would pass vacuously.
      const serverSpan = spans.find((span) => span.name.startsWith("http.server"));
      expect(serverSpan).toBeDefined();

      const serialized = JSON.stringify(spans.map((span) => span.attributes));
      expect(serialized).not.toContain(CODE);
      expect(serialized).not.toContain(STATE);

      // Route-level visibility survives the scrub.
      expect(serverSpan?.attributes["url.path"]).toBe("/oauth/callback");
      expect(String(serverSpan?.attributes["url.full"] ?? "")).toContain("/oauth/callback");
    }),
  );
});
