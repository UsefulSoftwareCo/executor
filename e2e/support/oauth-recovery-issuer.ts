/** A scoped external issuer for client replacement, consent callbacks, and PKCE validation. */
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

/** Synthetic clients accepted by the issuer; neither secret is returned in protocol observations. */
export const recoveryClients = {
  original: { clientId: "original-client", clientSecret: "synthetic-original-secret" },
  replacement: { clientId: "replacement-client", clientSecret: "synthetic-replacement-secret" },
};

const basicCredentials = (header: string | undefined) => {
  if (!header?.startsWith("Basic ")) return undefined;
  try {
    const value = atob(header.slice(6));
    const separator = value.indexOf(":");
    if (separator < 0) return undefined;
    return {
      clientId: decodeURIComponent(value.slice(0, separator).replace(/\+/g, " ")),
      clientSecret: decodeURIComponent(value.slice(separator + 1).replace(/\+/g, " ")),
    };
  } catch {
    return undefined;
  }
};

/** The browser simulates consent; the real Executor validates state and completes its own callback. */
export const oauthRecoveryIssuer = (callbackOrigin: string) =>
  Effect.gen(function* () {
    const codes = new Map<string, { clientId: string; redirect: string; challenge: string }>();
    const redirects = new Set([`${callbackOrigin}/api/oauth/callback`]);
    const observations: Array<{
      authorization: boolean;
      original: boolean;
      replacement: boolean;
      tokenAccepted: boolean;
    }> = [];
    const routes = Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/authorize",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const parameters = new URL(request.url, "http://localhost").searchParams;
          const clientId = parameters.get("client_id"),
            redirect = parameters.get("redirect_uri"),
            challenge = parameters.get("code_challenge");
          if (
            !clientId ||
            !redirect ||
            !redirects.has(redirect) ||
            !challenge ||
            parameters.get("code_challenge_method") !== "S256"
          )
            return HttpServerResponse.empty({ status: 400 });
          if (!Object.values(recoveryClients).some((client) => client.clientId === clientId))
            return HttpServerResponse.text("Unknown OAuth client", { status: 400 });
          const code = randomUUID();
          codes.set(code, { clientId, redirect, challenge });
          const callback = new URL(redirect);
          callback.searchParams.set("code", code);
          callback.searchParams.set("state", parameters.get("state") ?? "");
          // The managed host advertises a separate callback relay. Keep its exact
          // URI for the token exchange and model the relay's browser return here.
          const browserReturn = new URL("/oauth/callback", callbackOrigin);
          browserReturn.search = callback.search;
          return HttpServerResponse.empty({
            status: 302,
            headers: { location: browserReturn.href },
          });
        }),
      ),
      HttpRouter.add(
        "POST",
        "/token",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const parameters = new URLSearchParams(yield* request.text);
          const submitted = basicCredentials(request.headers.authorization);
          const client = Object.values(recoveryClients).find(
            (client) =>
              client.clientId === submitted?.clientId &&
              client.clientSecret === submitted.clientSecret,
          );
          observations.push({
            authorization: request.headers.authorization !== undefined,
            original: client === recoveryClients.original,
            replacement: client === recoveryClients.replacement,
            tokenAccepted: client !== undefined,
          });
          if (client === undefined)
            return yield* HttpServerResponse.json({ error: "invalid_client" }, { status: 400 });
          const code = parameters.get("code") ?? "";
          const pending = codes.get(code);
          if (
            pending === undefined ||
            pending.clientId !== client.clientId ||
            pending.redirect !== parameters.get("redirect_uri") ||
            createHash("sha256")
              .update(parameters.get("code_verifier") ?? "")
              .digest("base64url") !== pending.challenge
          )
            return yield* HttpServerResponse.json({ error: "invalid_grant" }, { status: 400 });
          codes.delete(code);
          return yield* HttpServerResponse.json({
            access_token: randomUUID(),
            token_type: "Bearer",
            expires_in: 3600,
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
    if (!("port" in server.address))
      return yield* Effect.die("Recovery issuer needs a TCP listener");
    return {
      origin: `http://127.0.0.1:${server.address.port}`,
      observations: Effect.sync(() => [...observations]),
      registerCallback: (url: string) =>
        Effect.sync(() => {
          redirects.add(url);
        }),
    };
  });
