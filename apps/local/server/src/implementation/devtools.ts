/** Browser-pairing shortcuts mounted only by the local development entry point. */
import { LoopbackOrigin } from "@executor-js/utils/url-policy";
import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import type { ServerConfig } from "../contracts/config.ts";
import { localRequest, sessionCookie, type LocalAuth } from "./auth.ts";
import { AuthForbidden } from "../contracts/auth.ts";

/** Create a real local session through the ordinary one-use pairing lifecycle. */
export const localDevtools = (auth: LocalAuth, settings: ServerConfig) => {
  const request = Effect.gen(function* () {
    const current = yield* localRequest(settings.port, settings.browserOrigin);
    const origin = current.headers.origin;
    const hostOrigin = `http://${current.headers.host}`;
    if (!Schema.is(LoopbackOrigin)(origin === undefined ? hostOrigin : origin))
      return yield* new AuthForbidden();
    if (
      current.method === "POST" &&
      (origin === undefined || new URL(origin).host !== current.headers.host)
    )
      return yield* new AuthForbidden();
    return current;
  });
  const status = Effect.gen(function* () {
    const current = yield* request;
    return yield* HttpServerResponse.json({
      kind: "pairing",
      host: "local",
      paired: yield* auth.valid(current.cookies[sessionCookie(settings.port)]),
    }).pipe(Effect.map(HttpServerResponse.setHeader("cache-control", "no-store")));
  }).pipe(
    Effect.catchTag("AuthForbidden", () =>
      Effect.succeed(HttpServerResponse.empty({ status: 403 })),
    ),
    Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 503 }))),
  );
  const pair = Effect.gen(function* () {
    const current = yield* request;
    const grant = yield* auth.issue();
    const session = yield* auth.exchange(grant.token);
    return yield* HttpServerResponse.json({ status: true }).pipe(
      Effect.flatMap(
        HttpServerResponse.setCookie(sessionCookie(settings.port), Redacted.value(session), {
          httpOnly: true,
          sameSite: "strict",
          path: "/",
          maxAge: "7 days",
          secure: current.headers.origin?.startsWith("https:") === true,
        }),
      ),
      Effect.map(HttpServerResponse.setHeader("cache-control", "no-store")),
    );
  }).pipe(
    Effect.catchTag("AuthForbidden", () =>
      Effect.succeed(HttpServerResponse.empty({ status: 403 })),
    ),
    Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 503 }))),
  );
  return Layer.mergeAll(
    HttpRouter.add("GET", "/api/devtools", status),
    HttpRouter.add("POST", "/api/devtools/pair", pair),
  );
};
