import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApiSwagger, OpenApi } from "effect/unstable/httpapi";

import { CloudAuthApi, CloudAuthPublicApi } from "../auth/api";
import { OrgApi } from "../org/api";

import { ProtectedCloudApi } from "./protected-layers";

export const CloudOpenApi = ProtectedCloudApi.add(CloudAuthPublicApi).add(CloudAuthApi).add(OrgApi);

const spec = OpenApi.fromApi(CloudOpenApi);

export const CloudOpenApiJsonLive = HttpRouter.add(
  "GET",
  "/openapi.json",
  Effect.succeed(HttpServerResponse.jsonUnsafe(spec)),
);

export const CloudDocsLive = Layer.mergeAll(
  HttpApiSwagger.layer(CloudOpenApi, { path: "/docs" }),
  CloudOpenApiJsonLive,
);
