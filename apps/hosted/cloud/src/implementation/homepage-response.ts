import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { hasSessionCookie } from "../contracts/browser.ts";

export const homepageResponse = <E, R, E2, R2>(
  cookiePrefix: string,
  marketing: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  dashboard: Effect.Effect<HttpServerResponse.HttpServerResponse, E2, R2>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const response = yield* hasSessionCookie(new Headers(request.headers), cookiePrefix)
      ? dashboard
      : marketing;
    return response.pipe(
      HttpServerResponse.setHeader("cache-control", "private, no-store"),
      HttpServerResponse.setHeader("vary", "Cookie"),
    );
  });
