import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import worker from "./worker";

const origin = "https://executor-test-servers.example";

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
});
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);

const OpenApiItemsResponse = Schema.Array(
  Schema.Struct({ id: Schema.Number, name: Schema.String }),
);
const decodeOpenApiItemsResponse = Schema.decodeUnknownEffect(OpenApiItemsResponse);

const OpenApiSpecResponse = Schema.Struct({
  openapi: Schema.String,
  servers: Schema.Array(Schema.Struct({ url: Schema.String })),
  paths: Schema.Record(Schema.String, Schema.Unknown),
  components: Schema.Struct({
    securitySchemes: Schema.Struct({
      oauth2: Schema.Struct({
        type: Schema.Literal("oauth2"),
        flows: Schema.Struct({
          authorizationCode: Schema.Struct({
            authorizationUrl: Schema.String,
            tokenUrl: Schema.String,
            scopes: Schema.Record(Schema.String, Schema.String),
          }),
        }),
      }),
    }),
  }),
});
const decodeOpenApiSpecResponse = Schema.decodeUnknownEffect(OpenApiSpecResponse);

const OAuthMetadataResponse = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.String,
  code_challenge_methods_supported: Schema.Array(Schema.String),
});
const decodeOAuthMetadataResponse = Schema.decodeUnknownEffect(OAuthMetadataResponse);

const ProtectedResourceMetadataResponse = Schema.Struct({
  resource: Schema.String,
  authorization_servers: Schema.Array(Schema.String),
  bearer_methods_supported: Schema.Array(Schema.String),
  scopes_supported: Schema.Array(Schema.String),
});
const decodeProtectedResourceMetadataResponse = Schema.decodeUnknownEffect(
  ProtectedResourceMetadataResponse,
);

const GraphqlResponse = Schema.Struct({
  data: Schema.Struct({ hello: Schema.String }),
});
const decodeGraphqlResponse = Schema.decodeUnknownEffect(GraphqlResponse);

const request = (path: string, init?: RequestInit) => new Request(`${origin}${path}`, init);

const workerFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const nextRequest =
    input instanceof Request ? new Request(input, init) : new Request(input, init);
  return worker.fetch(nextRequest);
};

const base64url = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const codeChallengeForVerifier = (verifier: string): Promise<string> =>
  crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then(base64url);

const authorize = Effect.gen(function* () {
  const redirectUrl = `${origin}/callback`;
  const verifier = `verifier_${crypto.randomUUID()}`;
  const authorizationUrl = new URL(`${origin}/authorize`);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", "test-client");
  authorizationUrl.searchParams.set("redirect_uri", redirectUrl);
  authorizationUrl.searchParams.set("state", "state");
  authorizationUrl.searchParams.set("scope", "read");
  authorizationUrl.searchParams.set(
    "code_challenge",
    yield* Effect.promise(() => codeChallengeForVerifier(verifier)),
  );
  authorizationUrl.searchParams.set("code_challenge_method", "S256");

  const loginRedirect = yield* Effect.promise(() => worker.fetch(new Request(authorizationUrl)));
  const loginUrl = loginRedirect.headers.get("location");
  expect(loginRedirect.status).toBe(302);
  expect(loginUrl).not.toBeNull();

  const callbackRedirect = yield* Effect.promise(() =>
    worker.fetch(
      new Request(new URL(loginUrl ?? "", origin), {
        method: "POST",
        headers: { authorization: `Basic ${btoa("alice:password")}` },
      }),
    ),
  );
  const callbackUrl = callbackRedirect.headers.get("location");
  expect(callbackRedirect.status).toBe(302);
  expect(callbackUrl).not.toBeNull();

  const code = new URL(callbackUrl ?? "").searchParams.get("code");
  expect(code).not.toBeNull();

  const tokenResponse = yield* Effect.promise(() =>
    worker.fetch(
      request("/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: "test-client",
          client_secret: "test-secret",
          redirect_uri: redirectUrl,
          code: code ?? "",
          code_verifier: verifier,
        }),
      }),
    ),
  );
  expect(tokenResponse.status).toBe(200);
  const tokenBody = yield* Effect.promise(() => tokenResponse.json()).pipe(
    Effect.flatMap(decodeTokenResponse),
  );
  return tokenBody.access_token;
});

it.effect("worker exposes OAuth-protected OpenAPI, GraphQL, and MCP endpoints", () =>
  Effect.gen(function* () {
    const oauthMetadataResponse = yield* Effect.promise(() =>
      worker.fetch(request("/.well-known/oauth-authorization-server")),
    );
    const oauthMetadata = yield* Effect.promise(() => oauthMetadataResponse.json()).pipe(
      Effect.flatMap(decodeOAuthMetadataResponse),
    );
    expect(oauthMetadata).toMatchObject({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
    });
    expect(oauthMetadata.code_challenge_methods_supported).toContain("S256");

    const resourceMetadataResponse = yield* Effect.promise(() =>
      worker.fetch(request("/.well-known/oauth-protected-resource/openapi/items")),
    );
    const resourceMetadata = yield* Effect.promise(() => resourceMetadataResponse.json()).pipe(
      Effect.flatMap(decodeProtectedResourceMetadataResponse),
    );
    expect(resourceMetadata).toEqual({
      resource: `${origin}/openapi/items`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: ["read", "write"],
    });

    const openApiSpecResponse = yield* Effect.promise(() =>
      worker.fetch(request("/openapi/spec.json")),
    );
    const openApiSpec = yield* Effect.promise(() => openApiSpecResponse.json()).pipe(
      Effect.flatMap(decodeOpenApiSpecResponse),
    );
    expect(openApiSpec.servers).toEqual([{ url: `${origin}/openapi` }]);
    expect(openApiSpec.paths).toHaveProperty("/items");
    expect(openApiSpec.components.securitySchemes.oauth2.flows.authorizationCode).toMatchObject({
      authorizationUrl: `${origin}/authorize`,
      tokenUrl: `${origin}/token`,
      scopes: { read: "Read test resources" },
    });

    const accessToken = yield* authorize;

    const openApiResponse = yield* Effect.promise(() =>
      worker.fetch(
        request("/openapi/items", { headers: { authorization: `Bearer ${accessToken}` } }),
      ),
    );
    const items = yield* Effect.promise(() => openApiResponse.json()).pipe(
      Effect.flatMap(decodeOpenApiItemsResponse),
    );
    expect(items).toEqual([
      { id: 1, name: "Widget" },
      { id: 2, name: "Gadget" },
    ]);

    const graphqlResponse = yield* Effect.promise(() =>
      worker.fetch(
        request("/graphql", {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ query: '{ hello(name: "Ada") }' }),
        }),
      ),
    );
    const graphqlBody = yield* Effect.promise(() => graphqlResponse.json()).pipe(
      Effect.flatMap(decodeGraphqlResponse),
    );
    expect(graphqlBody).toEqual({ data: { hello: "Hello Ada" } });

    const client = new Client({ name: "executor-worker-test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      fetch: workerFetch,
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    });
    yield* Effect.tryPromise(() => client.connect(transport));
    const tools = yield* Effect.tryPromise(() => client.listTools());
    const result = yield* Effect.tryPromise(() =>
      client.callTool({ name: "hello", arguments: { name: "Ada" } }),
    );
    yield* Effect.promise(() => client.close());

    expect(tools.tools.map((tool) => tool.name)).toEqual(["hello"]);
    expect(result).toMatchObject({ content: [{ type: "text", text: "Hello Ada" }] });
  }),
);
