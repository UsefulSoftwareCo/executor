import { env } from "cloudflare:workers";
import { Cause, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { autumnHandler } from "autumn-js/backend";

import { currentTenantSelector, TenantScopeMiddleware } from "@executor-js/api/server";

import { WorkOSClient } from "../../auth/workos";
import { authorizeOrganizationSelector } from "../../auth/organization";
import { HttpResponseError, isServerError, toErrorServerResponse } from "../../api/error-response";

type BillingSession = {
  readonly userId: string;
  readonly organizationId?: string | null;
};

export const resolveBillingOrganization = (session: BillingSession) =>
  Effect.gen(function* () {
    const selector = (yield* currentTenantSelector) ?? session.organizationId;
    if (!selector) {
      return yield* new HttpResponseError({
        status: 401,
        code: "unauthorized",
        message: "Unauthorized",
      });
    }

    const org = yield* authorizeOrganizationSelector(session.userId, selector);
    if (!org) {
      return yield* new HttpResponseError({
        status: 403,
        code: "forbidden",
        message: "Forbidden",
      });
    }
    return org;
  });

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

  if (!session) {
    return yield* new HttpResponseError({
      status: 401,
      code: "unauthorized",
      message: "Unauthorized",
    });
  }
  const org = yield* resolveBillingOrganization(session);
  const tenant = yield* currentTenantSelector;

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
      customerId: org.id,
      customerData: {
        name: session.email,
        email: session.email,
      },
      clientOptions: {
        secretKey: env.AUTUMN_SECRET_KEY ?? "",
        ...(env.AUTUMN_API_URL ? { serverURL: env.AUTUMN_API_URL } : {}),
      },
      pathPrefix: tenant ? `/${tenant}/api/billing` : "/api/billing",
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

const BareAutumnRoutesLive = HttpRouter.add("*", "/api/billing/*", handler);

const TenantAutumnRoutesLive = HttpRouter.add("*", "/:tenant/api/billing/*", handler).pipe(
  Layer.provide(TenantScopeMiddleware.layer),
);

export const AutumnRoutesLive = Layer.merge(
  BareAutumnRoutesLive,
  TenantAutumnRoutesLive,
) as Layer.Layer<never, never, any>;
