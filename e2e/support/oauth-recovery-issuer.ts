/** A scoped external issuer for client replacement, consent callbacks, and PKCE validation. */
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, Layer, Schema } from "effect";
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
export const oauthRecoveryIssuer = (callbackOrigin: string, interactive = false) =>
  Effect.gen(function* () {
    const address = yield* Deferred.make<string>();
    let discoveryFails = false;
    let registration = true;
    let tokenFails = false;
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
        "/.well-known/oauth-authorization-server",
        Effect.gen(function* () {
          if (discoveryFails) return HttpServerResponse.empty({ status: 503 });
          const origin = yield* Deferred.await(address);
          return yield* HttpServerResponse.json({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["client_secret_basic"],
            scopes_supported: ["reports:read", "offline_access"],
            ...(registration ? { registration_endpoint: `${origin}/register` } : {}),
          });
        }),
      ),
      HttpRouter.add(
        "POST",
        "/register",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const input = yield* request.json.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({ redirect_uris: Schema.Array(Schema.String) }),
              ),
            ),
          );
          for (const redirect of input.redirect_uris) redirects.add(redirect);
          return yield* HttpServerResponse.json(
            {
              client_id: recoveryClients.original.clientId,
              client_secret: recoveryClients.original.clientSecret,
              client_secret_expires_at: 0,
              token_endpoint_auth_method: "client_secret_basic",
              redirect_uris: input.redirect_uris,
            },
            { status: 201 },
          );
        }),
      ),
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
          if (interactive && parameters.get("decision") === null) {
            const fields = [...parameters]
              .map(
                ([name, value]) =>
                  `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
              )
              .join("");
            return HttpServerResponse.html(
              `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sample service consent</title><style>body{margin:0;background:#0b0b0b;color:#eee;font:16px/1.6 system-ui;display:grid;min-height:100vh;place-items:center}main{width:440px;max-width:calc(100vw - 64px);padding:32px;border:1px solid #333;border-radius:12px}small{color:#aaa}h1{font-size:24px}button{padding:12px 18px;margin:20px 8px 0 0;border:1px solid #555;border-radius:6px;cursor:pointer}button[value=allow]{background:white;color:black}</style><main><small>External OAuth test provider</small><h1>Connect Sample service</h1><p>Executor requests permission to:</p><ul><li>Read reports</li><li>Keep access while you are away</li></ul><p>Signed in as maya@example.test</p><form method="get" action="/authorize">${fields}<button name="decision" value="allow">Allow access</button><button name="decision" value="cancel">Cancel</button></form></main></html>`,
            );
          }
          if (parameters.get("decision") === "cancel") {
            const denied = new URL("/oauth/callback", callbackOrigin);
            denied.searchParams.set("error", "access_denied");
            denied.searchParams.set("state", parameters.get("state") ?? "");
            return HttpServerResponse.empty({ status: 302, headers: { location: denied.href } });
          }
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
          if (tokenFails)
            return yield* HttpServerResponse.json(
              { error: "temporarily_unavailable" },
              { status: 503 },
            );
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
    const origin = `http://127.0.0.1:${server.address.port}`;
    yield* Deferred.succeed(address, origin);
    return {
      origin,
      configure: (input: {
        readonly discoveryFails?: boolean;
        readonly registration?: boolean;
        readonly tokenFails?: boolean;
      }) =>
        Effect.sync(() => {
          if (input.discoveryFails !== undefined) discoveryFails = input.discoveryFails;
          if (input.registration !== undefined) registration = input.registration;
          if (input.tokenFails !== undefined) tokenFails = input.tokenFails;
        }),
      observations: Effect.sync(() => [...observations]),
      registerCallback: (url: string) =>
        Effect.sync(() => {
          redirects.add(url);
        }),
    };
  });

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
