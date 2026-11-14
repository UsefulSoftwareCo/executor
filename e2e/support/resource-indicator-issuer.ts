/**
 * A loopback API whose authorization server binds every token to an RFC 8707 resource indicator.
 * Its protected-resource metadata, at the origin's root, names the origin as the resource, but the
 * server knows only the resources it was configured with:
 * - `refuses-unknown`: the token endpoint refuses any other resource, or none, with
 *   `invalid_target`, as a server does whose metadata names a resource it no longer serves.
 * - `binds-audience`: the token endpoint issues a token for whatever resource was asked for, and
 *   the API answers 401 `invalid_token` to a token issued for any resource but its own.
 * Executor still uses its real discovery, registration, callback and token paths against it.
 * Without `metadata` it publishes no protected-resource metadata, so nothing names a resource.
 * With `scopeAudienceClaim` its authorization server's metadata looks like Microsoft identity
 * platform v2.0's (a `/v2.0` issuer with `cloud_instance_name`), which Executor reads as taking the
 * audience from the scopes, although this server still requires its resource.
 * `refuseWith` changes the status and Retry-After of its `invalid_target` answer, and `addClient`
 * accepts a client registered by hand, such as an operator's.
 */
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { tokenRequestParameters } from "./client-credentials-issuer.ts";

export type ResourceIndicatorService = "refuses-unknown" | "binds-audience";

const Registration = Schema.Struct({
  redirect_uris: Schema.Array(Schema.String),
  token_endpoint_auth_method: Schema.String,
});

/** The description such a server gives with `invalid_target`. */
export const unknownResourceDescription = "resource indicator is missing, or unknown";

/** How the token endpoint answers a resource it does not know: a 400 unless changed. */
export interface ResourceRefusal {
  readonly status: number;
  readonly retryAfter?: string;
}

export const resourceIndicatorIssuer = (
  service: ResourceIndicatorService,
  options: { readonly metadata?: boolean; readonly scopeAudienceClaim?: boolean } = {},
) =>
  Effect.gen(function* () {
    let refusal: ResourceRefusal = { status: 400 };
    const address = yield* Deferred.make<string>();
    const clients = new Map<string, string>();
    const codes = new Map<
      string,
      { clientId: string; redirect: string; challenge: string; resource: string | null }
    >();
    /** Tokens issued, by the resource each is for. */
    const audiences = new Map<string, string | null>();
    const refreshGrants = new Map<string, { clientId: string; resource: string | null }>();
    const authorizations: Array<{ readonly resource: string | null }> = [];
    const tokenRequests: Array<{
      readonly grant: string | null;
      readonly resource: string | null;
      readonly issued: boolean;
    }> = [];
    const apiRequests: Array<{ readonly audience: string | null; readonly accepted: boolean }> = [];
    /** The API's own resource identifier, which its metadata does not name. */
    const apiResource = Effect.map(Deferred.await(address), (origin) => `${origin}/api`);
    const known = (resource: string | null) => Effect.map(apiResource, (api) => resource === api);
    /** The authorization server's issuer path, which RFC 8414 inserts after the well-known name. */
    const issuerPath = options.scopeAudienceClaim === true ? "/v2.0" : "";

    const issue = (clientId: string, resource: string | null) => {
      const accessToken = `synthetic-access-${randomUUID()}`;
      const refreshToken = `synthetic-refresh-${randomUUID()}`;
      audiences.set(accessToken, resource);
      refreshGrants.set(refreshToken, { clientId, resource });
      return HttpServerResponse.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: refreshToken,
        scope: "read",
      });
    };

    const routes = Layer.mergeAll(
      // Requests without credentials are answered: a client finds the resource's metadata itself.
      HttpRouter.add("GET", "/", Effect.succeed(HttpServerResponse.empty({ status: 200 }))),
      HttpRouter.add(
        "GET",
        "/.well-known/oauth-protected-resource",
        Effect.gen(function* () {
          if (options.metadata === false) return HttpServerResponse.empty({ status: 404 });
          const origin = yield* Deferred.await(address);
          return yield* HttpServerResponse.json({
            resource: origin,
            authorization_servers: [`${origin}${issuerPath}`],
            scopes_supported: ["read"],
          });
        }),
      ),
      HttpRouter.add(
        "GET",
        `/.well-known/oauth-authorization-server${issuerPath}`,
        Effect.gen(function* () {
          const origin = yield* Deferred.await(address);
          return yield* HttpServerResponse.json({
            issuer: `${origin}${issuerPath}`,
            ...(options.scopeAudienceClaim === true
              ? { cloud_instance_name: "synthetic.invalid" }
              : {}),
            registration_endpoint: `${origin}/register`,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["client_secret_basic"],
            code_challenge_methods_supported: ["S256"],
            scopes_supported: ["read"],
          });
        }),
      ),
      HttpRouter.add(
        "POST",
        "/register",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const input = yield* request.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Registration)),
          );
          const clientId = `synthetic-client-${clients.size + 1}`;
          clients.set(clientId, "synthetic-client-secret");
          return yield* HttpServerResponse.json(
            {
              client_id: clientId,
              client_secret: "synthetic-client-secret",
              client_secret_expires_at: 0,
              token_endpoint_auth_method: input.token_endpoint_auth_method,
              redirect_uris: input.redirect_uris,
              grant_types: ["authorization_code", "refresh_token"],
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
          const params = new URL(request.url, "http://localhost").searchParams;
          const clientId = params.get("client_id"),
            redirect = params.get("redirect_uri"),
            challenge = params.get("code_challenge");
          if (
            clientId === null ||
            redirect === null ||
            challenge === null ||
            params.get("code_challenge_method") !== "S256" ||
            !clients.has(clientId)
          )
            return HttpServerResponse.empty({ status: 400 });
          const resource = params.get("resource");
          authorizations.push({ resource });
          const code = `synthetic-code-${randomUUID()}`;
          codes.set(code, { clientId, redirect, challenge, resource });
          const callback = new URL(redirect);
          callback.searchParams.set("code", code);
          const state = params.get("state");
          if (state !== null) callback.searchParams.set("state", state);
          return HttpServerResponse.redirect(callback.href, { status: 302 });
        }),
      ),
      HttpRouter.add(
        "POST",
        "/token",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const input = tokenRequestParameters(
            request.headers["content-type"],
            yield* request.text,
          );
          const authorization = request.headers.authorization;
          const [clientId, secret] = authorization?.startsWith("Basic ")
            ? Buffer.from(authorization.slice(6), "base64")
                .toString("utf8")
                .split(":")
                .map((part) => decodeURIComponent(part))
            : [undefined, undefined];
          const grant = input.get("grant_type");
          const resource = input.get("resource");
          const refuse = (
            error: string,
            description?: string,
            answer: ResourceRefusal = { status: 400 },
          ) =>
            Effect.gen(function* () {
              tokenRequests.push({ grant, resource, issued: false });
              return yield* HttpServerResponse.json(
                { error, ...(description === undefined ? {} : { error_description: description }) },
                {
                  status: answer.status,
                  ...(answer.retryAfter === undefined
                    ? {}
                    : { headers: { "retry-after": answer.retryAfter } }),
                },
              );
            });
          if (clientId === undefined || clients.get(clientId) !== secret)
            return yield* refuse("invalid_client");
          // An unknown resource is refused before the grant is looked at, on every grant type.
          if (service === "refuses-unknown" && !(yield* known(resource)))
            return yield* refuse("invalid_target", unknownResourceDescription, refusal);
          if (grant === "refresh_token") {
            const presented = input.get("refresh_token");
            const held = presented === null ? undefined : refreshGrants.get(presented);
            if (held === undefined || held.clientId !== clientId)
              return yield* refuse("invalid_grant");
            tokenRequests.push({ grant, resource, issued: true });
            return yield* issue(clientId, resource);
          }
          const code = input.get("code");
          const issued = code === null ? undefined : codes.get(code);
          const verifier = input.get("code_verifier");
          if (
            code === null ||
            issued === undefined ||
            grant !== "authorization_code" ||
            issued.clientId !== clientId ||
            input.get("redirect_uri") !== issued.redirect ||
            verifier === null ||
            createHash("sha256").update(verifier).digest("base64url") !== issued.challenge
          )
            return yield* refuse("invalid_grant");
          // RFC 8707 §2.2: the token request names the resource the authorization request did.
          if (resource !== issued.resource) return yield* refuse("invalid_target");
          codes.delete(code);
          tokenRequests.push({ grant, resource, issued: true });
          return yield* issue(clientId, resource);
        }),
      ),
      HttpRouter.add(
        "GET",
        "/api",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
          const audience = audiences.get(token) ?? null;
          const accepted = audiences.has(token) && (yield* known(audience));
          apiRequests.push({ audience, accepted });
          return accepted
            ? yield* HttpServerResponse.json({ ok: true })
            : HttpServerResponse.empty({
                status: 401,
                headers: { "www-authenticate": 'Bearer error="invalid_token"' },
              });
        }),
      ),
    );
    const listener = yield* Effect.sync(() => createServer());
    const services = yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(() => listener, { host: "127.0.0.1", port: 0 })),
      ),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => listener.closeAllConnections()));
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address)) return yield* Effect.die("OAuth fixture needs a TCP listener");
    const origin = `http://127.0.0.1:${server.address.port}`;
    yield* Deferred.succeed(address, origin);
    return {
      origin,
      /** The resource the API accepts tokens for; its metadata names `origin` instead. */
      apiResource: `${origin}/api`,
      refuseWith: (answer: ResourceRefusal) =>
        Effect.sync(() => {
          refusal = answer;
        }),
      addClient: (clientId: string, secret: string) =>
        Effect.sync(() => {
          clients.set(clientId, secret);
        }),
      metrics: Effect.sync(() => ({
        authorizations: [...authorizations],
        tokenRequests: [...tokenRequests],
        apiRequests: [...apiRequests],
      })),
    };
  });
