import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Exit, Layer, Predicate, type Scope } from "effect";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ToolName,
} from "./ids";
import type { AuthMethodDescriptor } from "./integration";
import { definePlugin, type IntegrationRecord } from "./plugin";
import { makeTestWorkspaceHarness, memoryCredentialsPlugin } from "./test-config";
import { serveTestHttpApp } from "./testing";
import { scopesFromAuthorizeUrl, serveOAuthTestServer } from "./testing/oauth-test-server";

// Integration-driven scopes: at connect, `oauth.start` requests the integration's
// scopes — its DECLARED oauth scopes when it has any, otherwise the scopes
// DISCOVERED from the server's RFC 9728 / RFC 8414 metadata (MCP-style). Either
// way the OAuth app carries no scope set of its own, so there is no union and no
// over-request — the integration is the sole source of what to request. (Replaces
// the earlier declared∪client union model.)

const INTEG = IntegrationSlug.make("acme");
const TEMPLATE = AuthTemplateSlug.make("oauth");
const CLIENT = OAuthClientSlug.make("acme-app");

// The integration's DECLARED oauth scopes — the sole source of the request.
const DECLARED_SCOPES = ["calendar", "gmail", "drive", "sheets"] as const;

/** A plugin whose integration config carries declared oauth scopes, projected
 *  into an oauth `AuthMethodDescriptor` via `describeAuthMethods` — exactly the
 *  shape `resolveOAuthScopePolicy` reads. `scopes: null` ⇒ no declared oauth
 *  scopes (the MCP/no-template-scopes case). */
const makeScopePluginWithId = <const TId extends string>(
  id: TId,
  config: { readonly scopes: readonly string[] | null },
  options: { readonly discoversScopes?: boolean } = {},
) =>
  definePlugin(() => ({
    id,
    storage: () => ({}),
    resolveTools: () =>
      Effect.succeed({
        tools: [{ name: ToolName.make("whoami"), description: "whoami" }],
      }),
    invokeTool: ({ credential }) => Effect.succeed({ token: credential.value }),
    describeAuthMethods: (record: IntegrationRecord): readonly AuthMethodDescriptor[] => {
      const cfg = record.config as { readonly scopes?: readonly string[] | null } | null;
      const scopes = cfg?.scopes;
      if (scopes == null) {
        // No declared oauth scopes. Server-targeting methods (MCP) expose a
        // `discoveryUrl` and discover scopes from the server at connect; others
        // declare none. Declared scopes resolve to [].
        return [
          {
            id: "oauth",
            label: "OAuth2",
            kind: "oauth",
            template: String(TEMPLATE),
            ...(options.discoversScopes
              ? { oauth: { discoveryUrl: `https://${id}.example/mcp` } }
              : {}),
          },
        ];
      }
      return [
        {
          id: "oauth",
          label: "OAuth2",
          kind: "oauth",
          template: String(TEMPLATE),
          oauth: { scopes },
        },
      ];
    },
    extension: (ctx) => ({
      seed: () =>
        ctx.core.integrations.register({
          slug: INTEG,
          description: "Acme",
          config: { scopes: config.scopes },
        }),
    }),
  }))();

const makeScopePlugin = (config: { readonly scopes: readonly string[] | null }) =>
  makeScopePluginWithId("acme", config);

const makeMcpScopePlugin = (config: { readonly scopes: readonly string[] | null }) =>
  makeScopePluginWithId("mcp", config, { discoversScopes: true });

/** Serve RFC 9728 protected-resource metadata and RFC 8414 authorization-server
 *  metadata on one origin, with configurable scopes. `prm`: an object serves
 *  protected-resource metadata (omit `scopesSupported` to leave the resource
 *  SILENT on scopes; `[]` advertises an explicit empty set); `"error"` makes the
 *  PRM endpoint return 500; `null`/absent makes it 404. `authServerScopes`, when
 *  set, serves authorization-server metadata advertising those scopes. */
const serveMetadataServer = (config: {
  readonly prm?:
    | {
        readonly authorizationServers?: readonly string[];
        readonly scopesSupported?: readonly string[];
      }
    | "error"
    | null;
  readonly authServerScopes?: readonly string[];
}) =>
  Effect.gen(function* () {
    const baseUrlRef = { value: "" };
    const respond = (path: string): HttpServerResponse.HttpServerResponse => {
      const base = baseUrlRef.value;
      if (path.startsWith("/.well-known/oauth-protected-resource")) {
        if (config.prm === "error")
          return HttpServerResponse.jsonUnsafe({ error: "boom" }, { status: 500 });
        if (config.prm == null) return HttpServerResponse.empty({ status: 404 });
        return HttpServerResponse.jsonUnsafe({
          resource: `${base}/mcp`,
          bearer_methods_supported: ["header"],
          ...(config.prm.authorizationServers
            ? { authorization_servers: config.prm.authorizationServers }
            : {}),
          ...(config.prm.scopesSupported !== undefined
            ? { scopes_supported: config.prm.scopesSupported }
            : {}),
        });
      }
      if (
        path === "/.well-known/oauth-authorization-server" &&
        config.authServerScopes !== undefined
      ) {
        return HttpServerResponse.jsonUnsafe({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: config.authServerScopes,
        });
      }
      return HttpServerResponse.empty({ status: 404 });
    };
    const server = yield* serveTestHttpApp((request) => Effect.succeed(respond(request.url)));
    baseUrlRef.value = server.baseUrl;
    return {
      baseUrl: server.baseUrl,
      authorizationEndpoint: server.url("/authorize"),
      tokenEndpoint: server.url("/token"),
      mcpResourceUrl: server.url("/mcp"),
    };
  });

/** Seed an MCP integration with no declared scopes and an OAuth app bound to the
 *  given server as its resource, returning the executor ready to `oauth.start`.
 *  The shared setup for the discovery cases below; case (h) inlines its own (no
 *  `resource`) because the absent resource IS the case under test. */
const setupMcpScopeClient = (server: {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly mcpResourceUrl: string;
}) =>
  Effect.gen(function* () {
    const plugins = [memoryCredentialsPlugin(), makeMcpScopePlugin({ scopes: null })] as const;
    const { executor } = yield* makeTestWorkspaceHarness({ plugins });
    yield* executor.mcp.seed();
    yield* executor.oauth.createClient({
      owner: "org",
      slug: CLIENT,
      authorizationUrl: server.authorizationEndpoint,
      tokenUrl: server.tokenEndpoint,
      grant: "authorization_code",
      clientId: "test-client",
      clientSecret: "test-secret",
      resource: server.mcpResourceUrl,
    });
    return executor;
  });

describe("oauth.start integration-driven scopes", () => {
  it.effect(
    "(a) requests exactly the integration's declared scopes (the app contributes none)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* serveOAuthTestServer({ scopes: [...DECLARED_SCOPES] });
          const plugins = [
            memoryCredentialsPlugin(),
            makeScopePlugin({ scopes: DECLARED_SCOPES }),
          ] as const;
          const { executor } = yield* makeTestWorkspaceHarness({ plugins });
          yield* executor.acme.seed();

          // The app is pure identity — no scope set.
          yield* executor.oauth.createClient({
            owner: "org",
            slug: CLIENT,
            authorizationUrl: server.authorizationEndpoint,
            tokenUrl: server.tokenEndpoint,
            grant: "authorization_code",
            clientId: "test-client",
            clientSecret: "test-secret",
          });

          const started = yield* executor.oauth.start({
            owner: "org",
            client: CLIENT,
            clientOwner: "org",
            name: ConnectionName.make("main"),
            integration: INTEG,
            template: TEMPLATE,
          });
          expect(started.status).toBe("redirect");
          if (started.status !== "redirect") return;

          // The authorize URL requests exactly the integration's declared scopes.
          expect(scopesFromAuthorizeUrl(started.authorizationUrl)).toEqual([...DECLARED_SCOPES]);
        }),
      ),
  );

  it.effect("filters stale declared scopes against authorization-server metadata", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["calendar", "drive"] });
        const plugins = [
          memoryCredentialsPlugin(),
          makeScopePlugin({ scopes: ["calendar", "stale_scope", "drive"] }),
        ] as const;
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();

        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
          resource: server.resourceUrl,
        });

        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;

        expect(scopesFromAuthorizeUrl(started.authorizationUrl)).toEqual(["calendar", "drive"]);
      }),
    ),
  );

  it.effect("(b) when the integration declares no oauth scopes, start requests none", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: [] });
        // `scopes: null` ⇒ the integration declares an oauth method with no
        // template scopes ⇒ declared scopes resolve to [] ⇒ no scope is requested.
        const plugins = [memoryCredentialsPlugin(), makeScopePlugin({ scopes: null })] as const;
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();

        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });

        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;

        expect(scopesFromAuthorizeUrl(started.authorizationUrl)).toEqual([]);
      }),
    ),
  );

  it.effect(
    "(c) for MCP with no protected-resource metadata, start requests no scopes (no arbitrary issuer probing)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // The server advertises authorization-server scopes but publishes no
          // RFC 9728 protected-resource metadata. We only follow the
          // authorization servers a resource NAMES, so with no PRM there is
          // nothing to follow — start requests no scopes rather than probing the
          // resource URL or its origin.
          const server = yield* serveMetadataServer({
            authServerScopes: ["channels:history", "users:read"],
          });
          const executor = yield* setupMcpScopeClient(server);

          const started = yield* executor.oauth.start({
            owner: "org",
            client: CLIENT,
            clientOwner: "org",
            name: ConnectionName.make("main"),
            integration: INTEG,
            template: TEMPLATE,
          });
          expect(started.status).toBe("redirect");
          if (started.status !== "redirect") return;

          expect(scopesFromAuthorizeUrl(started.authorizationUrl)).toEqual([]);
        }),
      ),
  );

  it.effect(
    "(d) for MCP, the resource's own scopes_supported wins over a divergent authorization server",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // The resource publishes its own RFC 9728 `scopes_supported` AND names
          // an AS advertising a DIFFERENT set. The resource's list is
          // authoritative (RFC 9728 §7.2): start requests exactly it and never
          // consults the AS. This is the primary positive discovery path.
          const server = yield* serveMetadataServer({
            prm: { scopesSupported: ["channels:history", "users:read"] },
            authServerScopes: ["should:not:appear"],
          });
          const executor = yield* setupMcpScopeClient(server);

          const started = yield* executor.oauth.start({
            owner: "org",
            client: CLIENT,
            clientOwner: "org",
            name: ConnectionName.make("main"),
            integration: INTEG,
            template: TEMPLATE,
          });
          expect(started.status).toBe("redirect");
          if (started.status !== "redirect") return;

          expect(scopesFromAuthorizeUrl(started.authorizationUrl)).toEqual([
            "channels:history",
            "users:read",
          ]);
        }),
      ),
  );

  it.effect(
    "(e) for MCP, discovers scopes from a cross-origin authorization server named in resource metadata",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // The resource's PRM is silent on scopes but names an AS on a DIFFERENT
          // origin (RFC 9728). Discovery must follow `authorization_servers`, not
          // just the resource URL/origin.
          const authServer = yield* serveMetadataServer({
            authServerScopes: ["read:cross", "write:cross"],
          });
          const resourceServer = yield* serveMetadataServer({
            prm: { authorizationServers: [authServer.baseUrl] },
          });
          const executor = yield* setupMcpScopeClient(resourceServer);

          const started = yield* executor.oauth.start({
            owner: "org",
            client: CLIENT,
            clientOwner: "org",
            name: ConnectionName.make("main"),
            integration: INTEG,
            template: TEMPLATE,
          });
          expect(started.status).toBe("redirect");
          if (started.status !== "redirect") return;

          expect(scopesFromAuthorizeUrl(started.authorizationUrl)).toEqual([
            "read:cross",
            "write:cross",
          ]);
        }),
      ),
  );

  it.effect(
    "(f) for MCP, an explicit empty resource scopes_supported is honored (no AS fallback)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // The resource explicitly advertises NO scopes; the AS would offer some,
          // but the resource's explicit empty set is authoritative.
          const server = yield* serveMetadataServer({
            prm: { scopesSupported: [] },
            authServerScopes: ["should:not:appear"],
          });
          const executor = yield* setupMcpScopeClient(server);

          const started = yield* executor.oauth.start({
            owner: "org",
            client: CLIENT,
            clientOwner: "org",
            name: ConnectionName.make("main"),
            integration: INTEG,
            template: TEMPLATE,
          });
          expect(started.status).toBe("redirect");
          if (started.status !== "redirect") return;

          expect(scopesFromAuthorizeUrl(started.authorizationUrl)).toEqual([]);
        }),
      ),
  );

  it.effect(
    "(g) for MCP, a resource-metadata discovery error fails start (no silent empty-scope fallback)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // A transient 500 on the PRM endpoint must surface, not be swallowed
          // into "request no scopes".
          const server = yield* serveMetadataServer({ prm: "error" });
          const executor = yield* setupMcpScopeClient(server);

          const exit = yield* Effect.exit(
            executor.oauth.start({
              owner: "org",
              client: CLIENT,
              clientOwner: "org",
              name: ConnectionName.make("main"),
              integration: INTEG,
              template: TEMPLATE,
            }),
          );
          expect(Exit.isFailure(exit)).toBe(true);
        }),
      ),
  );

  it.effect(
    "(h) for MCP, a client with no resource fails start (discovery cannot run without one)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* serveMetadataServer({ prm: { scopesSupported: ["read"] } });
          const plugins = [
            memoryCredentialsPlugin(),
            makeMcpScopePlugin({ scopes: null }),
          ] as const;
          const { executor } = yield* makeTestWorkspaceHarness({ plugins });
          yield* executor.mcp.seed();

          // No `resource` on the client — discovery has nothing to probe.
          yield* executor.oauth.createClient({
            owner: "org",
            slug: CLIENT,
            authorizationUrl: server.authorizationEndpoint,
            tokenUrl: server.tokenEndpoint,
            grant: "authorization_code",
            clientId: "test-client",
            clientSecret: "test-secret",
          });

          const exit = yield* Effect.exit(
            executor.oauth.start({
              owner: "org",
              client: CLIENT,
              clientOwner: "org",
              name: ConnectionName.make("main"),
              integration: INTEG,
              template: TEMPLATE,
            }),
          );
          expect(Exit.isFailure(exit)).toBe(true);
        }),
      ),
  );

  it.effect("(j) caps server-advertised resource scopes so the authorize URL stays bounded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // A hostile/buggy server advertises far more scopes than any real
        // template. Discovery caps the request at 100 so the authorize URL
        // cannot be blown up.
        const manyScopes = Array.from({ length: 200 }, (_, i) => `scope:${i}`);
        const server = yield* serveMetadataServer({ prm: { scopesSupported: manyScopes } });
        const executor = yield* setupMcpScopeClient(server);

        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;

        const requested = scopesFromAuthorizeUrl(started.authorizationUrl);
        expect(requested.length).toBe(100);
        expect(requested).toEqual(manyScopes.slice(0, 100));
      }),
    ),
  );

  it.effect(
    "(k) caps the named authorization-server probe list at 3 (a 4th named AS is never reached)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // The resource's PRM is silent on scopes and names four authorization
          // servers. The first three contribute nothing; only the fourth would
          // advertise scopes. The 3-server cap stops before it, so discovery
          // yields no scopes — without the cap "capped:out" would appear.
          const as1 = yield* serveMetadataServer({});
          const as2 = yield* serveMetadataServer({});
          const as3 = yield* serveMetadataServer({});
          const as4 = yield* serveMetadataServer({ authServerScopes: ["capped:out"] });
          const resourceServer = yield* serveMetadataServer({
            prm: { authorizationServers: [as1.baseUrl, as2.baseUrl, as3.baseUrl, as4.baseUrl] },
          });
          const executor = yield* setupMcpScopeClient(resourceServer);

          const started = yield* executor.oauth.start({
            owner: "org",
            client: CLIENT,
            clientOwner: "org",
            name: ConnectionName.make("main"),
            integration: INTEG,
            template: TEMPLATE,
          });
          expect(started.status).toBe("redirect");
          if (started.status !== "redirect") return;

          expect(scopesFromAuthorizeUrl(started.authorizationUrl)).toEqual([]);
        }),
      ),
  );
});

// -----------------------------------------------------------------------------
// (i) The recorded `oauth_scope` reflects the requested (declared) scopes when
// the AS omits `scope`. A minimal inline token endpoint handles the
// client_credentials grant and deliberately OMITS `scope` from its response,
// forcing the recorded-scope fallback (`token.scope ?? requested.join(" ")`).
// -----------------------------------------------------------------------------

/** A minimal token endpoint serving the client_credentials grant and OMITTING
 *  `scope` from its response, forcing the recorded-scope fallback. Returns a
 *  scoped effect (mirrors `serveOAuthTestServer`); `yield*` it inside an already
 *  `Effect.scoped` test. */
const serveScopelessTokenServer = (): Effect.Effect<
  { readonly tokenEndpoint: string },
  unknown,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Layer.fresh(
        HttpServer.serve(
          HttpServerRequest.HttpServerRequest.asEffect().pipe(
            Effect.map((request: HttpServerRequest.HttpServerRequest) => {
              if (request.url.startsWith("/token") && request.method === "POST") {
                // A Bearer access token WITHOUT a `scope` field — the AS omits
                // it, so the recorded scope falls back to the requested set.
                return HttpServerResponse.jsonUnsafe(
                  {
                    access_token: `at_${Math.random().toString(36).slice(2)}`,
                    token_type: "Bearer",
                    expires_in: 3600,
                  },
                  { status: 200, headers: { "cache-control": "no-store" } },
                );
              }
              return HttpServerResponse.jsonUnsafe({ error: "not_found" }, { status: 404 });
            }),
          ),
        ).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
      ),
    );
    const server = Context.get(context, HttpServer.HttpServer);
    const address = server.address;
    if (!Predicate.isTagged(address, "TcpAddress")) {
      return yield* Effect.die(`Expected a TcpAddress, got ${JSON.stringify(address)}`);
    }
    return { tokenEndpoint: `http://127.0.0.1:${address.port}/token` };
  });

describe("oauth.start recorded scope fallback", () => {
  it.effect(
    "(i) records the requested (declared) scopes when the authorization server omits scope",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const tokenServer = yield* serveScopelessTokenServer();
          const plugins = [
            memoryCredentialsPlugin(),
            makeScopePlugin({ scopes: DECLARED_SCOPES }),
          ] as const;
          const { executor, config } = yield* makeTestWorkspaceHarness({ plugins });
          yield* executor.acme.seed();

          // A client_credentials client so `start` mints inline (no redirect),
          // exchanging against the scopeless token endpoint.
          yield* executor.oauth.createClient({
            owner: "org",
            slug: CLIENT,
            authorizationUrl: "http://127.0.0.1/authorize",
            tokenUrl: tokenServer.tokenEndpoint,
            grant: "client_credentials",
            clientId: "test-client",
            clientSecret: "test-secret",
          });

          const started = yield* executor.oauth.start({
            owner: "org",
            client: CLIENT,
            clientOwner: "org",
            name: ConnectionName.make("cc"),
            integration: INTEG,
            template: TEMPLATE,
          });
          expect(started.status).toBe("connected");

          // The connection's recorded `oauth_scope` is the requested (declared) set
          // since the AS omitted `scope`.
          const row = yield* Effect.promise(() =>
            config.db.findFirst("connection", {
              where: (b) => b("name", "=", "cc"),
            }),
          );
          expect(row?.oauth_scope).toBe("calendar gmail drive sheets");
        }),
      ),
  );

  it.effect(
    "(l) client_credentials discovers scopes and records them when the token endpoint omits scope",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // Discover policy (MCP, no declared scopes) reached through the
          // client_credentials grant: scopes come from the resource's PRM, and
          // the scopeless token endpoint forces the recorded-scope fallback to
          // the discovered set.
          const metadataServer = yield* serveMetadataServer({
            prm: { scopesSupported: ["mcp:read", "mcp:write"] },
          });
          const tokenServer = yield* serveScopelessTokenServer();
          const plugins = [
            memoryCredentialsPlugin(),
            makeMcpScopePlugin({ scopes: null }),
          ] as const;
          const { executor, config } = yield* makeTestWorkspaceHarness({ plugins });
          yield* executor.mcp.seed();

          yield* executor.oauth.createClient({
            owner: "org",
            slug: CLIENT,
            authorizationUrl: "http://127.0.0.1/authorize",
            tokenUrl: tokenServer.tokenEndpoint,
            grant: "client_credentials",
            clientId: "test-client",
            clientSecret: "test-secret",
            resource: metadataServer.mcpResourceUrl,
          });

          const started = yield* executor.oauth.start({
            owner: "org",
            client: CLIENT,
            clientOwner: "org",
            name: ConnectionName.make("cc"),
            integration: INTEG,
            template: TEMPLATE,
          });
          expect(started.status).toBe("connected");

          // The discovered scopes are requested and (the token endpoint omitting
          // `scope`) recorded on the connection.
          const row = yield* Effect.promise(() =>
            config.db.findFirst("connection", {
              where: (b) => b("name", "=", "cc"),
            }),
          );
          expect(row?.oauth_scope).toBe("mcp:read mcp:write");
        }),
      ),
  );
});
