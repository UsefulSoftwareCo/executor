import { CurrentPrincipal } from "@executor-js/hosted-server";
import { Effect, Schema, Stream } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { ExecutorCloudApi } from "../contracts/api.ts";
import { CreateTeam, Onboarding, TeamDetailsInvalid } from "../contracts/onboarding.ts";

// A 2 MiB image fits within 3 MiB after base64 encoding. Read through the stream
// so the bound also applies to chunked requests before JSON or image decoding.
const creationPayload = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const limit = 3 * 1024 * 1024;
  const body = yield* request.stream.pipe(
    Stream.runFoldEffect(
      () => ({ bytes: new Uint8Array(limit), length: 0 }),
      (current, chunk) => {
        const length = current.length + chunk.length;
        if (length > limit) return Effect.fail(new TeamDetailsInvalid());
        current.bytes.set(chunk, current.length);
        return Effect.succeed({ bytes: current.bytes, length });
      },
    ),
  );
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CreateTeam))(
    new TextDecoder().decode(body.bytes.subarray(0, body.length)),
  );
}).pipe(Effect.mapError(() => new TeamDetailsInvalid()));

/** Authenticated setup and private icon reads; the browser never supplies the acting user. */
export const onboardingHandlers = HttpApiBuilder.group(ExecutorCloudApi, "onboarding", (handlers) =>
  Effect.gen(function* () {
    const onboarding = yield* Onboarding;
    return handlers
      .handle("prepare", () =>
        Effect.gen(function* () {
          return yield* onboarding.prepare((yield* CurrentPrincipal).userId);
        }),
      )
      .handleRaw("create", () =>
        Effect.gen(function* () {
          const payload = yield* creationPayload;
          return yield* onboarding.create((yield* CurrentPrincipal).userId, payload);
        }),
      )
      .handle("icon", ({ params }) =>
        Effect.gen(function* () {
          const icon = yield* onboarding.icon(
            (yield* CurrentPrincipal).userId,
            params.owner,
            params.key,
          );
          return HttpServerResponse.uint8Array(icon.bytes, {
            contentType: icon.contentType,
            headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
          });
        }),
      );
  }),
);
