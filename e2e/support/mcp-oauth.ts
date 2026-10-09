/** OAuth runs through the public server and recorded consent UI. Tokens stay private. */
import { createServer } from "node:http";
import type { Page } from "playwright";
import { createHash, randomBytes } from "node:crypto";
import { expect } from "@effect/vitest";
import { Context, Deferred, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Api, body } from "./api.ts";
import { Actors } from "./actors.ts";
import { Browser } from "./browser.ts";
import { Evidence } from "./evidence.ts";
import { Target, driver } from "./platform.ts";
import { targetHosts } from "./role-hosts.ts";

const Tokens = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  token_type: Schema.String,
});
const AccessTokens = Schema.Struct({
  access_token: Schema.NonEmptyString,
  token_type: Schema.String,
});
interface Authorized {
  readonly clientId: string;
  readonly grantId: string;
  readonly resource: string;
  readonly consentId: string;
  /** The trace of the authorization code exchange, so its server span can be found exactly. */
  readonly codeExchangeTraceId: string;
}
/** A real OAuth grant; credentials cannot appear in assertion diagnostics. */
export interface Grant extends Authorized {
  readonly tokens: Redacted.Redacted<typeof Tokens.Type>;
}
/** A grant for a client that asked for no `offline_access`: one access token and no refresh. */
export interface AccessGrant extends Authorized {
  readonly tokens: Redacted.Redacted<typeof AccessTokens.Type>;
}
/** The registering client's self-declared name, and whether it asks to refresh. */
interface ClientOptions {
  readonly name: string;
  readonly offlineAccess: boolean;
}
const e2eClient: ClientOptions = { name: "Executor E2E client", offlineAccess: true };
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

/** Own the client loopback receiver, including browser preconnect sockets at shutdown. */
export const oauthCallback = (state: string) =>
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
          // oxlint-disable-next-line executor/no-manual-effect-runtime-in-tests -- node:http request handlers are plain callbacks
          if (valid) Effect.runSync(Deferred.succeed(received, Redacted.make(code)));
        }),
      ),
      (server) =>
        driver(
          "close OAuth callback",
          () =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
              // Chromium may leave a preconnect socket that never sends an HTTP request.
              server.closeAllConnections();
            }),
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
    const receiver = yield* oauthCallback(state);
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
  const hosts = targetHosts(target);
  // Cloud names its issuer on the edge (`executor.sh`), with every endpoint on the browser origin.
  const issuer = `${target.metadata.target === "cloud" ? hosts.edge : origin}/api/auth`;
  /** Each exchange runs under a new trace of its own. */
  const exchange = (fields: Record<string, string>, tokenOrigin: string = hosts.browser) =>
    Effect.scoped(
      Effect.gen(function* () {
        const traceId = randomBytes(16).toString("hex");
        const response = yield* http.execute(
          HttpClientRequest.post(`${tokenOrigin}/api/auth/oauth2/token`).pipe(
            HttpClientRequest.setHeaders({
              traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01`,
            }),
            HttpClientRequest.bodyUrlParams(fields),
          ),
        );
        const value = yield* response.json;
        // Record only the outcome. Neither success nor error bodies belong in evidence.
        yield* evidence.json(`oauth-${fields.grant_type}-${response.status}.json`, {
          status: response.status,
        });
        return { status: response.status, body: value, traceId };
      }),
    ).pipe(
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.timeout("30 seconds"),
      Effect.mapError(() => new OAuthFailed({ operation: "token exchange", status: 0 })),
    );
  const refreshResponse = (grant: Grant, tokenOrigin?: string) =>
    exchange(
      {
        grant_type: "refresh_token",
        client_id: grant.clientId,
        refresh_token: Redacted.value(grant.tokens).refresh_token,
        resource: grant.resource,
      },
      tokenOrigin,
    );
  /**
   * `omitted` sends no RFC 8707 `resource` to the authorization or token endpoint, as some
   * MCP clients do; the grant must still bind to the discovered resource.
   */
  /** Discovery at another host the product serves, such as a Cloud role host; no cookies. */
  const discoverAt = (resourceOrigin: string, path: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const response = yield* http.execute(HttpClientRequest.get(`${resourceOrigin}${path}`));
        return { status: response.status, body: yield* response.json };
      }),
    ).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError(() => new OAuthFailed({ operation: "resource discovery", status: 0 })),
    );
  /**
   * `resourceOrigin` is where the client found the resource: the product's own origin, or another
   * origin that serves the same resources. Discovery runs as a client's does, without cookies:
   * the resource names the issuer, and the issuer's own origin serves its metadata. Sign-in and
   * consent stay on the browser origin.
   */
  const authorizeClient = (
    kind: "mcp" | "api",
    connection?: string,
    resourceParameter: "sent" | "omitted" = "sent",
    client: ClientOptions = e2eClient,
    resourceOrigin: string = origin,
  ) =>
    Effect.gen(function* () {
      // A scoped connection has its own MCP URL, OAuth resource and discovery document.
      const query = connection === undefined ? "" : `?connection=${encodeURIComponent(connection)}`;
      const resourceUrl = `${resourceOrigin}/${kind}${query}`;
      // Playwright network traces contain cookies and authorization codes. Keep the video only.
      yield* browser.omitNetworkTrace;
      const discoveryPath = `/.well-known/oauth-protected-resource/${kind}${query}`;
      const resource = yield* discoverAt(resourceOrigin, discoveryPath);
      yield* ok("resource discovery", resource.status);
      const metadata = yield* body(
        Schema.Struct({
          resource: Schema.String,
          authorization_servers: Schema.Array(Schema.String),
        }),
        resource,
      );
      if (metadata.resource !== resourceUrl || !metadata.authorization_servers.includes(issuer))
        return yield* new OAuthFailed({ operation: "resource metadata", status: resource.status });
      // RFC 8414: the issuer's path follows the well-known prefix, on the issuer's origin.
      const issuerUrl = new URL(issuer);
      const discovery = yield* discoverAt(
        issuerUrl.origin,
        `/.well-known/oauth-authorization-server${issuerUrl.pathname}`,
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
        endpoints.issuer !== issuer ||
        endpoints.authorization_endpoint !== `${hosts.browser}/api/auth/oauth2/authorize` ||
        endpoints.token_endpoint !== `${hosts.browser}/api/auth/oauth2/token` ||
        endpoints.registration_endpoint !== `${hosts.browser}/api/auth/oauth2/register`
      )
        return yield* new OAuthFailed({
          operation: "authorization endpoints",
          status: discovery.status,
        });
      const state = randomBytes(24).toString("hex"),
        verifier = randomBytes(32).toString("base64url");
      const receiver = yield* oauthCallback(state);
      const unregistered = yield* api.session();
      const registered = yield* api.request(unregistered, "POST", "/api/auth/oauth2/register", {
        client_name: client.name,
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
      const scope = `${kind === "mcp" ? "mcp" : "executor"}${client.offlineAccess ? " offline_access" : ""}`;
      const resourceField: Record<string, string> =
        resourceParameter === "sent" ? { resource: resourceUrl } : {};
      const authorization = new URL(endpoints.authorization_endpoint);
      authorization.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: receiver.url,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        scope,
        ...resourceField,
        state,
      }).toString();
      yield* browser.use("Open the client's OAuth authorization request", (page) =>
        page.goto(authorization.href),
      );
      // The page settles on either the consent or its load failure; only the consent passes.
      const shown = yield* browser.use("The consent page names the requesting client", (page) => {
        const outcome = page
          .getByText(client.name, { exact: true })
          .or(page.getByText("This connection request could not be loaded.", { exact: true }));
        return outcome.waitFor({ state: "visible" }).then(() => outcome.innerText());
      });
      expect(shown).toBe(client.name);
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
      if (connection === undefined) {
        yield* browser.use("Select the intended organization", (page) =>
          page.getByRole("combobox").click(),
        );
        yield* browser.use("Confirm the organization selection", (page) =>
          page.getByRole("option", { name: organization.name, exact: true }).click(),
        );
      } else {
        // The connection fixes its organization; consent names the scoped access instead.
        yield* browser.use("Consent describes the scoped connection", (page) =>
          page
            .getByRole("heading", { name: "Access to one of your connections", exact: true })
            .waitFor({ state: "visible" }),
        );
        if (
          (yield* browser.use("No organization choice", (page) =>
            page.getByRole("combobox").count(),
          )) !== 0
        )
          return yield* new OAuthFailed({ operation: "connection organization choice", status: 0 });
      }
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
        ...resourceField,
      });
      yield* ok("code exchange", exchanged.status);
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
        scope,
      });
      return {
        authorized: {
          clientId,
          grantId: grant.grant.id,
          resource: resourceUrl,
          consentId: consent.id,
          codeExchangeTraceId: exchanged.traceId,
        } satisfies Authorized,
        exchanged,
      };
    });
  const tokensOf = <A>(
    schema: Schema.ConstraintDecoder<A, never>,
    exchanged: Parameters<typeof body>[1],
  ) =>
    body(schema, exchanged).pipe(
      Effect.map(Redacted.make),
      Effect.mapError(
        () => new OAuthFailed({ operation: "token response", status: exchanged.status }),
      ),
    );
  const authorize = (
    kind: "mcp" | "api",
    connection?: string,
    resourceParameter: "sent" | "omitted" = "sent",
    client: ClientOptions = e2eClient,
    resourceOrigin: string = origin,
  ) =>
    authorizeClient(kind, connection, resourceParameter, client, resourceOrigin).pipe(
      Effect.flatMap(({ authorized, exchanged }) =>
        tokensOf(Tokens, exchanged).pipe(
          Effect.map((tokens): Grant => ({ ...authorized, tokens })),
        ),
      ),
    );
  return {
    authorize: authorize("mcp"),
    authorizeApi: authorize("api"),
    /** Authorize the plain MCP URL for a client that sends no `resource` parameter. */
    authorizeWithoutResource: authorize("mcp", undefined, "omitted"),
    /** Authorize a scoped connection's own MCP URL through the same browser consent. */
    authorizeConnection: (connection: string) => authorize("mcp", connection),
    /** Authorize the MCP or API resource a client discovered at another origin. */
    authorizeAt: (kind: "mcp" | "api", resourceOrigin: string) =>
      authorize(kind, undefined, "sent", e2eClient, resourceOrigin),
    /** Authorize the plain MCP URL for a client registered under its own name. */
    authorizeNamed: (name: string) =>
      authorize("mcp", undefined, "sent", { name, offlineAccess: true }),
    /** Authorize a named client that asks for no refresh token, so its access ends in an hour. */
    authorizeWithoutRefresh: (name: string) =>
      authorizeClient("mcp", undefined, "sent", { name, offlineAccess: false }).pipe(
        Effect.flatMap(({ authorized, exchanged }) =>
          tokensOf(AccessTokens, exchanged).pipe(
            Effect.map((tokens): AccessGrant => ({ ...authorized, tokens })),
          ),
        ),
      ),
    /**
     * Refresh at the token endpoint on `tokenOrigin`, by default the browser origin's: another
     * origin's is where a client that discovered the endpoints elsewhere keeps sending it.
     */
    refresh: (grant: Grant, tokenOrigin?: string) =>
      Effect.gen(function* () {
        const response = yield* refreshResponse(grant, tokenOrigin);
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
