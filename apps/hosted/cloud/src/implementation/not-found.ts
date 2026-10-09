import { Effect } from "effect";
import { HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http";

import { staticDocument } from "./homepage.ts";

/**
 * A browser navigation that no route or asset matches gets the site's 404 document,
 * still with a 404 status. The documentation build has its own, which keeps the docs
 * navigation. Other requests, such as API and MCP clients, keep an empty 404.
 */
export const notFoundDocument = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const navigation =
    (request.method === "GET" || request.method === "HEAD") &&
    (request.headers.accept ?? "").includes("text/html");
  if (!navigation) return HttpServerResponse.empty({ status: 404 });
  const { pathname } = new URL(request.url, "http://localhost");
  const docs = pathname === "/docs" || pathname.startsWith("/docs/");
  const document = yield* staticDocument(docs ? "/docs/404.html" : "/404.html");
  if (document.status !== 200) return HttpServerResponse.empty({ status: 404 });
  return document.pipe(
    HttpServerResponse.setStatus(404),
    HttpServerResponse.setHeader("cache-control", "no-store"),
  );
});

/** Replaces the router's empty response for an unmatched route. */
export const withNotFoundDocument = <A, E, R>(handler: Effect.Effect<A, E, R>) =>
  handler.pipe(
    Effect.catchIf(
      (error): error is E & HttpServerError.HttpServerError =>
        HttpServerError.isHttpServerError(error) && error.reason._tag === "RouteNotFound",
      () => notFoundDocument,
    ),
  );
