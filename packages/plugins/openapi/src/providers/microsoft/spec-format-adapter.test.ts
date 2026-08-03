import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { structuralSplit } from "@executor-js/plugin-openapi";

import { microsoftGraphAdapter } from "./spec-format-adapter";
import { MICROSOFT_GRAPH_OPENAPI_URL } from "./presets";

const graphFixture = `
openapi: 3.0.4
info:
  title: Microsoft Graph Fixture
  version: v1.0
servers:
  - url: https://graph.microsoft.com/v1.0
paths:
  /me:
    get:
      operationId: me.GetUser
      security:
        - azureAdDelegated:
            - User.Read
      responses:
        "200":
          description: OK
  /irrelevant:
    get:
      operationId: irrelevant.Get
      security:
        - azureAdDelegated:
            - Directory.Read.All
      responses:
        "200":
          description: OK
components:
  securitySchemes:
    azureAdDelegated:
      type: oauth2
      flows:
        authorizationCode:
          authorizationUrl: https://login.microsoftonline.com/common/oauth2/v2.0/authorize
          tokenUrl: https://login.microsoftonline.com/common/oauth2/v2.0/token
          scopes:
            User.Read: Read user profile
`;

const graphHttpClientLayer = Layer.succeed(HttpClient.HttpClient)(
  HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(request.url === MICROSOFT_GRAPH_OPENAPI_URL ? graphFixture : "not found", {
          status: request.url === MICROSOFT_GRAPH_OPENAPI_URL ? 200 : 404,
          headers: { "content-type": "application/yaml" },
        }),
      ),
    ),
  ),
);

it.effect("wraps Microsoft Graph structural split with a streaming keep filter", () =>
  Effect.gen(function* () {
    const converted = yield* microsoftGraphAdapter.fetch({
      urls: [MICROSOFT_GRAPH_OPENAPI_URL],
      httpClientLayer: graphHttpClientLayer,
    });
    const structure = structuralSplit(converted.specText);
    expect(structure).not.toBeNull();
    const keepPathItem = converted.keepPathItem!;

    expect(keepPathItem("/me", { get: { operationId: "me.GetUser" } })).toEqual({
      get: { operationId: "me.GetUser" },
    });
    expect(keepPathItem("/irrelevant", { get: { operationId: "irrelevant.Get" } })).toBeNull();
    expect(structure!.pathItems.length).toBe(2);
  }),
);

it.effect("uses catalog URL fragments to select one Graph workload", () =>
  Effect.gen(function* () {
    const converted = yield* microsoftGraphAdapter.fetch({
      urls: [`${MICROSOFT_GRAPH_OPENAPI_URL}#preset=profile`],
      httpClientLayer: graphHttpClientLayer,
    });
    const keepPathItem = converted.keepPathItem!;

    expect(keepPathItem("/me", { get: { operationId: "me.GetUser" } })).toEqual({
      get: { operationId: "me.GetUser" },
    });
    expect(keepPathItem("/irrelevant", { get: { operationId: "irrelevant.Get" } })).toBeNull();
  }),
);
