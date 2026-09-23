/** OAuth runs through the public server and recorded consent UI. Tokens stay private. */
import { createServer } from "node:http";
import type { Page } from "playwright";
import { createHash, randomBytes } from "node:crypto";
import { Context, Deferred, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { Api, body } from "./api.ts";
import { Actors } from "./actors.ts";
import { Browser } from "./browser.ts";
import { Evidence } from "./evidence.ts";
import { Target, driver } from "./platform.ts";

const Tokens = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  token_type: Schema.String,
});
/** A real OAuth grant; credentials cannot appear in assertion diagnostics. */
export interface Grant {
  readonly clientId: string;
  readonly grantId: string;
  readonly resource: string;
  readonly consentId: string;
  readonly tokens: Redacted.Redacted<typeof Tokens.Type>;
}
class OAuthFailed extends Schema.TaggedError<OAuthFailed>()("OAuthFailed", {
  operation: Schema.String,
  status: Schema.Number,
}) {
  get message() {
    return `OAuth ${this.operation} failed (HTTP ${this.status})`;
  }
}
const Consents = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    clientId: Schema.String,
    referenceId: Schema.NullOr(Schema.String),
  }),
);
const Grants = Schema.Array(
  Schema.Struct({
    clientId: Schema.NonEmptyString,
    resource: Schema.NonEmptyString,
    grant: Schema.Struct({ id: Schema.NonEmptyString }),
  }),
);
const ok = (operation: string, status: number) =>
  status >= 200 && status < 300 ? Effect.void : Effect.fail(new OAuthFailed({ operation, status }));

// This is the client's loopback receiver, not an alternate Executor implementation.
const callback = (state: string) =>
  Effect.gen(function* () {
    const received = yield* Deferred.make<Redacted.Redacted<string>>();
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        createServer((request, response) => {
          const url = new URL(request.url ?? "/", "http://127.0.0.1");
          const code = url.searchParams.get("code");
          const valid =
            url.pathname === "/callback" && url.searchParams.get("state") === state && code;
          response.writeHead(valid ? 200 : 400, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            connection: "close",
          });
          response.end(
            valid
              ? "<h1>Connected to Executor</h1><p>You can return to your MCP client.</p>"
              : "<h1>Authorization was not completed</h1>",
          );
          if (valid) Effect.runSync(Deferred.succeed(received, Redacted.make(code)));
        }),
      ),
      (server) =>
        driver(
          "close OAuth callback",
          () =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ).pipe(Effect.orDie),
    );
    const port = yield* driver(
      "listen for OAuth callback",
      () =>
        new Promise<number>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") reject(new Error("Missing callback port"));
            else resolve(address.port);
          });
        }),
    );
    return {
      url: `http://127.0.0.1:${port}/callback`,
      code: Deferred.await(received).pipe(Effect.timeout("30 seconds")),
    };
  });

/** Authorize the official MCP client through a signed-in browser, without an API key. */
export const authorizeBrowserMcp = (page: Page, origin: string) =>
  Effect.gen(function* () {
    const state = randomBytes(24).toString("hex");
    const verifier = randomBytes(32).toString("base64url");
    const receiver = yield* callback(state);
    const registration = yield* driver("register release MCP client", () =>
      fetch(`${origin}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Release verification",
          redirect_uris: [receiver.url],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      }),
    );
    if (registration.status !== 201)
      return yield* new OAuthFailed({
        operation: "register",
        status: registration.status,
      });
    const { client_id } = yield* driver("read MCP client registration", () =>
      registration.json(),
    ).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Struct({ client_id: Schema.NonEmptyString })),
      ),
    );
    const resource = `${origin}/mcp`;
    const authorization = new URL(`${origin}/api/auth/oauth2/authorize`);
    authorization.search = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: receiver.url,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      scope: "mcp offline_access",
      resource,
      state,
    }).toString();
    yield* driver("open release MCP consent", () => page.goto(authorization.href));
    yield* driver("verify the requesting MCP client", () =>
      page.getByText("Release verification", { exact: true }).waitFor({ state: "visible" }),
    );
    yield* driver("approve release MCP connection", () =>
      page.getByRole("button", { name: "Connect", exact: true }).click(),
    );
    const code = yield* receiver.code;
    yield* driver("OAuth returns to the MCP client", () =>
      page.getByRole("heading", { name: "Connected to Executor" }).waitFor({ state: "visible" }),
    );
    const response = yield* driver("exchange release MCP code", () =>
      fetch(`${origin}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id,
          code: Redacted.value(code),
          code_verifier: verifier,
          redirect_uri: receiver.url,
          resource,
        }),
      }),
    );
    if (response.status !== 200)
      return yield* new OAuthFailed({ operation: "token", status: response.status });
    const tokens = yield* driver("read release MCP token", () => response.json()).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Struct({
            access_token: Schema.RedactedFromValue(Schema.NonEmptyString),
          }),
        ),
      ),
    );
    return tokens.access_token;
  });

const make = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    browser = yield* Browser;
  const target = yield* Target,
    http = yield* HttpClient.HttpClient,
    evidence = yield* Evidence;
  const origin = target.metadata.origin;
  const exchange = (fields: Record<string, string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const response = yield* http.execute(
          HttpClientRequest.post(`${origin}/api/auth/oauth2/token`).pipe(
            HttpClientRequest.bodyUrlParams(fields),
          ),
        );
        const value = yield* response.json;
        // Record only the outcome. Neither success nor error bodies belong in evidence.
        yield* evidence.json(`oauth-${fields.grant_type}-${response.status}.json`, {
          status: response.status,
        });
        return { status: response.status, body: value };
      }),
    ).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError(() => new OAuthFailed({ operation: "token exchange", status: 0 })),
    );
  const refreshResponse = (grant: Grant) =>
    exchange({
      grant_type: "refresh_token",
      client_id: grant.clientId,
      refresh_token: Redacted.value(grant.tokens).refresh_token,
      resource: grant.resource,
    });
  const authorize = (kind: "mcp" | "api") =>
    Effect.gen(function* () {
      // Playwright network traces contain cookies and authorization codes. Keep the video only.
      yield* browser.omitNetworkTrace;
      const resource = yield* api.request(
        actors.owner,
        "GET",
        `/.well-known/oauth-protected-resource/${kind}`,
      );
      yield* ok("resource discovery", resource.status);
      const metadata = yield* body(
        Schema.Struct({
          resource: Schema.String,
          authorization_servers: Schema.Array(Schema.String),
        }),
        resource,
      );
      if (
        metadata.resource !== `${origin}/${kind}` ||
        !metadata.authorization_servers.includes(`${origin}/api/auth`)
      )
        return yield* new OAuthFailed({ operation: "resource metadata", status: resource.status });
      const discovery = yield* api.request(
        actors.owner,
        "GET",
        "/.well-known/oauth-authorization-server/api/auth",
      );
      yield* ok("authorization discovery", discovery.status);
      const endpoints = yield* body(
        Schema.Struct({
          issuer: Schema.String,
          authorization_endpoint: Schema.String,
          token_endpoint: Schema.String,
          registration_endpoint: Schema.String,
        }),
        discovery,
      );
      if (
        endpoints.issuer !== `${origin}/api/auth` ||
        endpoints.authorization_endpoint !== `${origin}/api/auth/oauth2/authorize` ||
        endpoints.token_endpoint !== `${origin}/api/auth/oauth2/token` ||
        endpoints.registration_endpoint !== `${origin}/api/auth/oauth2/register`
      )
        return yield* new OAuthFailed({
          operation: "authorization endpoints",
          status: discovery.status,
        });
      const state = randomBytes(24).toString("hex"),
        verifier = randomBytes(32).toString("base64url");
      const receiver = yield* callback(state);
      const unregistered = yield* api.session();
      const registered = yield* api.request(unregistered, "POST", "/api/auth/oauth2/register", {
        client_name: "Executor E2E client",
        redirect_uris: [receiver.url],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
      yield* ok("client registration", registered.status);
      const { client_id: clientId } = yield* body(
        Schema.Struct({ client_id: Schema.NonEmptyString }),
        registered,
      );
      // DCR clients register anonymously. The product permits revoking their grants, not deleting registrations.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const response = yield* api.request(actors.owner, "GET", "/api/auth/oauth2/get-consents");
          yield* ok("read cleanup consents", response.status);
          const grants = yield* body(Consents, response);
          for (const grant of grants.filter((item) => item.clientId === clientId)) {
            const deleted = yield* api.request(
              actors.owner,
              "POST",
              "/api/auth/oauth2/delete-consent",
              { id: grant.id },
            );
            yield* ok("consent cleanup", deleted.status);
          }
          yield* evidence.json("oauth-cleanup.json", {
            grantsRevoked: true,
            clientId,
            registration:
              "Retained: the public API does not permit deleting anonymous client registrations.",
          });
        }).pipe(Effect.orDie),
      );
      const authorization = new URL(endpoints.authorization_endpoint);
      authorization.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: receiver.url,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        scope: `${kind === "mcp" ? "mcp" : "executor"} offline_access`,
        resource: `${origin}/${kind}`,
        state,
      }).toString();
      yield* browser.use("Open the client's OAuth authorization request", (page) =>
        page.goto(authorization.href),
      );
      yield* browser.use("The consent page names the requesting client", (page) =>
        page.getByText("Executor E2E client", { exact: true }).waitFor({ state: "visible" }),
      );
      const organizations = yield* api.request(actors.owner, "GET", "/api/auth/organization/list");
      yield* ok("read organizations", organizations.status);
      const visible = yield* body(
        Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
        organizations,
      );
      const organization = visible.find((item) => item.id === actors.organization.id);
      if (!organization)
        return yield* new OAuthFailed({
          operation: "find intended organization",
          status: organizations.status,
        });
      yield* browser.use("Select the intended organization", (page) =>
        page.getByRole("combobox").click(),
      );
      yield* browser.use("Confirm the organization selection", (page) =>
        page.getByRole("option", { name: organization.name, exact: true }).click(),
      );
      yield* browser.checkpoint("OAuth consent before approval");
      yield* browser.use("Approve the client connection", (page) =>
        page.getByRole("button", { name: "Connect", exact: true }).click(),
      );
      // The receiver validates the callback path and state before releasing the code.
      // A browser load event can abort even after this response is visibly rendered.
      const code = yield* receiver.code;
      yield* browser.use("The callback accepted the authorization", (page) =>
        page.getByRole("heading", { name: "Connected to Executor", exact: true }).waitFor(),
      );
      const callbackOrigin = yield* browser.use("The callback page belongs to the client", (page) =>
        Promise.resolve(new URL(page.url()).origin),
      );
      if (callbackOrigin !== new URL(receiver.url).origin)
        return yield* new OAuthFailed({ operation: "callback origin", status: 0 });
      const exchanged = yield* exchange({
        grant_type: "authorization_code",
        client_id: clientId,
        code: Redacted.value(code),
        code_verifier: verifier,
        redirect_uri: receiver.url,
        resource: `${origin}/${kind}`,
      });
      yield* ok("code exchange", exchanged.status);
      const tokens = yield* body(Tokens, exchanged).pipe(
        Effect.map(Redacted.make),
        Effect.mapError(
          () => new OAuthFailed({ operation: "token response", status: exchanged.status }),
        ),
      );
      const consents = yield* api.request(actors.owner, "GET", "/api/auth/oauth2/get-consents");
      yield* ok("read consent", consents.status);
      const consentRows = yield* body(Consents, consents);
      const listed = yield* api.request(actors.owner, "GET", "/api/auth/mcp/grants");
      yield* ok("read grants", listed.status);
      const grants = yield* body(Grants, listed);
      const grant = grants.find(
        (item) => item.clientId === clientId && item.resource === actors.organization.id,
      );
      const consent = consentRows.find(
        (item) => item.clientId === clientId && item.referenceId === grant?.grant.id,
      );
      if (!grant || !consent)
        return yield* new OAuthFailed({
          operation: "organization-bound consent",
          status: consents.status,
        });
      yield* evidence.json("oauth-consent.json", {
        clientId,
        organization: grant.resource,
        grantId: grant.grant.id,
        pkce: "S256",
        scope: `${kind === "mcp" ? "mcp" : "executor"} offline_access`,
      });
      return {
        clientId,
        grantId: grant.grant.id,
        resource: `${origin}/${kind}`,
        consentId: consent.id,
        tokens,
      } satisfies Grant;
    });
  return {
    authorize: authorize("mcp"),
    authorizeApi: authorize("api"),
    refresh: (grant: Grant) =>
      Effect.gen(function* () {
        const response = yield* refreshResponse(grant);
        yield* ok("refresh grant", response.status);
        const tokens = yield* body(Tokens, response).pipe(
          Effect.map(Redacted.make),
          Effect.mapError(
            () => new OAuthFailed({ operation: "refresh response", status: response.status }),
          ),
        );
        return { ...grant, tokens };
      }),
    refreshStatus: (grant: Grant) =>
      refreshResponse(grant).pipe(Effect.map((response) => response.status)),
    revoke: (grant: Grant) =>
      api
        .request(actors.owner, "POST", "/api/auth/oauth2/delete-consent", { id: grant.consentId })
        .pipe(Effect.flatMap((response) => ok("revoke consent", response.status))),
  };
});
/** Shared OAuth/browser driver for both hosted targets; it imports no product code. */
export class McpOAuth extends Context.Service<McpOAuth, Effect.Success<typeof make>>()(
  "e2e/McpOAuth",
) {
  static readonly layer = Layer.effect(McpOAuth, make);
}
