import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { SecretId } from "./ids";
import { SetSecretInput } from "./secrets";
import {
  makeTestWorkspaceLayer,
  memorySecretsPlugin,
  OAuthTestServer,
  TestWorkspace,
} from "./testing";

const plugins = [memorySecretsPlugin()] as const;

const TestLayer = Layer.mergeAll(makeTestWorkspaceLayer({ plugins }), OAuthTestServer.layer());

layer(TestLayer, { timeout: "15 seconds" })("testing fixtures", (it) => {
  it.effect("TestWorkspace exposes the real executor with an explicit scope stack", () =>
    Effect.gen(function* () {
      const workspace = yield* TestWorkspace.current<typeof plugins>();

      expect(workspace.scopes.map((scope) => String(scope.id))).toEqual(["test-scope"]);
      expect(workspace.executor.scopes.map((scope) => String(scope.id))).toEqual(["test-scope"]);
      expect(yield* workspace.executor.secrets.providers()).toEqual(["memory"]);
    }),
  );

  it.effect("OAuthTestServer completes a real authorization-code OAuth flow", () =>
    Effect.gen(function* () {
      const workspace = yield* TestWorkspace.current<typeof plugins>();
      const oauth = yield* OAuthTestServer;
      const scope = workspace.scopes[0]!;

      yield* workspace.executor.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("oauth-client-id"),
          scope: scope.id,
          name: "OAuth Client ID",
          value: "test-client",
        }),
      );
      yield* workspace.executor.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("oauth-client-secret"),
          scope: scope.id,
          name: "OAuth Client Secret",
          value: "test-secret",
        }),
      );

      const started = yield* workspace.executor.oauth.start({
        endpoint: oauth.resourceUrl,
        connectionId: "test-oauth-authorization-code",
        tokenScope: String(scope.id),
        redirectUrl: "http://127.0.0.1/callback",
        pluginId: "test",
        identityLabel: "OAuth Test",
        strategy: {
          kind: "authorization-code",
          authorizationEndpoint: oauth.authorizationEndpoint,
          tokenEndpoint: oauth.tokenEndpoint,
          clientIdSecretId: "oauth-client-id",
          clientSecretSecretId: "oauth-client-secret",
          scopes: ["read"],
        },
      });

      expect(started.authorizationUrl).not.toBeNull();
      const authorizationUrl = started.authorizationUrl ?? "";
      const callback = yield* oauth.completeAuthorizationCodeFlow({ authorizationUrl });
      const completed = yield* workspace.executor.oauth.complete({
        state: callback.state,
        code: callback.code,
        tokenScope: String(scope.id),
      });

      expect(completed.connectionId).toBe("test-oauth-authorization-code");
      const accessToken = yield* workspace.executor.connections.accessToken(completed.connectionId);
      expect(yield* oauth.acceptsAccessToken(accessToken)).toBe(true);
    }),
  );

  it.effect("OAuthTestServer supports MCP-style dynamic client registration", () =>
    Effect.gen(function* () {
      const workspace = yield* TestWorkspace.current<typeof plugins>();
      const oauth = yield* OAuthTestServer;
      const scope = workspace.scopes[0]!;

      const probe = yield* workspace.executor.oauth.probe({ endpoint: oauth.mcpResourceUrl });
      expect(probe.supportsDynamicRegistration).toBe(true);
      expect(probe.isBearerChallengeEndpoint).toBe(true);

      const started = yield* workspace.executor.oauth.start({
        endpoint: oauth.mcpResourceUrl,
        connectionId: "test-oauth-dynamic-dcr",
        tokenScope: String(scope.id),
        redirectUrl: "http://127.0.0.1/callback",
        pluginId: "test",
        identityLabel: "MCP OAuth Test",
        strategy: { kind: "dynamic-dcr", scopes: ["read"] },
      });

      expect(started.authorizationUrl).not.toBeNull();
      const authorizationUrl = started.authorizationUrl ?? "";
      const callback = yield* oauth.completeAuthorizationCodeFlow({ authorizationUrl });
      const completed = yield* workspace.executor.oauth.complete({
        state: callback.state,
        code: callback.code,
        tokenScope: String(scope.id),
      });

      expect(completed.connectionId).toBe("test-oauth-dynamic-dcr");
      const accessToken = yield* workspace.executor.connections.accessToken(completed.connectionId);
      expect(yield* oauth.acceptsAccessToken(accessToken)).toBe(true);
    }),
  );

  it.effect("dynamic client registration is reused across OAuth start retries", () =>
    Effect.gen(function* () {
      const workspace = yield* TestWorkspace.current<typeof plugins>();
      const oauth = yield* OAuthTestServer;
      const scope = workspace.scopes[0]!;
      yield* oauth.clearRequests;

      const start = () =>
        workspace.executor.oauth.start({
          endpoint: oauth.mcpResourceUrl,
          connectionId: "test-oauth-dcr-retry",
          tokenScope: String(scope.id),
          redirectUrl: "http://127.0.0.1/callback",
          pluginId: "test",
          identityLabel: "MCP OAuth Test",
          strategy: { kind: "dynamic-dcr", scopes: ["read"] },
        });

      const startedA = yield* start();
      const startedB = yield* start();

      expect(startedA.authorizationUrl).not.toBeNull();
      expect(startedB.authorizationUrl).not.toBeNull();
      expect(
        (yield* oauth.requests).filter((request) => request.path === "/register"),
      ).toHaveLength(1);
      expect(new URL(startedB.authorizationUrl ?? "").searchParams.get("client_id")).toBe(
        new URL(startedA.authorizationUrl ?? "").searchParams.get("client_id"),
      );
      expect(new URL(startedB.authorizationUrl ?? "").searchParams.get("scope")).toBe("read");
      expect(new URL(startedB.authorizationUrl ?? "").searchParams.get("resource")).toBe(
        oauth.mcpResourceUrl,
      );
    }),
  );

  it.effect("dynamic client registration is reused after a completed connection reconnect", () =>
    Effect.gen(function* () {
      const workspace = yield* TestWorkspace.current<typeof plugins>();
      const oauth = yield* OAuthTestServer;
      const scope = workspace.scopes[0]!;
      yield* oauth.clearRequests;

      const start = () =>
        workspace.executor.oauth.start({
          endpoint: oauth.mcpResourceUrl,
          connectionId: "test-oauth-dcr-reconnect",
          tokenScope: String(scope.id),
          redirectUrl: "http://127.0.0.1/callback",
          pluginId: "test",
          identityLabel: "MCP OAuth Test",
          strategy: { kind: "dynamic-dcr", scopes: ["read"] },
        });

      const startedA = yield* start();
      const callback = yield* oauth.completeAuthorizationCodeFlow({
        authorizationUrl: startedA.authorizationUrl ?? "",
      });
      yield* workspace.executor.oauth.complete({
        state: callback.state,
        code: callback.code,
        tokenScope: String(scope.id),
      });

      const startedB = yield* start();

      expect(startedB.authorizationUrl).not.toBeNull();
      expect(
        (yield* oauth.requests).filter((request) => request.path === "/register"),
      ).toHaveLength(1);
      expect(new URL(startedB.authorizationUrl ?? "").searchParams.get("client_id")).toBe(
        new URL(startedA.authorizationUrl ?? "").searchParams.get("client_id"),
      );
      expect(new URL(startedB.authorizationUrl ?? "").searchParams.get("scope")).toBe("read");
      expect(new URL(startedB.authorizationUrl ?? "").searchParams.get("resource")).toBe(
        oauth.mcpResourceUrl,
      );
    }),
  );

  it.effect(
    "OAuthTestServer can mint a bearer token through the full authorization-code flow",
    () =>
      Effect.gen(function* () {
        const oauth = yield* OAuthTestServer;

        const token = yield* oauth.completeAuthorizationCodeTokenFlow({ scopes: ["read"] });

        expect(token.tokenType).toBe("Bearer");
        expect(token.accessToken).toMatch(/^at_/);
        expect(yield* oauth.acceptsAccessToken(token.accessToken)).toBe(true);
      }),
  );
});
