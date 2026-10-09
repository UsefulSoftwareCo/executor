/** A real loopback token service. It exposes protocol observations, never submitted secrets or access tokens. */
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Clock, Deferred, Effect, Layer } from "effect";
import { Base64 } from "effect/encoding";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

/** Synthetic values include punctuation so raw Basic differs from standard OAuth Basic. */
export const machineClient = {
  clientId: "synthetic+client",
  clientSecret: "synthetic:secret &value",
};
const formEncode = (value: string) =>
  new URLSearchParams({ value }).toString().slice("value=".length);

/**
 * Token request parameters from an RFC 6749 form or, for services such as Notion, a JSON object
 * of strings. Anything else yields no parameters.
 */
export const tokenRequestParameters = (contentType: string | undefined, text: string) => {
  if (contentType?.split(";")[0]?.trim() !== "application/json") return new URLSearchParams(text);
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return new URLSearchParams();
    const entries = Object.entries(value);
    return entries.every((entry): entry is [string, string] => typeof entry[1] === "string")
      ? new URLSearchParams(entries)
      : new URLSearchParams();
  } catch {
    return new URLSearchParams();
  }
};

/** Token issuance and resource access use actual HTTP; renewal is visible through the token generation. */
export const clientCredentialsIssuer = Effect.gen(function* () {
  const address = yield* Deferred.make<string>();
  let expiresIn = 120;
  let rejected = false;
  let method: "client_secret_post" | "client_secret_basic" | "client_secret_basic_raw" =
    "client_secret_basic";
  /** The body encoding the token endpoint accepts; the other one is refused. */
  let format: "form" | "json" = "form";
  let requests = 0;
  let generation = 0;
  const tokens = new Map<string, { generation: number; expiresAt: number }>();
  let hold: { entered: Deferred.Deferred<void>; released: Deferred.Deferred<void> } | undefined;
  let observed:
    | {
        grant: string | null;
        scope: string | null;
        resource: string | null;
        contentType: string | undefined;
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
        const contentType = request.headers["content-type"]?.split(";")[0]?.trim();
        const parameters = tokenRequestParameters(contentType, yield* request.text);
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
                `Basic ${Base64.encode(new TextEncoder().encode(pair))}` &&
              !parameters.has("client_secret");
        observed = {
          grant: parameters.get("grant_type"),
          scope: parameters.get("scope"),
          resource: parameters.get("resource"),
          contentType,
          hasCallback:
            parameters.has("redirect_uri") ||
            parameters.has("code") ||
            parameters.has("code_verifier"),
          authenticated,
        };
        const encoded =
          contentType ===
          (format === "json" ? "application/json" : "application/x-www-form-urlencoded");
        if (!encoded)
          return yield* HttpServerResponse.json({ error: "invalid_request" }, { status: 400 });
        if (rejected || !authenticated || observed.grant !== "client_credentials")
          return yield* HttpServerResponse.json({ error: "invalid_client" }, { status: 400 });
        const pending = hold;
        hold = undefined;
        if (pending !== undefined) {
          yield* Deferred.succeed(pending.entered, undefined);
          yield* Deferred.await(pending.released);
        }
        const token = `synthetic-access-${++generation}`;
        tokens.set(`Bearer ${token}`, {
          generation,
          expiresAt: (yield* Clock.currentTimeMillis) + expiresIn * 1000,
        });
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
        const issued = tokens.get(request.headers.authorization ?? "");
        return yield* HttpServerResponse.json({
          // Issuing another token does not revoke an unexpired in-flight token.
          authenticated:
            issued !== undefined && issued.expiresAt > (yield* Clock.currentTimeMillis),
          generation: issued?.generation ?? 0,
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
    configure: (input: {
      expiresIn?: number;
      rejected?: boolean;
      method?: typeof method;
      format?: typeof format;
    }) =>
      Effect.sync(() => {
        if (input.format !== undefined) format = input.format;
        if (input.expiresIn !== undefined) expiresIn = input.expiresIn;
        if (input.rejected !== undefined) rejected = input.rejected;
        if (input.method !== undefined) method = input.method;
      }),
    metrics: Effect.sync(() => ({ requests, generation, observed })),
  };
});
