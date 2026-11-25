import { SessionAuthentication, hostedOAuthCallback } from "@executor-js/hosted-server";
import { Effect, Option } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { stageAccountStateOrigin } from "../contracts/stage-account-state.ts";

export const cloudAccountCallback = (returnsTo: (origin: string) => Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "https://callback.internal");
    const stage = stageAccountStateOrigin(url.searchParams.get("state") ?? "");
    const { origin } = yield* SessionAuthentication;
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
