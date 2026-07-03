// Cloud: OAuth as a credential mechanism, over the wire. `probe` discovers an
// authorization server's metadata, `createClient` registers an owner-scoped
// OAuth app, and the authorization-code flow (`start` → user consent →
// `complete`) mints a Connection — every hop real: the typed client drives the
// product API while a real OAuth authorization server runs inside the scenario
// on 127.0.0.1 (the dev server exchanges the code against it directly).
//
// Ported from apps/cloud/src/mcp/mcp-oauth.node.test.ts, extended to cover
// `complete` (the original stopped at the redirect).
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  OAuthState,
} from "@executor-js/sdk/shared";
import { serveOAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

/** Narrow a `start` result to the redirect arm, failing with what came back. */
const redirected = <R extends { status: string }>(
  result: R,
): Extract<R, { status: "redirect" }> => {
  if (result.status !== "redirect") {
    throw new Error(`oauth.start did not redirect: ${JSON.stringify(result)}`);
  }
  return result as Extract<R, { status: "redirect" }>;
};

scenario(
  "OAuth · probe discovers an authorization server's endpoints from its issuer URL",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const oauth = yield* serveOAuthTestServer();
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);

      const probed = yield* client.oauth.probe({ payload: { url: oauth.issuerUrl } });
      expect(probed.authorizationUrl, "probe found the authorization endpoint").toBe(
        oauth.authorizationEndpoint,
      );
      expect(probed.tokenUrl, "probe found the token endpoint").toBe(oauth.tokenEndpoint);
    }),
  ),
);

scenario(
  "OAuth · a registered OAuth app is listed for its owner without leaking the secret",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const oauth = yield* serveOAuthTestServer();
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const slug = OAuthClientSlug.make(unique("oauthc"));

      const created = yield* client.oauth.createClient({
        payload: {
          owner: "org",
          slug,
          authorizationUrl: oauth.authorizationEndpoint,
          tokenUrl: oauth.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        },
      });
      expect(created.client, "the app keeps the requested slug").toBe(slug);

      const clients = yield* client.oauth.listClients();
      const mine = clients.find((entry) => entry.slug === slug);
      expect(mine, "the registered app appears in the owner's list").toMatchObject({
        owner: "org",
        slug,
        grant: "authorization_code",
        clientId: "test-client",
      });
      expect(
        JSON.stringify(clients),
        "the client secret never appears in the list projection",
      ).not.toContain("test-secret");
    }),
  ),
);

scenario(
  "OAuth · the authorization-code flow mints a connection (start → consent → complete)",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const oauth = yield* serveOAuthTestServer();
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);

      // An integration that declares an oauth auth template — the integration
      // is what the minted connection attaches to.
      const integration = IntegrationSlug.make(unique("oauthint"));
      yield* client.openapi.addSpec({
        payload: {
          spec: {
            kind: "blob",
            value: JSON.stringify({
              openapi: "3.0.3",
              info: { title: "OAuth-protected API", version: "1.0.0" },
              paths: {
                "/me": {
                  get: {
                    operationId: "getMe",
                    tags: ["default"],
                    responses: { "200": { description: "the caller" } },
                  },
                },
              },
            }),
          },
          slug: integration,
          baseUrl: "http://127.0.0.1:59999",
          authenticationTemplate: [
            {
              slug: "oauth",
              kind: "oauth2",
              authorizationUrl: oauth.authorizationEndpoint,
              tokenUrl: oauth.tokenEndpoint,
              scopes: ["read"],
            },
          ],
        },
      });

      const clientSlug = OAuthClientSlug.make(unique("oauthc"));
      yield* client.oauth.createClient({
        payload: {
          owner: "org",
          slug: clientSlug,
          authorizationUrl: oauth.authorizationEndpoint,
          tokenUrl: oauth.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        },
      });

      // start: the product persists a session and hands back the authorize URL.
      const started = redirected(
        yield* client.oauth.start({
          payload: {
            client: clientSlug,
            clientOwner: "org",
            owner: "org",
            name: ConnectionName.make("main"),
            integration,
            template: AuthTemplateSlug.make("oauth"),
          },
        }),
      );
      expect(started.authorizationUrl, "the redirect points at the authorization server").toContain(
        oauth.authorizationEndpoint,
      );

      // The user consents on the authorization server (headless here): the
      // authorize page bounces to the login form, and submitting credentials
      // redirects back to the product's callback with an authorization code.
      const authorize = yield* Effect.promise(() =>
        fetch(started.authorizationUrl, { redirect: "manual" }),
      );
      expect(authorize.status, "the authorize endpoint sends the user to log in").toBe(302);
      const consent = yield* Effect.promise(() =>
        fetch(authorize.headers.get("location") ?? "", {
          method: "POST",
          redirect: "manual",
          headers: {
            authorization: `Basic ${Buffer.from("alice:password").toString("base64")}`,
          },
        }),
      );
      expect(consent.status, "granting consent redirects back to the product").toBe(302);
      const callback = new URL(consent.headers.get("location") ?? "");
      // Since #1235 ("preserve OAuth popup session state", commit 1d6363f8) the
      // provider-facing state is a base64url JSON envelope
      // ({ state, orgSlug } — packages/core/sdk/src/oauth.ts) so the callback
      // edge can pick the right organization before completing the flow; the
      // raw session state lives inside it, not on the wire directly.
      const envelope = JSON.parse(
        Buffer.from(callback.searchParams.get("state") ?? "", "base64url").toString("utf8"),
      ) as { state: string; orgSlug: string };
      expect(envelope.state, "the callback's envelope carries the session's state").toBe(
        String(started.state),
      );
      expect(envelope.orgSlug, "the envelope carries the org the flow started in").toBeTruthy();
      const code = callback.searchParams.get("code");
      expect(code, "the callback carries an authorization code").not.toBeNull();

      // complete: the product exchanges the code and mints the connection.
      const connection = yield* client.oauth.complete({
        payload: { state: started.state, code: code ?? "" },
      });
      expect(connection, "the minted connection is bound to the integration").toMatchObject({
        owner: "org",
        name: "main",
        integration,
        template: "oauth",
        oauthClient: clientSlug,
      });

      const connections = yield* client.connections.list({ query: { integration } });
      expect(
        connections.map((c) => `${c.owner}/${String(c.name)}`),
        "the connection is listed for the integration",
      ).toContain("org/main");
    }),
  ),
);

scenario(
  "OAuth · cancelling an unknown session is idempotent",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeClient(api, identity);

    const cancelled = yield* client.oauth.cancel({
      payload: { state: OAuthState.make("oauth2_session_does_not_exist") },
    });
    expect(cancelled.cancelled, "cancel reports success even for an unknown session").toBe(true);
  }),
);
