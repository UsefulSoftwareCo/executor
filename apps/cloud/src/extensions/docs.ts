import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApiSwagger, OpenApi } from "effect/unstable/httpapi";

import { CloudAuthApi, CloudAuthPublicApi } from "../auth/api";
import { OrgApi } from "../org/api";

import { ProtectedCloudApi } from "../api/layers";

export const CloudOpenApi = ProtectedCloudApi.add(CloudAuthPublicApi).add(CloudAuthApi).add(OrgApi);

const spec = OpenApi.fromApi(CloudOpenApi);

export const CloudOpenApiJsonLive = HttpRouter.add(
  "GET",
  "/api/openapi.json",
  Effect.succeed(HttpServerResponse.jsonUnsafe(spec)),
);

export const CloudDocsLive = Layer.mergeAll(
  HttpApiSwagger.layer(CloudOpenApi, { path: "/api/docs" }),
  CloudOpenApiJsonLive,
);
