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
import { chooseConsent, chooseConsentOrganization, consentValue } from "./consent-page.ts";
import { heldValue, reveal, secret } from "./failure-text.ts";

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
  readonly codeExchangeTraceId: string;
}
export interface Grant extends Authorized {
  readonly tokens: Redacted.Redacted<typeof Tokens.Type>;
}
export interface AccessGrant extends Authorized {
  readonly tokens: Redacted.Redacted<typeof AccessTokens.Type>;
}
interface ClientOptions {
  readonly name: string;
  readonly offlineAccess: boolean;
  readonly logoUri?: string;
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
          if (valid) Effect.runSync(Deferred.succeed(received, secret(code)));
        }),
      ),
      (server) =>
        driver(
          "close OAuth callback",
          () =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
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

export const authorizeBrowserMcp = (
  page: Page,
  origin: string,
  {
    resource = `${origin}/mcp`,
    client = "Release verification",
    scope = "mcp offline_access",
    beforeHydration = false,
  } = {},
) =>
  Effect.gen(function* () {
    const state = randomBytes(24).toString("hex");
    const verifier = randomBytes(32).toString("base64url");
    const receiver = yield* oauthCallback(state);
    const registration = yield* driver("register release MCP client", () =>
      fetch(`${origin}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: client,
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
    const authorization = new URL(`${origin}/api/auth/oauth2/authorize`);
    authorization.search = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: receiver.url,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      scope,
      resource,
      state,
    }).toString();
    const addresses: string[] = [];
    let consents = 0;
    const consentPath = /\/api\/auth\/oauth2\/consent$/u;
    if (beforeHydration) {
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) addresses.push(frame.url());
      });
      let releaseScripts = () => {};
      const scriptsHeld = new Promise<void>((resolve) => {
        releaseScripts = resolve;
      });
      let releaseConsent = () => {};
      const consentHeld = new Promise<void>((resolve) => {
        releaseConsent = resolve;
      });
      let consentArrived = () => {};
      const consentSent = new Promise<void>((resolve) => {
        consentArrived = resolve;
      });
      const scripts = /\/assets\/[^/]+\.js$/u;
      yield* driver("hold the consent page's scripts and decisions", () =>
        Promise.all([
          page.route(scripts, (route) => scriptsHeld.then(() => route.fallback())),
          page.route(consentPath, (route) => {
            consents += 1;
            consentArrived();
            return consentHeld.then(() => route.fallback());
          }),
        ]),
      );
      const early = yield* driver("approve on the consent page before it is interactive", () =>
        page
          .bringToFront()
          .then(() => page.goto(authorization.href, { waitUntil: "commit" }))
          .then(() =>
            page.getByRole("button", { name: "Connect", exact: true }).waitFor({ timeout: 15000 }),
          )
          .then(() => page.locator("strong").filter({ hasText: client }).waitFor({ timeout: 5000 }))
          .then(() => page.getByRole("button", { name: "Connect", exact: true }).click())
          .then(() => page.evaluate(() => document.documentElement.hasAttribute("data-hydrated")))
          .catch((error: unknown) => {
            releaseScripts();
            releaseConsent();
            throw error;
          }),
      );
      if (early)
        return yield* new OAuthFailed({ operation: "approve before hydration", status: 0 });
      if (addresses.some((address) => new URL(address).searchParams.has("decision")))
        return yield* new OAuthFailed({ operation: "early approval was sent natively", status: 0 });
      yield* driver("let the consent page hydrate", () => {
        releaseScripts();
        return page
          .unroute(scripts)
          .then(() =>
            Promise.race([
              consentSent,
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error("The held decision sent no consent request in 15 s")),
                  15000,
                ),
              ),
            ]),
          );
      });
      yield* driver("submit Cancel while the approval is in flight", () =>
        page.evaluate(() => {
          const cancel = document.querySelector<HTMLButtonElement>(
            "form.mcp-consent-actions button[value='decline']",
          );
          if (cancel === null || cancel.form === null) throw new Error("Missing Cancel");
          cancel.form.requestSubmit(cancel);
        }),
      );
      yield* driver("send the approval", () => {
        releaseConsent();
        return Promise.resolve();
      });
    } else {
      yield* driver("open release MCP consent", () => page.goto(authorization.href));
      yield* driver("verify the requesting MCP client", () =>
        page.getByText(client, { exact: true }).waitFor({ state: "visible" }),
      );
      yield* driver("approve release MCP connection", () =>
        page.getByRole("button", { name: "Connect", exact: true }).click(),
      );
    }
    const code = yield* receiver.code;
    if (beforeHydration) {
      yield* driver("stop holding consent requests", () => page.unroute(consentPath));
      if (consents !== 1)
        return yield* new OAuthFailed({
          operation: `one consent request, not ${consents}`,
          status: 0,
        });
      if (addresses.some((address) => new URL(address).searchParams.has("decision")))
        return yield* new OAuthFailed({ operation: "a decision was sent natively", status: 0 });
    }
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
          code: reveal(code),
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
            access_token: heldValue(Schema.RedactedFromValue(Schema.NonEmptyString)),
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
  const issuer = `${target.metadata.target === "cloud" ? hosts.edge : origin}/api/auth`;
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
  const refreshResponse = (grant: Grant, tokenOrigin?: string, scope?: string) =>
    exchange(
      {
        grant_type: "refresh_token",
        client_id: grant.clientId,
        refresh_token: reveal(grant.tokens).refresh_token,
        resource: grant.resource,
        ...(scope === undefined ? {} : { scope }),
      },
      tokenOrigin,
    );
  /**
   * `omitted` sends no RFC 8707 `resource` to the authorization or token endpoint, as some
   * MCP clients do; the grant must still bind to the discovered resource.
   */
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
  const authorizeClient = <E = never, R = never>(
    kind: "mcp" | "api" | "desktop",
    connection?: string,
    resourceParameter: "sent" | "omitted" = "sent",
    client: ClientOptions = e2eClient,
    resourceOrigin: string = origin,
    review?: Effect.Effect<void, E, R>,
  ) =>
    Effect.gen(function* () {
      const query = connection === undefined ? "" : `?connection=${encodeURIComponent(connection)}`;
      const resourcePath = kind === "desktop" ? "api/desktop" : kind;
      const resourceUrl = `${resourceOrigin}/${resourcePath}${query}`;
      yield* browser.omitNetworkTrace;
      const discoveryPath = `/.well-known/oauth-protected-resource/${resourcePath}${query}`;
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
        ...(client.logoUri === undefined ? {} : { logo_uri: client.logoUri }),
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
      const scope = `${kind === "api" ? "executor" : kind}${client.offlineAccess ? " offline_access" : ""}`;
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
      if (review !== undefined) yield* review;
      else if (connection === undefined) {
        yield* browser.use("Approve for the intended organization", (page) =>
          chooseConsentOrganization(page, organization.name),
        );
        expect(
          yield* browser.use("Consent states the requested access", (page) =>
            consentValue(page, "Access"),
          ),
        ).toBe(
          kind === "api"
            ? "Executor API"
            : kind === "desktop"
              ? "Your Executor account"
              : "All apps",
        );
      } else {
        const listed = yield* api.request(
          actors.owner,
          "GET",
          `/api/organizations/${actors.organization.id}/mcp-connections`,
        );
        yield* ok("read connections", listed.status);
        const named = (yield* body(
          Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
          listed,
        )).find((item) => item.id === connection);
        if (named === undefined)
          return yield* new OAuthFailed({ operation: "find the named connection", status: 0 });
        const shown = yield* browser.use("Consent preselects the URL's connection", (page) =>
          Promise.all([consentValue(page, "Organization"), consentValue(page, "Access")]),
        );
        expect(shown).toEqual([organization.name, named.name]);
      }
      if (review === undefined && kind === "mcp")
        yield* browser.use("Answer approvals through the agent", (page) =>
          chooseConsent(page, "Approvals", "Through your agent"),
        );
      yield* browser.checkpoint("OAuth consent before approval");
      yield* browser.use("Approve the client connection", (page) =>
        page.getByRole("button", { name: "Connect", exact: true }).click(),
      );
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
        code: reveal(code),
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
        (item) =>
          item.clientId === clientId &&
          (review !== undefined || item.resource === actors.organization.id),
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
      Effect.map(secret),
      Effect.mapError(
        () => new OAuthFailed({ operation: "token response", status: exchanged.status }),
      ),
    );
  const authorize = <E = never, R = never>(
    kind: "mcp" | "api" | "desktop",
    connection?: string,
    resourceParameter: "sent" | "omitted" = "sent",
    client: ClientOptions = e2eClient,
    resourceOrigin: string = origin,
    review?: Effect.Effect<void, E, R>,
  ) =>
    authorizeClient(kind, connection, resourceParameter, client, resourceOrigin, review).pipe(
      Effect.flatMap(({ authorized, exchanged }) =>
        tokensOf(Tokens, exchanged).pipe(
          Effect.map((tokens): Grant => ({ ...authorized, tokens })),
        ),
      ),
    );
  return {
    authorize: authorize("mcp"),
    authorizeApi: authorize("api"),
    authorizeDesktop: authorize("desktop", undefined, "sent", {
      name: "Executor desktop",
      offlineAccess: true,
    }),
    authorizeWithoutResource: authorize("mcp", undefined, "omitted"),
    authorizeConnection: (connection: string) => authorize("mcp", connection),
    authorizeReviewing: <E, R>(review: Effect.Effect<void, E, R>, connection?: string) =>
      authorize("mcp", connection, "sent", e2eClient, origin, review),
    authorizeAt: (kind: "mcp" | "api", resourceOrigin: string) =>
      authorize(kind, undefined, "sent", e2eClient, resourceOrigin),
    authorizeNamed: (name: string, logoUri?: string) =>
      authorize("mcp", undefined, "sent", {
        name,
        offlineAccess: true,
        ...(logoUri === undefined ? {} : { logoUri }),
      }),
    authorizeWithoutRefresh: (name: string) =>
      authorizeClient("mcp", undefined, "sent", { name, offlineAccess: false }).pipe(
        Effect.flatMap(({ authorized, exchanged }) =>
          tokensOf(AccessTokens, exchanged).pipe(
            Effect.map((tokens): AccessGrant => ({ ...authorized, tokens })),
          ),
        ),
      ),
    refresh: (grant: Grant, tokenOrigin?: string, scope?: string) =>
      Effect.gen(function* () {
        const response = yield* refreshResponse(grant, tokenOrigin, scope);
        yield* ok("refresh grant", response.status);
        const tokens = yield* body(Tokens, response).pipe(
          Effect.map(secret),
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
export class McpOAuth extends Context.Service<McpOAuth, Effect.Success<typeof make>>()(
  "e2e/McpOAuth",
) {
  static readonly layer = Layer.effect(McpOAuth, make);
}
