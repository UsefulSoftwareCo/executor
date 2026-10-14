/** Cloud's connected-account callback, which also returns a test stage's sign-ins to the stage. */
import { Authentication, hostedOAuthCallback } from "@executor-js/hosted-server";
import { Effect, Option } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { stageAccountStateOrigin } from "../contracts/stage-account-state.ts";

/**
 * A state that names a stage (`stage-account-state.ts`) opens that stage's callback page with the
 * same code and state, when this deployment returns callbacks to it; the stage exchanges the code
 * with the client and verifier only it holds. Every other state is this deployment's own, as is a
 * stage's state on the stage itself: a client entered there keeps the stage's callback.
 */
export const cloudAccountCallback = (returnsTo: (origin: string) => Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "https://callback.internal");
    const stage = stageAccountStateOrigin(url.searchParams.get("state") ?? "");
    const { origin } = yield* Authentication;
    if (Option.isNone(stage) || stage.value === origin) return yield* hostedOAuthCallback;
    if (!(yield* returnsTo(stage.value)))
      return HttpServerResponse.text(
        "This sign-in belongs to a deployment this one does not trust.",
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    return HttpServerResponse.redirect(`${stage.value}/oauth/callback${url.search}`, {
      headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
    });
  });
