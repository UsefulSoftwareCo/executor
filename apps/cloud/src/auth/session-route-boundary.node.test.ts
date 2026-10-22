import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { SessionAuth } from "./middleware";
import { SessionAuthLive } from "./middleware-live";
import { WorkOSClient, type WorkOSClientService } from "./workos";

/**
 * The raw Cloud session route is cookie-authenticated. This keeps the bearer
 * machine credential plane from reaching an owner session handler, where a
 * delegated key could otherwise inherit account/admin authority. The counter
 * is deliberately behind the actual HTTP handler so this asserts the route
 * rejects before any management side effect.
 */
class RawCloudAuthApi extends HttpApiGroup.make("cloudAuth")
  .add(
    HttpApiEndpoint.get("me", "/auth/me", {
      success: Schema.String,
    }),
  )
  .middleware(SessionAuth) {}

const RawCloudApi = HttpApi.make("cloudWeb").add(RawCloudAuthApi);

const RawCloudAuthHandlers = HttpApiBuilder.group(RawCloudApi, "cloudAuth", (handlers) =>
  handlers.handle("me", () =>
    Effect.sync(() => {
      sideEffects += 1;
      return "owner-session";
    }),
  ),
);

let sideEffects = 0;
let sessionLookups = 0;
const sessionInputs: string[] = [];

const stubWorkOS = Layer.succeed(
  WorkOSClient,
  new Proxy({} as WorkOSClientService, {
    get: (_target, property) => {
      if (property === "authenticateSealedSession") {
        return (credential: string) =>
          Effect.sync(() => {
            sessionLookups += 1;
            sessionInputs.push(credential);
            return null;
          });
      }
      return () => Effect.die(`unexpected WorkOSClient.${String(property)} call`);
    },
  }),
);

const app = HttpRouter.toWebHandler(
  HttpApiBuilder.layer(RawCloudApi).pipe(
    Layer.provide(RawCloudAuthHandlers),
    Layer.provide(SessionAuthLive),
    Layer.provide(stubWorkOS),
    Layer.provide(HttpServer.layerServices),
  ),
  { disableLogger: true },
);

describe("Cloud raw session management boundary", () => {
  it("rejects a delegated bearer before the owner handler side effect", async () => {
    sideEffects = 0;
    sessionLookups = 0;
    sessionInputs.length = 0;

    const response = await app.handler(
      new Request("https://executor.test/auth/me", {
        headers: { authorization: "Bearer delegated-bound-key" },
      }),
    );

    expect(response.status).toBe(401);
    expect(sideEffects).toBe(0);
    expect(sessionLookups).toBe(1);
    expect(sessionInputs).toEqual([""]);
  });
});
