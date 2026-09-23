import { hostedHandlers } from "@executor-js/hosted-server";
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import type { HostedApiDocument } from "@executor-js/hosted-server/contracts";
import { ExecutorSelfHostApi } from "../contracts/api.ts";

/** Register this host's complete API and one OpenAPI document. */
export const selfHostApi = (document: HostedApiDocument) =>
  Layer.mergeAll(
    HttpApiBuilder.layer(ExecutorSelfHostApi),
    HttpRouter.add("GET", "/openapi.json", Effect.succeed(HttpServerResponse.jsonUnsafe(document))),
  ).pipe(Layer.provide(hostedHandlers));
