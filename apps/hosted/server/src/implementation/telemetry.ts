import { receiveBrowserTelemetry } from "@executor-js/telemetry/http";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { SessionAuthentication } from "../contracts/auth.ts";

const route = (signal: "traces" | "logs") =>
  HttpRouter.add(
    "POST",
    `/api/telemetry/${signal}`,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const auth = yield* SessionAuthentication;
      if (
        request.headers.origin !== new URL(auth.origin).origin ||
        request.headers["sec-fetch-site"] === "cross-site"
      ) {
        return HttpServerResponse.empty({ status: 403 });
      }
      return yield* receiveBrowserTelemetry(signal);
    }),
  );

export const browserTelemetry = Layer.mergeAll(route("traces"), route("logs"));
