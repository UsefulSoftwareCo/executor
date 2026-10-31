/** An external OIDC issuer with rotating grants and stable subjects; all product state stays in the real server. */
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, Layer, Queue } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

type Grant = { subject: string; scopes: string[]; client: string };
type Code = Grant & { challenge: string; redirect: string };

export const accountIdentityIssuer = Effect.gen(function* () {
  const address = yield* Deferred.make<string>();
  const revoked = yield* Queue.unbounded<void>();
  let subject = "person-one";
  let profileFails = false;
  let denied = false;
  let expiresIn = 3600;
  let confirmedScopes: string[] | undefined;
  let authorizations = 0,
    exchanges = 0,
    refreshes = 0,
    revocations = 0;
  const codes = new Map<string, Code>();
  const access = new Map<string, Grant>();
  const refresh = new Map<string, Grant>();
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/.well-known/oauth-authorization-server",
      Effect.gen(function* () {
        const origin = yield* Deferred.await(address);
        return yield* HttpServerResponse.json({
          issuer: origin,
          authorization_endpoint: origin + "/authorize",
          token_endpoint: origin + "/token",
          userinfo_endpoint: origin + "/userinfo",
          revocation_endpoint: origin + "/revoke",
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/authorize",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const params = new URL(request.url, "http://localhost").searchParams;
        const redirect = params.get("redirect_uri"),
          challenge = params.get("code_challenge"),
          client = params.get("client_id");
        if (
          redirect === null ||
          challenge === null ||
          client === null ||
          params.get("code_challenge_method") !== "S256"
        )
          return HttpServerResponse.empty({ status: 400 });
        authorizations++;
        const callback = new URL(redirect);
        callback.searchParams.set("state", params.get("state") ?? "");
        if (denied) callback.searchParams.set("error", "access_denied");
        else {
          const code = randomUUID();
          codes.set(code, {
            subject,
            scopes: params.get("scope")?.split(" ").filter(Boolean) ?? [],
            client,
            redirect,
            challenge,
          });
          callback.searchParams.set("code", code);
        }
        return HttpServerResponse.empty({ status: 302, headers: { location: callback.href } });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/token",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const params = new URLSearchParams(yield* request.text);
        const code = params.get("code"),
          token = params.get("refresh_token");
        const issued = code === null ? undefined : codes.get(code);
        const renewal = token === null ? undefined : refresh.get(token);
        const grant = issued ?? renewal;
        const verifier = params.get("code_verifier");
        if (
          grant === undefined ||
          params.get("client_id") !== grant.client ||
          (issued !== undefined &&
            (verifier === null ||
              issued.redirect !== params.get("redirect_uri") ||
              createHash("sha256").update(verifier).digest("base64url") !== issued.challenge))
        )
          return yield* HttpServerResponse.json({ error: "invalid_grant" }, { status: 400 });
        if (issued !== undefined) {
          codes.delete(code ?? "");
          exchanges++;
        } else {
          refresh.delete(token ?? "");
          refreshes++;
        }
        const saved = { ...grant, scopes: confirmedScopes ?? grant.scopes };
        const accessToken = `synthetic-access-${randomUUID()}`,
          refreshToken = `synthetic-refresh-${randomUUID()}`;
        access.set(accessToken, saved);
        refresh.set(refreshToken, saved);
        return yield* HttpServerResponse.json({
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: "Bearer",
          expires_in: issued === undefined ? 3600 : expiresIn,
          scope: saved.scopes.join(" "),
        });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/userinfo",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const grant = access.get(request.headers.authorization?.replace(/^Bearer /, "") ?? "");
        if (grant === undefined || profileFails) return HttpServerResponse.empty({ status: 401 });
        // Deliberately identical email for different subjects: it cannot be a grouping key.
        return yield* HttpServerResponse.json({ sub: grant.subject, email: "same@example.test" });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/resource",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const grant = access.get(request.headers.authorization?.replace(/^Bearer /, "") ?? "");
        if (grant === undefined) return HttpServerResponse.empty({ status: 401 });
        return yield* HttpServerResponse.json({ subject: grant.subject, scopes: grant.scopes });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/revoke",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const params = new URLSearchParams(yield* request.text);
        const token = params.get("token") ?? "";
        revocations++;
        access.delete(token);
        refresh.delete(token);
        yield* Queue.offer(revoked, undefined);
        return HttpServerResponse.empty({ status: 200 });
      }),
    ),
  );
  const serverLayer = NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 });
  const services = yield* Layer.build(
    HttpRouter.serve(routes).pipe(Layer.provideMerge(serverLayer)),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address))
    return yield* Effect.die("Identity fixture needs a TCP listener");
  const origin = `http://127.0.0.1:${server.address.port}`;
  yield* Deferred.succeed(address, origin);
  return {
    origin,
    awaitRevocation: Queue.take(revoked),
    configure: (input: {
      subject?: string;
      profileFails?: boolean;
      denied?: boolean;
      expiresIn?: number;
      scopes?: string[];
    }) =>
      Effect.sync(() => {
        if (input.subject !== undefined) subject = input.subject;
        if (input.profileFails !== undefined) profileFails = input.profileFails;
        if (input.denied !== undefined) denied = input.denied;
        if (input.expiresIn !== undefined) expiresIn = input.expiresIn;
        confirmedScopes = input.scopes;
      }),
    metrics: Effect.sync(() => ({ authorizations, exchanges, refreshes, revocations })),
  };
});
