import { Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

const path = "/api/devtools/api-document";
export const otherRevisionSuffix = "OtherRevision";
const slowMillis = 1_500;

const Operation = Schema.Struct({ operationId: Schema.String });
const Document = Schema.Struct({
  paths: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
});

const otherRevision = (served: string) => {
  const document: unknown = JSON.parse(served);
  for (const methods of Object.values(Schema.decodeUnknownSync(Document)(document).paths))
    for (const operation of Object.values(methods))
      if (Schema.is(Operation)(operation))
        Object.assign(operation, { operationId: `${operation.operationId}${otherRevisionSuffix}` });
  return JSON.stringify(document);
};

export const apiDocumentFixture = Effect.sync(() => {
  let armed = false;
  const toggle = (value: boolean) =>
    Effect.sync(() => {
      armed = value;
      return HttpServerResponse.jsonUnsafe({ armed });
    });
  return Layer.mergeAll(
    HttpRouter.add("POST", path, toggle(true)),
    HttpRouter.add("DELETE", path, toggle(false)),
    HttpRouter.middleware(
      (app) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = HttpServerRequest.toURL(request);
          if (
            !armed ||
            request.method !== "GET" ||
            Option.isNone(url) ||
            url.value.pathname !== "/openapi.json"
          )
            return yield* app;
          const served = yield* app;
          if (served.status !== 200 || served.body._tag !== "Uint8Array") return served;
          yield* Effect.sleep(slowMillis);
          return HttpServerResponse.text(
            otherRevision(new TextDecoder().decode(served.body.body)),
            { contentType: "application/json" },
          );
        }),
      { global: true },
    ),
  );
});
