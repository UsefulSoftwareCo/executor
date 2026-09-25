/** Sandbox-only adapters exercising the running cloud product through public HTTP and MCP. */
import { Autumn } from "autumn-js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash, randomBytes } from "node:crypto";
import { Config, Context, Effect, Layer, Redacted, Schema, Ref } from "effect";
import { Cookies, FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

class BillingTestFailed extends Schema.TaggedError<BillingTestFailed>()("BillingTestFailed", {
  operation: Schema.String,
  status: Schema.Number,
}) {}
const use = <A>(operation: string, call: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: call, catch: () => new BillingTestFailed({ operation, status: 0 }) });
const json = <A>(schema: Schema.ConstraintDecoder<A, never>, text: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text);
const make = Effect.gen(function* () {
  const origin = yield* Config.String("BILLING_TEST_ORIGIN");
  const namespace = yield* Config.String("BILLING_TEST_NAMESPACE");
  const key = yield* Config.Redacted("AUTUMN_SECRET_KEY");
  if (
    !/^https:\/\/127\.0\.0\.1:\d+$/.test(origin) ||
    !namespace.startsWith("executor-next-billing-") ||
    !Redacted.value(key).startsWith("am_sk_test_")
  )
    return yield* Effect.die(
      "Billing verification requires an isolated loopback host and sandbox catalog",
    );
  const autumn = new Autumn({
    secretKey: Redacted.value(key),
    failOpen: false,
    retryConfig: { strategy: "none" },
  });
  const base = yield* HttpClient.HttpClient;
  const session = Effect.gen(function* () {
    const jar = yield* Ref.make(Cookies.empty);
    const client = base.pipe(HttpClient.withCookiesRef(jar));
    return (
      method: "GET" | "POST" | "DELETE",
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const url = new URL(path, origin);
          if (url.origin !== origin) return yield* Effect.die("Cross-origin test request rejected");
          let request = HttpClientRequest.make(method)(url, { headers: { origin, ...headers } });
          if (body !== undefined) request = yield* HttpClientRequest.bodyJson(request, body);
          const response = yield* client.execute(request);
          return {
            status: response.status,
            text: yield* response.text,
            location: response.headers.location,
          };
        }),
      ).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.timeout("60 seconds"),
        Effect.mapError(
          () =>
            new BillingTestFailed({
              operation: `${method} ${new URL(path, origin).pathname}`,
              status: 0,
            }),
        ),
      );
  });
  const owner = yield* session,
    member = yield* session,
    anonymous = yield* session;
  for (const [request, role] of [
    [owner, "owner"],
    [member, "member"],
  ] as const) {
    const response = yield* request("POST", "/api/devtools/account", { role });
    if (response.status !== 200)
      return yield* new BillingTestFailed({ operation: "test login", status: response.status });
  }
  const orgs = yield* owner("GET", "/api/auth/organization/list").pipe(
    Effect.flatMap((response) =>
      json(Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String })), response.text),
    ),
  );
  const organization = orgs.find((org) => org.slug === "agent-tests");
  if (!organization) return yield* Effect.die("Missing isolated test organization");
  const customerId = `${namespace}:organization:${organization.id}`;
  const executionBalance = use("read sandbox customer", (signal) =>
    autumn.customers.get({ customerId }, { signal }),
  ).pipe(Effect.map((customer) => customer.balances[`${namespace}-executions`]));
  const connectMcp = Effect.gen(function* () {
    const verifier = randomBytes(32).toString("base64url");
    const redirect = "http://127.0.0.1:55494/callback";
    const registration = yield* anonymous("POST", "/api/auth/oauth2/register", {
      client_name: "Billing verification",
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    const { client_id: clientId } = yield* json(
      Schema.Struct({ client_id: Schema.String }),
      registration.text,
    );
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const response = yield* owner("GET", "/api/auth/oauth2/get-consents");
        const consents = yield* json(
          Schema.Array(Schema.Struct({ id: Schema.String, clientId: Schema.String })),
          response.text,
        );
        for (const consent of consents.filter((item) => item.clientId === clientId))
          yield* owner("POST", "/api/auth/oauth2/delete-consent", { id: consent.id });
      }).pipe(Effect.orDie),
    );
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      scope: "mcp offline_access",
      resource: `${origin}/mcp`,
      state: randomBytes(16).toString("hex"),
    });
    const authorization = yield* owner("GET", `/api/auth/oauth2/authorize?${query}`);
    const location =
      authorization.location ??
      (yield* json(Schema.Struct({ url: Schema.String }), authorization.text)).url;
    const consent = yield* owner(
      "POST",
      "/api/auth/oauth2/consent",
      { accept: true, oauth_query: new URL(location, origin).search.slice(1) },
      { "x-executor-organization": organization.id },
    );
    if (consent.status !== 200)
      return yield* new BillingTestFailed({ operation: "OAuth consent", status: consent.status });
    const target = yield* json(Schema.Struct({ url: Schema.String }), consent.text);
    const code = new URL(target.url).searchParams.get("code");
    if (!code) return yield* Effect.die("Missing OAuth authorization code");
    const request = HttpClientRequest.post(`${origin}/api/auth/oauth2/token`).pipe(
      HttpClientRequest.bodyUrlParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirect,
        resource: `${origin}/mcp`,
      }),
    );
    const tokens = yield* Effect.scoped(
      base.execute(request).pipe(
        Effect.flatMap((response) => response.text),
        Effect.flatMap((text) => json(Schema.Struct({ access_token: Schema.String }), text)),
        Effect.map(Redacted.make),
      ),
    );
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => new Client({ name: "billing-verification", version: "1" })),
      (client) => use("close MCP", () => client.close()).pipe(Effect.orDie),
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${Redacted.value(tokens).access_token}` } },
    });
    const compatible: Omit<StreamableHTTPClientTransport, "sessionId"> = transport;
    yield* use("connect MCP", () => client.connect(compatible));
    return {
      call: (name: string, args: Record<string, unknown>) =>
        use(`MCP ${name}`, () => client.callTool({ name, arguments: args })),
    };
  });
  return {
    owner,
    member,
    anonymous,
    organization,
    namespace,
    executionBalance,
    connectMcp,
    json,
    seats: use("read sandbox seats", (signal) =>
      autumn.customers.get({ customerId }, { signal }),
    ).pipe(Effect.map((customer) => customer.balances[`${namespace}-members`]?.usage)),
  };
});
/** Each suite receives fresh HTTP sessions and an explicitly sandbox-only provider adapter. */
export class BillingTarget extends Context.Service<BillingTarget, Effect.Success<typeof make>>()(
  "e2e/BillingTarget",
) {
  static readonly layer = Layer.effect(BillingTarget, make).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
}
