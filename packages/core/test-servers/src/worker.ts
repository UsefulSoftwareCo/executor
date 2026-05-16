import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { createSchema, createYoga } from "graphql-yoga";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import z from "zod";

type ClientRecord = {
  readonly clientSecret: string | null;
  readonly redirectUris: ReadonlySet<string>;
};

type AuthorizationTransaction = {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly scope: string | null;
};

type AuthorizationCode = AuthorizationTransaction & {
  readonly username: string;
};

const clients = new Map<string, ClientRecord>([
  ["test-client", { clientSecret: "test-secret", redirectUris: new Set() }],
]);
const transactions = new Map<string, AuthorizationTransaction>();
const authorizationCodes = new Map<string, AuthorizationCode>();
const issuedAccessTokens = new Set<string>();

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

const text = (body: string, init?: ResponseInit) =>
  new Response(body, {
    ...init,
    headers: { "content-type": "text/plain; charset=utf-8", ...init?.headers },
  });

const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

const decodeBasic = (
  header: string | null,
): { readonly username: string; readonly password: string } | null => {
  if (!header?.startsWith("Basic ")) return null;
  const decoded = atob(header.slice("Basic ".length));
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
};

const base64url = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const codeChallengeForVerifier = async (verifier: string): Promise<string> =>
  base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));

const bearerToken = (request: Request): string | null => {
  const header = request.headers.get("authorization");
  return header?.replace(/^Bearer\s+/i, "") ?? null;
};

const isAuthorized = (request: Request): boolean => {
  const token = bearerToken(request);
  return token ? issuedAccessTokens.has(token) : false;
};

const unauthorized = (request: Request) => {
  const url = new URL(request.url);
  return json(
    { error: "invalid_token" },
    {
      status: 401,
      headers: {
        "www-authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource${url.pathname}", error="invalid_token"`,
      },
    },
  );
};

const oauthMetadata = (request: Request) => {
  const url = new URL(request.url);
  return json({
    issuer: url.origin,
    authorization_endpoint: `${url.origin}/authorize`,
    token_endpoint: `${url.origin}/token`,
    registration_endpoint: `${url.origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: ["read", "write"],
  });
};

const protectedResourceMetadata = (request: Request) => {
  const url = new URL(request.url);
  const suffix = url.pathname.slice("/.well-known/oauth-protected-resource".length);
  return json({
    resource: `${url.origin}${suffix}`,
    authorization_servers: [url.origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["read", "write"],
  });
};

const handleRegister = async (request: Request) => {
  const body = (await request.json()) as {
    readonly redirect_uris?: readonly string[];
    readonly token_endpoint_auth_method?: string;
  };
  const clientId = `client_${crypto.randomUUID()}`;
  const authMethod = body.token_endpoint_auth_method ?? "none";
  const clientSecret = authMethod === "none" ? null : `secret_${crypto.randomUUID()}`;
  clients.set(clientId, {
    clientSecret,
    redirectUris: new Set(body.redirect_uris ?? []),
  });
  return json(
    {
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      token_endpoint_auth_method: authMethod,
      redirect_uris: body.redirect_uris ?? [],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: "read write",
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
};

const handleAuthorize = (request: Request) => {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");
  const codeChallenge = url.searchParams.get("code_challenge");
  if (!clientId || !redirectUri || !state || !codeChallenge) {
    return json({ error: "invalid_request" }, { status: 400 });
  }
  const client = clients.get(clientId);
  if (client?.redirectUris.size && !client.redirectUris.has(redirectUri)) {
    return json(
      { error: "invalid_request", error_description: "redirect_uri is not registered" },
      { status: 400 },
    );
  }
  if (!client) {
    clients.set(clientId, { clientSecret: null, redirectUris: new Set([redirectUri]) });
  }
  const transaction = `txn_${crypto.randomUUID()}`;
  transactions.set(transaction, {
    clientId,
    redirectUri,
    state,
    codeChallenge,
    scope: url.searchParams.get("scope"),
  });
  return redirect(`${url.origin}/login?transaction=${encodeURIComponent(transaction)}`);
};

const handleLogin = async (request: Request) => {
  const url = new URL(request.url);
  const transactionId = url.searchParams.get("transaction");
  const transaction = transactionId ? transactions.get(transactionId) : undefined;
  if (!transactionId || !transaction) return json({ error: "invalid_request" }, { status: 400 });
  if (request.method === "GET") return text("OAuth test login");

  const basic = decodeBasic(request.headers.get("authorization"));
  if (!basic || basic.username !== "alice" || basic.password !== "password") {
    return json(
      { error: "access_denied" },
      { status: 401, headers: { "www-authenticate": 'Basic realm="Executor test servers"' } },
    );
  }
  const code = `code_${crypto.randomUUID()}`;
  transactions.delete(transactionId);
  authorizationCodes.set(code, { ...transaction, username: basic.username });
  const callback = new URL(transaction.redirectUri);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", transaction.state);
  return redirect(callback.toString());
};

const handleToken = async (request: Request) => {
  const params = new URLSearchParams(await request.text());
  const basic = decodeBasic(request.headers.get("authorization"));
  const clientId = basic?.username ?? params.get("client_id");
  const clientSecret = basic?.password ?? params.get("client_secret");
  const client = clientId ? clients.get(clientId) : undefined;
  if (!clientId || !client) return json({ error: "invalid_client" }, { status: 401 });
  if (client.clientSecret !== null && client.clientSecret !== clientSecret) {
    return json({ error: "invalid_client" }, { status: 401 });
  }
  const code = params.get("code");
  const redirectUri = params.get("redirect_uri");
  const verifier = params.get("code_verifier");
  const record = code ? authorizationCodes.get(code) : undefined;
  if (!code || !redirectUri || !verifier || !record) {
    return json({ error: "invalid_grant" }, { status: 400 });
  }
  if (
    record.clientId !== clientId ||
    record.redirectUri !== redirectUri ||
    record.codeChallenge !== (await codeChallengeForVerifier(verifier))
  ) {
    return json({ error: "invalid_grant" }, { status: 400 });
  }
  authorizationCodes.delete(code);
  const accessToken = `at_${crypto.randomUUID()}`;
  const refreshToken = `rt_${crypto.randomUUID()}`;
  issuedAccessTokens.add(accessToken);
  return json(
    {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: 3600,
      ...(record.scope ? { scope: record.scope } : {}),
    },
    { headers: { "cache-control": "no-store" } },
  );
};

const OpenApiEchoItem = Schema.Struct({ id: Schema.Number, name: Schema.String });
const OpenApiEchoItemsGroup = HttpApiGroup.make("items").add(
  HttpApiEndpoint.get("listItems", "/items", { success: Schema.Array(OpenApiEchoItem) }),
);
const OpenApiEchoApi = HttpApi.make("executorOpenApiWorkerTest")
  .add(OpenApiEchoItemsGroup)
  .annotateMerge(
    OpenApi.annotations({ title: "Executor Worker OpenAPI Test Server", version: "1.0.0" }),
  );

const openApiSpec = (request: Request) => {
  const url = new URL(request.url);
  const apiBaseUrl = `${url.origin}/openapi`;
  const spec = OpenApi.fromApi(
    (OpenApiEchoApi as HttpApi.AnyWithProps).annotateMerge(
      OpenApi.annotations({
        servers: [{ url: apiBaseUrl }],
        transform: (source) => ({
          ...source,
          components: {
            ...(typeof source.components === "object" && source.components !== null
              ? source.components
              : {}),
            securitySchemes: {
              oauth2: {
                type: "oauth2",
                flows: {
                  authorizationCode: {
                    authorizationUrl: `${url.origin}/authorize`,
                    tokenUrl: `${url.origin}/token`,
                    scopes: { read: "Read test resources" },
                  },
                },
              },
            },
          },
          security: [{ oauth2: ["read"] }],
        }),
      }),
    ),
  );
  return json(spec);
};

const handleOpenApi = (request: Request) => {
  const url = new URL(request.url);
  if (url.pathname === "/openapi/spec.json") return openApiSpec(request);
  if (!isAuthorized(request)) return unauthorized(request);
  if (url.pathname === "/openapi/items") {
    return json([
      { id: 1, name: "Widget" },
      { id: 2, name: "Gadget" },
    ]);
  }
  return json({ error: "not_found" }, { status: 404 });
};

const yoga = createYoga({
  schema: createSchema({
    typeDefs: /* GraphQL */ `
      type Query {
        hello(name: String): String
      }

      type Mutation {
        setGreeting(message: String!): String
      }
    `,
    resolvers: {
      Query: {
        hello: (_source: unknown, args: { readonly name?: string }) =>
          `Hello ${args.name ?? "world"}`,
      },
      Mutation: {
        setGreeting: (_source: unknown, args: { readonly message: string }) => args.message,
      },
    },
  }),
  graphqlEndpoint: "/graphql",
  graphiql: false,
  logging: false,
  maskedErrors: false,
});

const handleGraphql = (request: Request) =>
  isAuthorized(request) ? yoga.handle(request, {}) : unauthorized(request);

const createMcpServer = () => {
  const server = new McpServer(
    { name: "executor-worker-mcp-test", version: "1.0.0" },
    { capabilities: {} },
  );
  server.registerTool(
    "hello",
    { description: "Greets a person", inputSchema: { name: z.string() } },
    async ({ name }: { readonly name: string }) => ({
      content: [{ type: "text" as const, text: `Hello ${name}` }],
    }),
  );
  return server;
};

const mcpTransports = new Map<string, WebStandardStreamableHTTPServerTransport>();

const handleMcp = async (request: Request) => {
  if (!isAuthorized(request)) return unauthorized(request);
  const sessionId = request.headers.get("mcp-session-id") ?? undefined;
  const existing = sessionId ? mcpTransports.get(sessionId) : undefined;
  if (sessionId && !existing) return text("Session not found", { status: 404 });
  if (existing) return existing.handleRequest(request);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sid) => {
      mcpTransports.set(sid, transport);
    },
  });
  await createMcpServer().connect(transport);
  return transport.handleRequest(request);
};

const handleRequest = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === "/health") return json({ ok: true });
  if (
    url.pathname === "/.well-known/oauth-authorization-server" ||
    url.pathname === "/.well-known/openid-configuration"
  ) {
    return oauthMetadata(request);
  }
  if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
    return protectedResourceMetadata(request);
  }
  if (url.pathname === "/register" && request.method === "POST") return handleRegister(request);
  if (url.pathname === "/authorize" && request.method === "GET") return handleAuthorize(request);
  if (url.pathname === "/login") return handleLogin(request);
  if (url.pathname === "/token" && request.method === "POST") return handleToken(request);
  if (url.pathname.startsWith("/openapi/")) return handleOpenApi(request);
  if (url.pathname === "/graphql") return handleGraphql(request);
  if (url.pathname === "/mcp") return handleMcp(request);
  return json({ error: "not_found" }, { status: 404 });
};

export default {
  fetch: handleRequest,
};
