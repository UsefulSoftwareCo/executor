// ---------------------------------------------------------------------------
// `POST /api/webhooks/workos` — the WorkOS webhook endpoint, which only
// POKES the reconciler. It verifies the delivery's signature and, when it
// is genuine, starts one `syncWorkOsEvents` pass past the response. It
// never applies the webhook's own payload: webhooks are unordered and
// at-least-once, while the Events API the reconciler reads is ordered and
// replayable from the persisted cursor. The webhook's only job is to turn
// "within a minute" (the cron) into "within seconds" for dashboard-side
// changes such as a revoked membership.
//
// Unauthenticated by design (WorkOS holds no session); the signature IS the
// authentication. Nothing about the payload is reflected in the response.
// ---------------------------------------------------------------------------

import { Effect, Option, Schema } from "effect";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { WorkOSClient } from "./workos";

export const WORKOS_WEBHOOK_PATH = "/api/webhooks/workos";

const SIGNATURE_HEADER = "workos-signature";

// The SDK verifies the signature over `JSON.stringify(payload)`, so the body
// must be a JSON object; an array or scalar can never be a WorkOS delivery.
const WebhookPayload = Schema.Record(Schema.String, Schema.Unknown);
const decodeWebhookPayload = Schema.decodeUnknownOption(WebhookPayload);

export interface WorkOsWebhookDeps {
  /**
   * The endpoint's signing secret (`WORKOS_WEBHOOK_SECRET`). `undefined`
   * when the deployment has not configured one: every delivery is then
   * refused with 503, never accepted unverified.
   */
  readonly secret: string | undefined;
  /**
   * Hand the reconciler pass to the platform so it outlives the response
   * (`waitUntil` from `cloudflare:workers`). The promise never rejects: the
   * runner reports its own failures.
   */
  readonly detach: (work: Promise<void>) => void;
  /** One reconciler pass over fresh services (`runWorkOsEventsSync`). */
  readonly sync: () => Promise<void>;
}

/**
 * The webhook route. 200 for a verified delivery (a sync pass has been
 * detached), 400 for a missing or invalid signature or a body that is not a
 * JSON object, 503 when no signing secret is configured.
 */
export const makeWorkOsWebhookRoute = (deps: WorkOsWebhookDeps) =>
  HttpRouter.add(
    "POST",
    WORKOS_WEBHOOK_PATH,
    Effect.gen(function* () {
      if (deps.secret === undefined) {
        yield* Effect.logError(
          "workos_webhook: WORKOS_WEBHOOK_SECRET is not set; refusing the delivery",
        );
        return HttpServerResponse.empty({ status: 503 });
      }
      const secret = deps.secret;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const sigHeader = Headers.get(request.headers, SIGNATURE_HEADER);
      if (Option.isNone(sigHeader)) {
        return HttpServerResponse.empty({ status: 400 });
      }
      const body = yield* request.json.pipe(Effect.option);
      const payload = Option.flatMap(body, decodeWebhookPayload);
      if (Option.isNone(payload)) {
        return HttpServerResponse.empty({ status: 400 });
      }

      const workos = yield* WorkOSClient;
      const verified = yield* workos
        .constructWebhookEvent({
          payload: payload.value,
          sigHeader: sigHeader.value,
          secret,
        })
        .pipe(Effect.option);
      if (Option.isNone(verified)) {
        yield* Effect.logWarning("workos_webhook: signature rejected");
        return HttpServerResponse.empty({ status: 400 });
      }

      yield* Effect.logInfo("workos_webhook: verified delivery; poking the reconciler", {
        event: verified.value.event,
        eventId: verified.value.id,
      });
      deps.detach(deps.sync());
      return HttpServerResponse.empty({ status: 200 });
    }),
  );
