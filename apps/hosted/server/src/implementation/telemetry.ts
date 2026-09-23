/** Write-only browser event ingestion, including sign-in failures. */
import { receiveBrowserTelemetry } from "@executor-js/telemetry/http";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Authentication } from "../contracts/auth.ts";

/** Accept only the configured product origin; exporter credentials stay in the host. */
const route = (signal: "traces" | "logs") =>
  HttpRouter.add(
    "POST",
    `/api/telemetry/${signal}`,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const auth = yield* Authentication;
      if (
        request.headers.origin !== new URL(auth.origin).origin ||
        request.headers["sec-fetch-site"] === "cross-site"
      ) {
        return HttpServerResponse.empty({ status: 403 });
      }
      return yield* receiveBrowserTelemetry(signal);
    }),
  );

/** Same-origin traces and logs share the private host exporters. */
export const browserTelemetry = Layer.mergeAll(route("traces"), route("logs"));
