/**
 * Test host only: while armed, /openapi.json serves another revision of the product's API, as an
 * API deployed apart from the Workers that call apps can for a few seconds of a rollout. Every
 * operation of that revision has `otherRevisionSuffix` on its operationId, so a listing read from
 * it is told apart from the product's own. The server still binds its apps to the SHA-256 of the
 * document it generated, so the served one is not of that revision. Production entry points never
 * provide it.
 *
 * The other revision arrives after `slowMillis`, so the listing it fails is a slow failure (over
 * the default listing policy's `slowFailureMillis`), as a cold app Worker's often is on a loaded
 * host. Such a failure is the kind a listing could remember, and the next read must still fetch
 * the document again.
 */
import { Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

const path = "/api/devtools/api-document";
/** The suffix another revision's operations carry. */
export const otherRevisionSuffix = "OtherRevision";
/** How long the other revision takes to arrive. */
const slowMillis = 1_500;

const Operation = Schema.Struct({ operationId: Schema.String });
const Document = Schema.Struct({
  paths: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
});

/** The product's document with every operation renamed. */
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
