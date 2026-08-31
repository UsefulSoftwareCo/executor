// Selfhost repros for #1816: a tool catalog refresh that meets an OAuth
// reauthorization condition must surface it as an actionable expired verdict,
// preserve the previously synced catalog, and must never dynamically register
// a fresh OAuth client — the saved connection already references one.
//
// Three variants:
// 1. The upstream MCP endpoint rejects a bearer executor still considers
//    unexpired (the live report): the refresh dials with the stored token,
//    gets 401, and must come back as reconnect-required without the MCP SDK's
//    interactive OAuth fallback registering a disposable client.
// 2. The token is expired locally and the refresh-token grant is rejected
//    with `invalid_grant` during the sync's credential resolution: the
//    recorded dead grant must present as expired on the connection read, not
//    be buried under a generic tool-sync verdict.
// 3. The bearer is honoured at the handshake and revoked by the time
//    `tools/list` runs: the reauthorization condition surfaces from the
//    LISTING failure, which the connect-path classification never sees, and
//    must reach the same expired verdict.
import { randomBytes } from "node:crypto";

import { Effect } from "effect";
import { expect } from "@effect/vitest";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { makeGreetingMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";
import { serveOAuthTestServer, type OAuthTestServerShape } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

const name = ConnectionName.make("main");
const template = AuthTemplateSlug.make("oauth2");

const freshSlug = (prefix: string): string => `${prefix}-${randomBytes(4).toString("hex")}`;

/** A real MCP server (serves `tools/list` for a one-tool catalog) that only
 *  accepts bearers the OAuth test server issued and still honours. */
const serveTokenGatedMcpServer = (oauth: OAuthTestServerShape) =>
  serveMcpServer(() => makeGreetingMcpServer(), {
    auth: {
      validateAuthorization: oauth.acceptsAuthorizationHeader,
      authorizationServerUrls: [oauth.issuerUrl],
      scopes: ["channels:history", "users:read"],
    },
  });

const requiredRedirect = (response: Response, from: string): string => {
  const location = response.headers.get("location");
  if (!location) {
    throw new Error(`Expected redirect from ${from}, got HTTP ${response.status}`);
  }
  return new URL(location, from).toString();
};

/** The test server's login page is plain text with Basic-auth POST — nothing a
 *  browser can click. Complete it out of band and hand back the callback URL. */
const submitProviderLogin = async (loginUrl: string): Promise<string> => {
  const credentials = Buffer.from("alice:password").toString("base64");
  const response = await fetch(loginUrl, {
    method: "POST",
    redirect: "manual",
    headers: { authorization: `Basic ${credentials}` },
  });
  const location = response.headers.get("location");
  if (response.status !== 302 || !location) {
    throw new Error(`provider login did not redirect (${response.status})`);
  }
  return new URL(location, loginUrl).toString();
};

const completeAuthorization = (authorizationUrl: string) =>
  Effect.promise(async () => {
    const login = await fetch(authorizationUrl, { redirect: "manual" });
    const loginUrl = requiredRedirect(login, authorizationUrl);
    const callbackUrl = await submitProviderLogin(loginUrl);
    const parsed = new URL(callbackUrl);
    const code = parsed.searchParams.get("code");
    if (!code) throw new Error(`OAuth callback did not include a code: ${callbackUrl}`);
    return { code };
  });

const seedDcrMcpOAuthConnection = (
  client: Client,
  prefix: string,
  oauth: OAuthTestServerShape,
  endpoint: string,
) =>
  Effect.gen(function* () {
    const slug = IntegrationSlug.make(freshSlug(prefix));
    const clientSlug = OAuthClientSlug.make(freshSlug(`${prefix}-client`));

    yield* client.mcp.addServer({
      payload: {
        transport: "remote",
        name: `OAuth refresh repro ${String(slug)}`,
        endpoint,
        slug: String(slug),
        authenticationTemplate: [{ kind: "oauth2" }],
      },
    });
    yield* Effect.addFinalizer(() =>
      client.mcp.removeServer({ params: { slug } }).pipe(Effect.ignore),
    );

    const probe = yield* client.oauth.probe({ payload: { url: endpoint } });
    if (!probe.registrationEndpoint) {
      return yield* Effect.die("OAuth probe did not discover a DCR registration endpoint");
    }

    const registered = yield* client.oauth.registerDynamic({
      payload: {
        owner: "org",
        slug: clientSlug,
        issuer: probe.issuer ?? null,
        registrationEndpoint: probe.registrationEndpoint,
        authorizationUrl: probe.authorizationUrl,
        tokenUrl: probe.tokenUrl,
        resource: probe.resource ?? endpoint,
        scopes: probe.scopesSupported ?? [],
        tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
        clientName: "Executor e2e MCP OAuth refresh repro",
        originIntegration: slug,
      },
    });
    yield* Effect.addFinalizer(() =>
      client.oauth
        .removeClient({ params: { slug: registered.client }, payload: { owner: "org" } })
        .pipe(Effect.ignore),
    );

    const started = yield* client.oauth.start({
      payload: {
        owner: "org",
        client: registered.client,
        clientOwner: "org",
        name,
        integration: slug,
        template,
      },
    });
    expect(started.status, "DCR MCP OAuth starts an authorization-code redirect").toBe("redirect");
    if (started.status !== "redirect") return yield* Effect.die("OAuth start did not redirect");

    const callback = yield* completeAuthorization(started.authorizationUrl);
    yield* client.oauth.complete({ payload: { state: started.state, code: callback.code } });
    yield* Effect.addFinalizer(() =>
      client.connections
        .remove({ params: { owner: "org", integration: slug, name } })
        .pipe(Effect.ignore),
    );
    yield* oauth.clearRequests;

    return { slug };
  });

const registrationRequests = (oauth: OAuthTestServerShape) =>
  Effect.map(oauth.requests, (requests) =>
    requests
      .filter((request) => request.path === "/register")
      .map((request) => `${request.method} ${request.path}`),
  );

scenario(
  "MCP OAuth · tool refresh on an upstream-rejected bearer surfaces reconnect without re-registering the DCR client",
  {
    timeout: 180_000,
  },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      // Long-lived tokens: executor's stored expiry stays in the future, so
      // the refresh dials the MCP endpoint with the stored bearer.
      const oauth = yield* serveOAuthTestServer({
        scopes: ["channels:history", "users:read"],
      });
      const mcp = yield* serveTokenGatedMcpServer(oauth);
      const { slug } = yield* seedDcrMcpOAuthConnection(
        client,
        "mcp-refresh-401",
        oauth,
        mcp.endpoint,
      );

      // Baseline: with the bearer honoured, the refresh syncs the real catalog.
      const synced = yield* client.connections.refresh({
        params: { owner: "org", integration: slug, name },
      });
      expect(
        synced.map((tool) => String(tool.name)),
        "the healthy connection syncs the server's catalog",
      ).toEqual(["simple_echo"]);

      // The provider revokes the grant server-side; executor has no idea and
      // still considers the stored token unexpired.
      const issued = yield* oauth.issuedAccessTokens;
      expect(issued.length, "the completed OAuth flow minted a bearer").toBeGreaterThan(0);
      yield* Effect.forEach(issued, (token) => oauth.revokeAccessToken(token));
      yield* oauth.clearRequests;

      const refreshed = yield* client.connections.refresh({
        params: { owner: "org", integration: slug, name },
      });

      const registers = yield* registrationRequests(oauth);
      expect(
        registers,
        "a noninteractive tool refresh must not dynamically register a fresh OAuth client",
      ).toEqual([]);

      expect(
        refreshed.map((tool) => String(tool.name)),
        "the previously synced catalog is preserved through the failed refresh",
      ).toEqual(["simple_echo"]);

      const reread = yield* client.connections.get({
        params: { owner: "org", integration: slug, name },
      });
      console.info(`[BUG repro] post-refresh health: ${JSON.stringify(reread.lastHealth ?? null)}`);
      expect(
        reread.lastHealth?.status,
        "an upstream-rejected bearer is a reauthorization condition, not an anonymous degraded sync",
      ).toBe("expired");
    }),
  ),
);

scenario(
  "MCP OAuth · invalid_grant during tool refresh presents expired, not a buried sync failure",
  {
    timeout: 180_000,
  },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      // Every minted token is already expired and the refresh grant is dead:
      // the sync's own credential resolution meets `invalid_grant`.
      const oauth = yield* serveOAuthTestServer({
        scopes: ["channels:history", "users:read"],
        supportRefresh: false,
        tokenExpiresInSeconds: 0,
        invalidRefreshTokenDescription: "Grant not found",
      });
      const mcp = yield* serveTokenGatedMcpServer(oauth);
      const { slug } = yield* seedDcrMcpOAuthConnection(
        client,
        "mcp-refresh-dead",
        oauth,
        mcp.endpoint,
      );
      yield* oauth.clearRequests;

      yield* client.connections.refresh({
        params: { owner: "org", integration: slug, name },
      });

      const registers = yield* registrationRequests(oauth);
      expect(
        registers,
        "a dead-grant tool refresh must not dynamically register a fresh OAuth client",
      ).toEqual([]);

      const reread = yield* client.connections.get({
        params: { owner: "org", integration: slug, name },
      });
      console.info(`[BUG repro] post-refresh health: ${JSON.stringify(reread.lastHealth ?? null)}`);
      expect(
        reread.lastHealth?.status,
        "the recorded dead grant presents as expired on the connection read",
      ).toBe("expired");
      expect(
        reread.lastHealth?.detail,
        "the provider rejection detail survives to the user",
      ).toContain("Grant not found");
    }),
  ),
);

scenario(
  "MCP OAuth · a bearer rejected during tools/list after a successful handshake surfaces reconnect without re-registering",
  {
    timeout: 180_000,
  },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      const oauth = yield* serveOAuthTestServer({
        scopes: ["channels:history", "users:read"],
      });
      const mcp = yield* serveTokenGatedMcpServer(oauth);
      const { slug } = yield* seedDcrMcpOAuthConnection(
        client,
        "mcp-refresh-list-401",
        oauth,
        mcp.endpoint,
      );

      // Baseline: with the bearer honoured, the refresh syncs the real catalog.
      const synced = yield* client.connections.refresh({
        params: { owner: "org", integration: slug, name },
      });
      expect(
        synced.map((tool) => String(tool.name)),
        "the healthy connection syncs the server's catalog",
      ).toEqual(["simple_echo"]);

      // Revocation landing between the handshake and the listing: the server
      // keeps honouring the bearer for `initialize` but answers every
      // `tools/list` with the auth wall. The connect-path 401 classification
      // never fires — the reauthorization signal must survive the listing
      // failure instead.
      yield* mcp.rejectSessionMethod("tools/list", 401);
      yield* oauth.clearRequests;

      const refreshed = yield* client.connections.refresh({
        params: { owner: "org", integration: slug, name },
      });

      const registers = yield* registrationRequests(oauth);
      expect(
        registers,
        "a noninteractive tool refresh must not dynamically register a fresh OAuth client",
      ).toEqual([]);

      expect(
        refreshed.map((tool) => String(tool.name)),
        "the previously synced catalog is preserved through the failed refresh",
      ).toEqual(["simple_echo"]);

      const reread = yield* client.connections.get({
        params: { owner: "org", integration: slug, name },
      });
      console.info(`[BUG repro] post-refresh health: ${JSON.stringify(reread.lastHealth ?? null)}`);
      expect(
        reread.lastHealth?.status,
        "a post-handshake 401 during listing is a reauthorization condition, not an anonymous degraded sync",
      ).toBe("expired");
    }),
  ),
);
