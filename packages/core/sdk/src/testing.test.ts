import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  makeTestWorkspaceLayer,
  memoryCredentialsPlugin,
  OAuthTestServer,
  TestWorkspace,
} from "./testing";

const plugins = [memoryCredentialsPlugin()] as const;

const TestLayer = Layer.mergeAll(makeTestWorkspaceLayer({ plugins }), OAuthTestServer.layer());

layer(TestLayer, { timeout: "15 seconds" })("testing fixtures", (it) => {
  it.effect("TestWorkspace exposes the real executor bound to tenant/subject", () =>
    Effect.gen(function* () {
      const workspace = yield* TestWorkspace.current<typeof plugins>();

      expect(workspace.tenant).toBe("test-tenant");
      expect(workspace.subject).toBe("test-subject");
      // The memory credential provider is registered as the default store.
      expect(yield* workspace.executor.providers.list()).toEqual(["memory"]);
    }),
  );

  it.effect("oauth.probe discovers an authorization server via metadata", () =>
    Effect.gen(function* () {
      const workspace = yield* TestWorkspace.current<typeof plugins>();
      const oauth = yield* OAuthTestServer;

      const probe = yield* workspace.executor.oauth.probe({
        url: oauth.mcpResourceUrl,
      });
      expect(probe.authorizationUrl).toBe(oauth.authorizationEndpoint);
      expect(probe.tokenUrl).toBe(oauth.tokenEndpoint);
    }),
  );

  // removed: executor-driven authorization-code / existing-client / dynamic-dcr
  // OAuth flow cases — v1 strategy + secret-backed client material is gone, and
  // the v2 `oauth.start`/`oauth.complete` flow is stubbed for milestone 1. They
  // will be reintroduced against the v2 OAuthClient model when the flow is wired.

  it.effect(
    "OAuthTestServer can mint a bearer token through the full authorization-code flow",
    () =>
      Effect.gen(function* () {
        const oauth = yield* OAuthTestServer;

        const token = yield* oauth.completeAuthorizationCodeTokenFlow({
          scopes: ["read"],
        });

        expect(token.tokenType).toBe("Bearer");
        expect(token.accessToken).toMatch(/^at_/);
        expect(yield* oauth.acceptsAccessToken(token.accessToken)).toBe(true);
      }),
  );
});
