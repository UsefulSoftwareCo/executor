/** Callback transport shared by hosts. App responses cannot write cookies or execute HTML on the dashboard origin. */
import { ByteSize, Effect, Encoding, Schema } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { WebhookRequestData, defaultWebhookTransportLimits } from "apps/contracts";
import type { Executor } from "../contracts/executor.ts";
import { WebhookCallbackParams } from "../contracts/webhooks.ts";

/** Mount explicitly in a host route map; this handler has no dashboard/session authentication. */
export const webhookCallback = (executor: Executor) =>
  Effect.gen(function* () {
    const { appId, subscriptionId } = yield* HttpRouter.schemaPathParams(WebhookCallbackParams);
    const incoming = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* incoming.arrayBuffer.pipe(
      Effect.provideService(
        HttpIncomingMessage.MaxBodySize,
        ByteSize.bytes(defaultWebhookTransportLimits.maxBodyBytes),
      ),
    );
    if (body.byteLength > defaultWebhookTransportLimits.maxBodyBytes)
      return HttpServerResponse.empty({ status: 413 });
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined && name.toLowerCase() !== "cookie") headers[name] = value;
    }
    const input = yield* Schema.decodeUnknownEffect(WebhookRequestData)({
      url: new URL(incoming.url, "http://webhooks.internal").href,
      method: incoming.method,
      headers,
      body: Encoding.encodeBase64(new Uint8Array(body)),
    });
    const response = yield* executor.webhooks.deliver({
      app: appId,
      subscription: subscriptionId,
      request: input,
    });
    const bytes = yield* Effect.fromResult(Encoding.decodeBase64(response.body));
    // Preserve provider challenge/backoff headers without granting app code control of the host origin.
    const providerHeaders: Record<string, string> = {};
    for (const name of ["webhook-allowed-origin", "webhook-allowed-rate", "retry-after", "allow"]) {
      const value = response.headers[name];
      if (value !== undefined) providerHeaders[name] = value;
    }
    return HttpServerResponse.uint8Array(bytes, {
      status: response.status,
      headers: {
        ...providerHeaders,
        "content-type": response.headers["content-type"] ?? "text/plain; charset=utf-8",
        "content-security-policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }).pipe(
    Effect.catchTags({
      WebhookNotFound: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
      WebhookFailed: ({ reason }) =>
        Effect.succeed(HttpServerResponse.empty({ status: reason === "inactive" ? 410 : 503 })),
      SchemaError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
    }),
    Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 503 }))),
  );
