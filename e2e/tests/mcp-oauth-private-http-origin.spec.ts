/**
 * MCP OAuth at a self-host served over plain HTTP on a private network address, as an install on
 * a LAN without TLS or a proxy is. RFC 8414 and RFC 9207 make the issuer an exact identifier: the
 * resource's authorization server, the server's metadata, the authorization response and the
 * issued token must all name it, scheme included, or a strict client refuses the connection.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { Api, body, SessionClients } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { startFreshSelfHost } from "../support/managed-server.ts";
import { driver, Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

/**
 * The private address the operator configured. Nothing listens there: every request the client
 * makes to it reaches the product's loopback listener, as a LAN route to the host would.
 */
const lanOrigin = "http://192.168.50.10:4788";
const issuer = `${lanOrigin}/api/auth`;

const Organizations = Schema.NonEmptyArray(Schema.Struct({ id: Schema.String }));
const ResourceMetadata = Schema.Struct({
  resource: Schema.String,
  authorization_servers: Schema.Array(Schema.String),
});
const ServerMetadata = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.String,
  authorization_response_iss_parameter_supported: Schema.Boolean,
});
const Redirect = Schema.Struct({ redirect: Schema.Literal(true), url: Schema.String });
const Consent = Schema.Struct({ url: Schema.String });
const Introspection = Schema.Struct({ active: Schema.Boolean, iss: Schema.String });
type OAuthClientProvider = NonNullable<
  NonNullable<ConstructorParameters<typeof StreamableHTTPClientTransport>[1]>["authProvider"]
>;
const json = <A>(schema: Schema.Decoder<A>, operation: string, response: globalThis.Response) =>
  driver(operation, () => response.json()).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)));

layer(TestLive, { excludeTestServices: true })("MCP OAuth at a private HTTP origin", (it) => {
  it.effect(scenarios.mcpOAuthPrivateHttpOrigin.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        const origin = yield* startFreshSelfHost(target, {
          BETTER_AUTH_URL: lanOrigin,
          EXECUTOR_URL_ALLOW_HTTP_ORIGINS: JSON.stringify([lanOrigin]),
        });
        /** The client's network: the LAN address resolves to this host's loopback listener. */
        const lan: typeof fetch = (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          const routed = url.startsWith(lanOrigin) ? origin + url.slice(lanOrigin.length) : url;
          return fetch(input instanceof Request ? new Request(routed, input) : routed, init);
        };
        const get = (path: string) => driver(`GET ${path}`, () => lan(`${lanOrigin}${path}`));

        // The resource names its authorization server, and that server's metadata names itself.
        const resource = yield* get("/.well-known/oauth-protected-resource/mcp");
        expect(resource.status).toBe(200);
        expect(yield* json(ResourceMetadata, "read resource metadata", resource)).toEqual({
          resource: `${lanOrigin}/mcp`,
          authorization_servers: [issuer],
        });
        const server = yield* get("/.well-known/oauth-authorization-server/api/auth");
        expect(server.status).toBe(200);
        expect(yield* json(ServerMetadata, "read server metadata", server)).toMatchObject({
          issuer,
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          token_endpoint: `${issuer}/oauth2/token`,
          registration_endpoint: `${issuer}/oauth2/register`,
          authorization_response_iss_parameter_supported: true,
        });

        const api = yield* Api.pipe(
          Effect.provide(Layer.fresh(Api.layer)),
          Effect.provide(Layer.fresh(SessionClients.layer)),
          Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
        );
        const owner = yield* api.session();
        const request = (path: string, data: unknown, headers: Record<string, string> = {}) =>
          api.request(owner, "POST", path, data, { origin: lanOrigin, ...headers });
        expect(
          (yield* request("/api/auth/self-host/setup", {
            name: "LAN Owner",
            email: "lan-owner@example.test",
            password: "Synthetic-lan-password-123!",
            organizationName: "LAN lab",
          })).status,
        ).toBe(200);
        const [organization] = yield* body(
          Organizations,
          yield* api.request(owner, "GET", "/api/auth/organization/list", undefined, {
            origin: lanOrigin,
          }),
        );

        // The MCP SDK's own OAuth client: discovery, registration, PKCE, code exchange.
        let registered: Awaited<ReturnType<OAuthClientProvider["clientInformation"]>>;
        let tokens: Awaited<ReturnType<OAuthClientProvider["tokens"]>>;
        let verifier = "";
        let authorization: URL | undefined;
        const redirectUrl = "http://127.0.0.1:9/callback";
        const provider: OAuthClientProvider = {
          redirectUrl,
          clientMetadata: {
            client_name: "LAN client",
            redirect_uris: [redirectUrl],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            // A confidential client may introspect its own token, which shows the token's issuer.
            token_endpoint_auth_method: "client_secret_post",
          },
          clientInformation: () => registered,
          saveClientInformation: (information) => void (registered = information),
          tokens: () => tokens,
          saveTokens: (saved) => void (tokens = saved),
          redirectToAuthorization: (url) => void (authorization = url),
          saveCodeVerifier: (saved) => void (verifier = saved),
          codeVerifier: () => verifier,
        };
        const serverUrl = new URL(`${lanOrigin}/mcp`);
        const transport = () => {
          const created = new StreamableHTTPClientTransport(serverUrl, {
            authProvider: provider,
            fetch: lan,
          });
          // SDK's optional sessionId getter includes undefined; its Transport declaration omits it.
          const compatible: Omit<StreamableHTTPClientTransport, "sessionId"> = created;
          return { created, compatible };
        };
        // Unauthorized, the client discovers the server, registers and asks to authorize.
        const signIn = transport();
        const refused = yield* driver("connect before authorizing", () =>
          new Client({ name: "LAN client", version: "1.0.0" }).connect(signIn.compatible),
        ).pipe(Effect.flip);
        expect(refused._tag).toBe("DriverFailed");
        if (authorization === undefined) return yield* Effect.die("No authorization request");
        expect(`${authorization.origin}${authorization.pathname}`).toBe(
          `${issuer}/oauth2/authorize`,
        );

        // The signed-in owner reaches consent and approves it for their organization.
        const cookie = Redacted.value(yield* owner.cookies)
          .map(({ name, value }) => `${name}=${value}`)
          .join("; ");
        // Node's fetch always states `sec-fetch-mode: cors`, so Better Auth answers with the
        // redirect's target in JSON, as it does a page script, instead of a 302.
        const authorize = yield* driver("open authorization", () =>
          lan(authorization!.href, { headers: { cookie }, redirect: "manual" }),
        );
        expect(authorize.status).toBe(200);
        const redirect = yield* json(Redirect, "read authorization redirect", authorize);
        const consentPage = new URL(redirect.url, lanOrigin);
        expect(consentPage.pathname).toBe("/mcp/authorize");
        const consent = yield* request(
          "/api/auth/oauth2/consent",
          { accept: true, oauth_query: consentPage.search.slice(1) },
          { "x-executor-organization": organization.id },
        );
        expect(consent.status).toBe(200);
        const callback = new URL((yield* body(Consent, consent)).url);
        expect(`${callback.origin}${callback.pathname}`).toBe(redirectUrl);
        // RFC 9207: the authorization response names the same issuer the metadata does.
        expect(callback.searchParams.get("iss")).toBe(issuer);
        const code = callback.searchParams.get("code");
        if (code === null) return yield* Effect.die("No authorization code");
        yield* driver("exchange the code", () => signIn.created.finishAuth(code));

        // The issued token names the same issuer.
        const introspected = yield* driver("introspect the token", () =>
          lan(`${issuer}/oauth2/introspect`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              token: tokens!.access_token,
              token_type_hint: "access_token",
              client_id: registered!.client_id,
              client_secret: registered!.client_secret ?? "",
            }),
          }),
        );
        expect(introspected.status).toBe(200);
        expect(yield* json(Introspection, "read introspection", introspected)).toEqual({
          active: true,
          iss: issuer,
        });

        // The token opens an MCP session at the LAN address.
        const client = new Client({ name: "LAN client", version: "1.0.0" });
        yield* Effect.acquireRelease(
          driver("connect MCP", () => client.connect(transport().compatible)),
          () => driver("close MCP", () => client.close()).pipe(Effect.orDie),
        );
        const listed = yield* driver("list tools", () => client.listTools());
        expect(listed.tools.map((tool) => tool.name)).toContain("execute");
      }),
    ),
  );
});
