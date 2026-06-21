import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import {
  MICROSOFT_AUTH_TEMPLATE_SLUG,
  MICROSOFT_AUTHORIZATION_URL,
  MICROSOFT_GRAPH_DELEGATED_DEFAULT_SCOPES,
  MICROSOFT_GRAPH_DEFAULT_PRESET_IDS,
  MICROSOFT_TOKEN_URL,
} from "@executor-js/plugin-microsoft";
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

type ToolView = {
  readonly name: string;
};

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

scenario(
  "Microsoft Graph: default add stores the full Graph operation catalog",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeApiClient(api, identity);

    const integration = unique("msgraph_full");
    const connection = ConnectionName.make("main");
    const oauthClient = OAuthClientSlug.make(unique("msgraph_app"));

    yield* Effect.ensuring(
      Effect.gen(function* () {
        const added = yield* client.microsoft.addGraph({
          payload: {
            presetIds: [...MICROSOFT_GRAPH_DEFAULT_PRESET_IDS],
            customScopes: [],
            slug: integration,
            name: "Microsoft Graph Full Catalog",
          },
        });
        expect(added.slug, "the full Graph source keeps the requested slug").toBe(integration);
        expect(
          added.toolCount,
          "the default Microsoft Graph add extracts a large operation catalog",
        ).toBeGreaterThan(1_000);

        const config = yield* client.microsoft.getConfig({
          params: { slug: integration },
        });
        expect(config?.microsoftGraphPresetIds, "all default Graph groups are persisted").toEqual([
          ...MICROSOFT_GRAPH_DEFAULT_PRESET_IDS,
        ]);
        expect(config?.microsoftGraphCoversFullGraph, "the default selection is full Graph").toBe(
          true,
        );
        expect(
          config?.microsoftGraphScopes,
          "full Graph delegated OAuth uses the app registration default scope",
        ).toEqual([...MICROSOFT_GRAPH_DELEGATED_DEFAULT_SCOPES]);

        yield* client.oauth.createClient({
          payload: {
            owner: "org",
            slug: oauthClient,
            authorizationUrl: MICROSOFT_AUTHORIZATION_URL,
            tokenUrl: MICROSOFT_TOKEN_URL,
            grant: "authorization_code",
            clientId: "client-id",
            clientSecret: "client-secret",
          },
        });

        const started = yield* client.oauth.start({
          payload: {
            client: oauthClient,
            clientOwner: "org",
            owner: "org",
            name: ConnectionName.make("oauth"),
            integration: IntegrationSlug.make(integration),
            template: AuthTemplateSlug.make(MICROSOFT_AUTH_TEMPLATE_SLUG),
          },
        });
        expect(started.status, "authorization-code OAuth returns a browser redirect").toBe(
          "redirect",
        );
        const authorizationUrl = started.status === "redirect" ? started.authorizationUrl : "";
        const authorizeUrl = new URL(authorizationUrl || "https://invalid.example");
        expect(
          authorizeUrl.toString().length,
          "full Graph OAuth authorize URLs stay under ordinary proxy limits",
        ).toBeLessThan(2_000);
        expect(
          authorizeUrl.searchParams.get("scope"),
          "full Graph OAuth asks Microsoft for the app registration default scope",
        ).toBe(MICROSOFT_GRAPH_DELEGATED_DEFAULT_SCOPES.join(" "));

        yield* client.connections.create({
          payload: {
            owner: "org",
            name: connection,
            integration: IntegrationSlug.make(integration),
            template: AuthTemplateSlug.make(MICROSOFT_AUTH_TEMPLATE_SLUG),
            value: "token-xyz",
          },
        });

        const tools = yield* client.tools.list({
          query: { integration: IntegrationSlug.make(integration), connection },
        });
        const names = tools.map((tool: ToolView) => tool.name);
        const messageTools = names.filter((name) => name.toLowerCase().includes("message"));
        const siteTools = names.filter((name) => name.toLowerCase().includes("site"));
        expect(
          messageTools,
          "the retrieved full catalog includes Microsoft message operations",
        ).not.toEqual([]);
        expect(
          siteTools,
          "the retrieved full catalog includes SharePoint site operations",
        ).not.toEqual([]);
      }),
      Effect.gen(function* () {
        yield* client.connections
          .remove({
            params: {
              owner: "org",
              integration: IntegrationSlug.make(integration),
              name: connection,
            },
          })
          .pipe(Effect.ignore);
        yield* client.microsoft
          .removeGraph({ params: { slug: IntegrationSlug.make(integration) } })
          .pipe(Effect.ignore);
        yield* client.oauth
          .removeClient({
            params: { slug: oauthClient },
            payload: { owner: "org" },
          })
          .pipe(Effect.ignore);
      }),
    );
  }),
);
