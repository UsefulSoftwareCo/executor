import { env } from "cloudflare:workers";
import { Cause, Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { autumnHandler } from "autumn-js/backend";

import { WorkOSClient } from "../../auth/workos";
import { HttpResponseError, isServerError, toErrorServerResponse } from "../../api/error-response";

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const webRequest = yield* Effect.mapError(
    HttpServerRequest.toWeb(request),
    () =>
      new HttpResponseError({
        status: 500,
        code: "invalid_request",
        message: "Invalid request",
      }),
  );

  const workos = yield* WorkOSClient;
  const session = yield* workos.authenticateRequest(webRequest);

  if (!session || !session.organizationId) {
    return yield* new HttpResponseError({
      status: 401,
      code: "unauthorized",
      message: "Unauthorized",
    });
  }

  const url = new URL(webRequest.url);
  const body =
    request.method !== "GET" && request.method !== "HEAD"
      ? yield* Effect.mapError(
          request.json,
          () =>
            new HttpResponseError({
              status: 400,
              code: "invalid_json",
              message: "Invalid request body",
            }),
        )
      : undefined;

  const { statusCode, response } = yield* Effect.promise(() =>
    autumnHandler({
      request: {
        url: url.pathname,
        method: request.method,
        body,
      },
      customerId: session.organizationId,
      customerData: {
        name: session.email,
        email: session.email,
      },
      clientOptions: {
        secretKey: env.AUTUMN_SECRET_KEY ?? "",
        ...(env.AUTUMN_API_URL ? { serverURL: env.AUTUMN_API_URL } : {}),
      },
      pathPrefix: "/api/billing",
    }),
  );

  if (statusCode >= 400) {
    console.error("[autumn] upstream error:", statusCode, response);
    return yield* new HttpResponseError({
      status: statusCode,
      code: "billing_request_failed",
      message: "Billing request failed",
    });
  }

  return HttpServerResponse.jsonUnsafe(response, { status: statusCode });
}).pipe(
  Effect.catchCause((err) => {
    if (isServerError(err)) {
      console.error("[autumn] request failed:", Cause.pretty(err));
    }
    return Effect.succeed(toErrorServerResponse(err));
  }),
);

export const AutumnRoutesLive = HttpRouter.add("*", "/api/billing/*", handler);
