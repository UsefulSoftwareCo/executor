import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { IntegrationSlug } from "./ids";
import { definePlugin } from "./plugin";
import { makeTestWorkspaceHarness, memoryCredentialsPlugin } from "./test-config";
import { serveOAuthTestServer } from "./testing/oauth-test-server";

const INTEG = IntegrationSlug.make("acme");

const AUTHORIZATION_URL = "https://as.example/authorize";
const TOKEN_URL = "https://as.example/token";

const cimdPlugin = definePlugin(() => ({
  id: "acme" as const,
  storage: () => ({}),
  describeAuthMethods: () => [
    {
      id: "oauth",
      label: "OAuth",
      kind: "oauth" as const,
      template: "oauth",
      oauth: {
        authorizationUrl: AUTHORIZATION_URL,
        tokenUrl: TOKEN_URL,
        supportsClientIdMetadataDocument: true,
      },
    },
  ],
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: INTEG,
        description: "Acme",
        config: {},
      }),
  }),
}))();

const plugins = [memoryCredentialsPlugin(), cimdPlugin] as const;

describe("oauth Client ID Metadata Document deployment capability", () => {
  it.effect("probe reports CIMD when the AS advertises it and the deployment can serve it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({
          clientIdMetadataDocumentSupported: true,
        });
        const { executor } = yield* makeTestWorkspaceHarness();

        const probe = yield* executor.oauth.probe({ url: server.mcpResourceUrl });
        expect(probe.clientIdMetadataDocumentSupported).toBe(true);
        expect(probe.registrationEndpoint).toBe(server.registrationEndpoint);
      }),
    ),
  );

  it.effect("probe hides CIMD when the deployment cannot serve the document", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({
          clientIdMetadataDocumentSupported: true,
        });
        const { executor } = yield* makeTestWorkspaceHarness({
          oauthClientIdMetadataDocumentEnabled: false,
        });

        const probe = yield* executor.oauth.probe({ url: server.mcpResourceUrl });
        expect(probe.clientIdMetadataDocumentSupported).toBe(false);
        expect(probe.registrationEndpoint).toBe(server.registrationEndpoint);
      }),
    ),
  );

  it.effect("catalog oauth methods keep the CIMD flag when the deployment can serve it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();

        const integration = yield* executor.integrations.get(INTEG);
        expect(integration?.authMethods).toEqual([
          {
            id: "oauth",
            label: "OAuth",
            kind: "oauth",
            template: "oauth",
            oauth: {
              authorizationUrl: AUTHORIZATION_URL,
              tokenUrl: TOKEN_URL,
              supportsClientIdMetadataDocument: true,
            },
          },
        ]);
      }),
    ),
  );

  it.effect("catalog oauth methods drop the CIMD flag when the deployment cannot serve it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* makeTestWorkspaceHarness({
          plugins,
          oauthClientIdMetadataDocumentEnabled: false,
        });
        yield* executor.acme.seed();

        const integration = yield* executor.integrations.get(INTEG);
        expect(integration?.authMethods).toEqual([
          {
            id: "oauth",
            label: "OAuth",
            kind: "oauth",
            template: "oauth",
            oauth: {
              authorizationUrl: AUTHORIZATION_URL,
              tokenUrl: TOKEN_URL,
              supportsClientIdMetadataDocument: false,
            },
          },
        ]);
      }),
    ),
  );
});
