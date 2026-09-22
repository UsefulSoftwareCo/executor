/** A real loopback token service. It exposes protocol observations, never submitted secrets or access tokens. */
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, Encoding, Layer } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

/** Synthetic values include punctuation so raw Basic differs from standard OAuth Basic. */
export const machineClient = {
  clientId: "synthetic+client",
  clientSecret: "synthetic:secret &value",
};
const formEncode = (value: string) =>
  new URLSearchParams({ value }).toString().slice("value=".length);

/** Token issuance and resource access use actual HTTP; renewal is visible through the token generation. */
export const clientCredentialsIssuer = Effect.gen(function* () {
  const address = yield* Deferred.make<string>();
  let expiresIn = 120;
  let rejected = false;
  let method: "client_secret_post" | "client_secret_basic" | "client_secret_basic_raw" =
    "client_secret_basic";
  let requests = 0;
  let generation = 0;
  let token = "";
  let hold: { entered: Deferred.Deferred<void>; released: Deferred.Deferred<void> } | undefined;
  let observed:
    | {
        grant: string | null;
        scope: string | null;
        resource: string | null;
        hasCallback: boolean;
        authenticated: boolean;
      }
    | undefined;
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/.well-known/oauth-authorization-server",
      Effect.gen(function* () {
        const origin = yield* Deferred.await(address);
        return yield* HttpServerResponse.json({
          issuer: origin,
          token_endpoint: `${origin}/token`,
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
          grant_types_supported: ["client_credentials"],
        });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/token",
      Effect.gen(function* () {
        requests++;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const parameters = new URLSearchParams(yield* request.text);
        const pair =
          method === "client_secret_basic_raw"
            ? `${machineClient.clientId}:${machineClient.clientSecret}`
            : `${formEncode(machineClient.clientId)}:${formEncode(machineClient.clientSecret)}`;
        const authenticated =
          method === "client_secret_post"
            ? parameters.get("client_id") === machineClient.clientId &&
              parameters.get("client_secret") === machineClient.clientSecret &&
              request.headers.authorization === undefined
            : request.headers.authorization ===
                `Basic ${Encoding.encodeBase64(new TextEncoder().encode(pair))}` &&
              !parameters.has("client_secret");
        observed = {
          grant: parameters.get("grant_type"),
          scope: parameters.get("scope"),
          resource: parameters.get("resource"),
          hasCallback:
            parameters.has("redirect_uri") ||
            parameters.has("code") ||
            parameters.has("code_verifier"),
          authenticated,
        };
        if (rejected || !authenticated || observed.grant !== "client_credentials")
          return yield* HttpServerResponse.json({ error: "invalid_client" }, { status: 400 });
        const pending = hold;
        hold = undefined;
        if (pending !== undefined) {
          yield* Deferred.succeed(pending.entered, undefined);
          yield* Deferred.await(pending.released);
        }
        token = `synthetic-access-${++generation}`;
        return yield* HttpServerResponse.json({
          access_token: token,
          token_type: "Bearer",
          expires_in: expiresIn,
        });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/resource",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* HttpServerResponse.json({
          authenticated: request.headers.authorization === `Bearer ${token}`,
          generation,
        });
      }),
    ),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Token fixture needs a TCP listener");
  const origin = `http://127.0.0.1:${server.address.port}`;
  yield* Deferred.succeed(address, origin);
  return {
    origin,
    pauseNextToken: Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        released = yield* Deferred.make<void>();
      hold = { entered, released };
      yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
      return { entered: Deferred.await(entered), release: Deferred.succeed(released, undefined) };
    }),
    configure: (input: { expiresIn?: number; rejected?: boolean; method?: typeof method }) =>
      Effect.sync(() => {
        if (input.expiresIn !== undefined) expiresIn = input.expiresIn;
        if (input.rejected !== undefined) rejected = input.rejected;
        if (input.method !== undefined) method = input.method;
      }),
    metrics: Effect.sync(() => ({ requests, generation, observed })),
  };
});
