/**
 * Local serves the SDK routes, whose contract decodes `accounts` as an operation's account map.
 * Callers never choose accounts: a well-formed choice reaches `linkedOperation`, which refuses it,
 * but one in another shape fails the contract before any handler runs. This middleware answers that
 * request with the same `AccountChoiceUnsupported`, so a choice is refused in any shape. Any other
 * request the contract rejects gets `RequestInvalid`'s body rather than an empty 400.
 */
import { AccountChoiceUnsupported, AppId, RequestInvalid } from "@executor-js/sdk/core";
import { isRequestRejection } from "@executor-js/telemetry/http";
import { Effect, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const noPayload: typeof JsonObject.Type = {};
const Refusal = Schema.Union([AccountChoiceUnsupported, RequestInvalid]);

/** The app a rejected request names in its path, query or body, and whether it named accounts. */
const rejectedRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const route = yield* Effect.serviceOption(HttpRouter.RouteContext);
  const query = new URL(request.url, "http://localhost").searchParams;
  // The contract already read the body; a request without a JSON object body names nothing there.
  const payload = yield* request.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(JsonObject)),
    Effect.orElseSucceed(() => noPayload),
  );
  const app = Schema.decodeUnknownOption(AppId)(
    Option.getOrUndefined(Option.flatMapNullishOr(route, (route) => route.params.app)) ??
      query.get("app") ??
      payload.app,
  );
  return { app, accounts: query.has("accounts") || Object.hasOwn(payload, "accounts") };
});

const reply = (error: typeof Refusal.Type) =>
  Schema.encodeEffect(Refusal)(error).pipe(
    Effect.map((body) => HttpServerResponse.jsonUnsafe(body, { status: 400 })),
    Effect.orDie,
  );

export const accountChoiceRefusal = HttpRouter.middleware((httpEffect) =>
  httpEffect.pipe(
    Effect.catchDefect((defect) =>
      isRequestRejection(defect)
        ? Effect.flatMap(rejectedRequest, ({ app, accounts }) =>
            accounts && Option.isSome(app)
              ? reply(new AccountChoiceUnsupported({ app: app.value }))
              : reply(new RequestInvalid()),
          )
        : Effect.die(defect),
    ),
  ),
);
