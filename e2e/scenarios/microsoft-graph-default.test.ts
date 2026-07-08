import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import {
  MICROSOFT_AUTH_TEMPLATE_SLUG,
  MICROSOFT_AUTHORIZATION_URL,
  MICROSOFT_GRAPH_DEFAULT_PRESET_IDS,
  MICROSOFT_GRAPH_OPENAPI_URL,
  MICROSOFT_TOKEN_URL,
  microsoftCatalog,
  microsoftGraphAdapter,
} from "@executor-js/plugin-microsoft";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([
  openApiHttpPlugin({ presets: microsoftCatalog, specFormats: [microsoftGraphAdapter] }),
] as const);

type ToolView = {
  readonly name: string;
};

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

// Compiling the ~37MB Graph spec inside dev workerd needs more headroom than
// GitHub's 2-core runners have: /api/microsoft/graph 500s and the dev stack is
// dead for every scenario after it in the shard. Local runs (and the
// production Workers streaming path) are unaffected — CI-only quarantine.
const CI_GRAPH_SPEC_SKIP = process.env.CI
  ? "compiling the full Microsoft Graph spec exhausts the 2-core CI runner and kills the dev stack for the rest of the shard"
  : undefined;

scenario(
  "Microsoft Graph: default add stores common Microsoft 365 workloads",
  { timeout: 180_000, skip: CI_GRAPH_SPEC_SKIP },
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeApiClient(api, identity);

    const integration = unique("msgraph_default");
    const connection = ConnectionName.make("main");
    const oauthClient = OAuthClientSlug.make(unique("msgraph_app"));

    yield* Effect.ensuring(
      Effect.gen(function* () {
        const added = yield* client.openapi.addSpec({
          payload: {
            spec: {
              kind: "url",
              url: `${MICROSOFT_GRAPH_OPENAPI_URL}#preset=${MICROSOFT_GRAPH_DEFAULT_PRESET_IDS[0]}`,
            },
            slug: integration,
            name: "Microsoft Graph Defaults",
            family: "microsoft",
            specFormat: "microsoft-graph",
          },
        });
        expect(added.slug, "the Microsoft Graph source keeps the requested slug").toBe(integration);
        expect(
          added.toolCount,
          "the default Microsoft Graph add extracts common user-facing operations",
        ).toBeGreaterThan(100);

        const config = yield* client.openapi.getConfig({
          params: { slug: integration },
        });
        const delegatedScopes = config?.authenticationTemplate?.flatMap((template) =>
          template.slug === MICROSOFT_AUTH_TEMPLATE_SLUG && template.kind === "oauth2"
            ? [...template.scopes]
            : [],
        );
        expect(
          delegatedScopes,
          "default delegated OAuth asks for common workload scopes",
        ).toContain("User.Read");

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
          "default Microsoft Graph OAuth authorize URLs stay under ordinary proxy limits",
        ).toBeLessThan(2_000);
        expect(
          authorizeUrl.searchParams.get("scope"),
          "default Microsoft Graph OAuth asks for common workload scopes",
        ).toBe(delegatedScopes?.join(" "));

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
          "the retrieved catalog includes Microsoft message operations",
        ).not.toEqual([]);
        expect(siteTools, "the retrieved catalog includes SharePoint site operations").not.toEqual(
          [],
        );
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
        yield* client.openapi
          .removeSpec({ params: { slug: IntegrationSlug.make(integration) } })
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
