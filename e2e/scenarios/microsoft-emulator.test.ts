import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { createEmulator, type Emulator, type IssuedCredential } from "@executor-js/emulate";
import { MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG } from "@executor-js/plugin-microsoft";
import { microsoftHttpPlugin } from "@executor-js/plugin-microsoft/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([microsoftHttpPlugin()] as const);

type OAuthTemplateView = {
  readonly slug: string;
  readonly kind: string;
  readonly scopes?: readonly string[];
};

type ToolView = {
  readonly name: string;
};

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

const availablePort = Effect.callback<number>((resume) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close(() => {
      resume(Effect.succeed(port));
    });
  });
});

const microsoftEmulator = Effect.acquireRelease(
  Effect.gen(function* () {
    const port = yield* availablePort;
    return yield* Effect.promise(() => createEmulator({ service: "microsoft", port }));
  }),
  (emulator: Emulator) => Effect.promise(() => emulator.close()).pipe(Effect.ignore),
);

const requireOAuthClientCredential = (credential: IssuedCredential) =>
  Effect.gen(function* () {
    if (
      credential.client_id &&
      credential.client_secret &&
      credential.authorization_url &&
      credential.token_url
    ) {
      return {
        clientId: credential.client_id,
        clientSecret: credential.client_secret,
        authorizationUrl: credential.authorization_url,
        tokenUrl: credential.token_url,
      };
    }
    return yield* Effect.die("Microsoft emulator returned incomplete OAuth client credentials.");
  });

const listUsersCode = (integration: string) => `
const found = await tools.search({ namespace: ${JSON.stringify(integration)}, query: "list users", limit: 10 });
const item = found.items.find((candidate) => candidate.path.includes("graphUser"));
if (!item) return { ok: false, error: "graph users tool not found", found };
let callable = tools;
for (const segment of item.path.split(".")) callable = callable[segment];
const result = await callable({});
return { ok: result.ok, path: item.path, result: result.ok ? result.data : result.error };
`;

scenario(
  "Microsoft · client credentials against the emulator mint a Graph connection and call /users",
  {
    // Blocked (pre-existing, not this PR): `microsoft.addGraph` only accepts the
    // canonical Graph spec in the streamable block-YAML profile — it structurally
    // splits the doc to avoid OOMing the 128MB Workers isolate on the real 37MB
    // spec (packages/plugins/microsoft/src/sdk/graph.ts), and hard-errors on
    // anything else. The @executor-js/emulate Microsoft emulator serves a small
    // custom Graph spec that isn't in that profile, so addGraph rejects it. Fix
    // needs the emulator to serve a block-YAML-profile Graph spec (or a
    // non-Workers compile path); tracked separately.
    skip: "microsoft.addGraph requires the canonical block-YAML Graph spec; the emulator spec is not in that profile",
    timeout: 180_000,
  },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const emulator = yield* microsoftEmulator;

      const integration = unique("msgraph");
      const oauthClient = OAuthClientSlug.make(unique("msgraph_app"));
      const connection = ConnectionName.make("machine");
      const credential = yield* Effect.promise(() =>
        emulator.credentials.mint({ type: "oauth-client-credentials", name: "Executor E2E Graph" }),
      );
      const oauth = yield* requireOAuthClientCredential(credential);

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* client.microsoft.addGraph({
            payload: {
              presetIds: ["users"],
              customScopes: [],
              slug: integration,
              name: "Microsoft Graph Emulator",
              baseUrl: emulator.url,
              specUrl: emulator.openapiUrl,
            },
          });

          const config = yield* client.microsoft.getConfig({
            params: { slug: integration },
          });
          const appOnlyTemplate = config?.authenticationTemplate?.find(
            (template: OAuthTemplateView) =>
              template.slug === MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG,
          );
          expect(
            appOnlyTemplate?.kind,
            "the Microsoft source exposes an app-only OAuth method",
          ).toBe("oauth2");
          expect(
            appOnlyTemplate?.kind === "oauth2" ? appOnlyTemplate.scopes : [],
            "client credentials use the real Microsoft Graph .default scope",
          ).toEqual(["https://graph.microsoft.com/.default"]);

          yield* client.oauth.createClient({
            payload: {
              owner: "org",
              slug: oauthClient,
              authorizationUrl: oauth.authorizationUrl,
              tokenUrl: oauth.tokenUrl,
              grant: "client_credentials",
              clientId: oauth.clientId,
              clientSecret: oauth.clientSecret,
            },
          });

          const started = yield* client.oauth.start({
            payload: {
              client: oauthClient,
              clientOwner: "org",
              owner: "org",
              name: connection,
              integration: IntegrationSlug.make(integration),
              template: AuthTemplateSlug.make(MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG),
            },
          });
          expect(started.status, "client credentials OAuth completes without browser consent").toBe(
            "connected",
          );

          const tools = yield* client.tools.list({
            query: { integration: IntegrationSlug.make(integration), connection },
          });
          expect(
            tools.map((tool: ToolView) => tool.name),
            "the Graph /users operation is available for the app-only connection",
          ).toContain("users.graphUserList");

          const executed = yield* client.executions.execute({
            payload: { code: listUsersCode(integration) },
          });
          expect(executed.status, "the Graph tool execution completed").toBe("completed");
          if (executed.status !== "completed") return;
          expect(executed.isError, executed.text).toBe(false);
          const body = JSON.parse(executed.text) as {
            readonly ok?: boolean;
            readonly result?: { readonly value?: readonly unknown[] };
          };
          expect(body.ok, executed.text).toBe(true);
          expect(Array.isArray(body.result?.value), executed.text).toBe(true);

          const ledger = yield* Effect.promise(() => emulator.ledger.list());
          const tokenRequest = ledger.find((entry) => entry.path === "/oauth2/v2.0/token");
          expect(tokenRequest?.response.status, "Executor exchanged client credentials").toBe(200);
          expect(
            tokenRequest?.request.body,
            "the token exchange requested Microsoft Graph .default",
          ).toMatchObject({
            grant_type: "client_credentials",
            scope: "https://graph.microsoft.com/.default",
          });

          const usersRequest = ledger.find((entry) => entry.operationId === "graphUser_List");
          expect(
            usersRequest?.response.status,
            "Executor called the emulator Graph /users API",
          ).toBe(200);
        }),
        Effect.gen(function* () {
          yield* client.connections.remove({
            params: {
              owner: "org",
              integration: IntegrationSlug.make(integration),
              name: connection,
            },
          });
          yield* client.oauth.removeClient({
            params: { slug: oauthClient },
            payload: { owner: "org" },
          });
          yield* client.microsoft.removeGraph({ params: { slug: integration } });
        }).pipe(Effect.ignore),
      );
    }),
  ),
);
