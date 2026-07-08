import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import {
  MICROSOFT_AUTH_TEMPLATE_SLUG,
  MICROSOFT_GRAPH_ALL_PRESET_IDS,
  MICROSOFT_GRAPH_DELEGATED_DEFAULT_SCOPES,
  MICROSOFT_GRAPH_OPENAPI_URL,
  microsoftCatalog,
  microsoftGraphAdapter,
} from "@executor-js/plugin-microsoft";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([
  openApiHttpPlugin({ presets: microsoftCatalog, specFormats: [microsoftGraphAdapter] }),
] as const);

type ToolView = {
  readonly name: string;
};

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

// Adding *every* Graph workload pulls the full Microsoft Graph OpenAPI document
// (~37MB, ~16.5k operations) and persists a binding per operation. That whole-
// document path used to 503 on the Cloudflare worker: parsing the spec, and
// then re-parsing it on every tools/list, each rebuilt a ~300MB JS tree that
// blew the 128MB isolate. This scenario is the regression guard for both sites
// at real scale: the add streams the compile + persist, and tools/list serves
// the catalog back from the persisted bindings (+ the content-addressed defs
// blob) without ever re-parsing the spec. It drives only the public API, so a
// green run is evidence the full catalog lands and serves end to end.
scenario(
  "Microsoft Graph: the full catalog adds and serves without re-parsing the spec",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeApiClient(api, identity);

    const integration = unique("msgraph_full");
    const connection = ConnectionName.make("main");

    yield* Effect.ensuring(
      Effect.gen(function* () {
        // Add path (1st former OOM site): the full spec is fetched and
        // stream-compiled into one persisted binding per operation.
        const added = yield* client.openapi.addSpec({
          payload: {
            spec: {
              kind: "url",
              url: `${MICROSOFT_GRAPH_OPENAPI_URL}#preset=${MICROSOFT_GRAPH_ALL_PRESET_IDS[0]}`,
            },
            slug: integration,
            name: "Microsoft Graph (full)",
            family: "microsoft",
            specFormat: "microsoft-graph",
          },
        });
        expect(added.slug, "the full Graph source keeps the requested slug").toBe(integration);
        expect(
          added.toolCount,
          "adding every Graph workload extracts the whole catalog (thousands of operations)",
        ).toBeGreaterThan(5_000);

        const config = yield* client.openapi.getConfig({ params: { slug: integration } });
        const delegatedScopes = config?.authenticationTemplate?.flatMap((template) =>
          template.slug === MICROSOFT_AUTH_TEMPLATE_SLUG && template.kind === "oauth2"
            ? [...template.scopes]
            : [],
        );
        expect(
          delegatedScopes,
          "full Graph delegates the app-registration default scope set",
        ).toEqual([...MICROSOFT_GRAPH_DELEGATED_DEFAULT_SCOPES]);

        yield* client.connections.create({
          payload: {
            owner: "org",
            name: connection,
            integration: IntegrationSlug.make(integration),
            template: AuthTemplateSlug.make(MICROSOFT_AUTH_TEMPLATE_SLUG),
            value: "token-xyz",
          },
        });

        // Serve path (2nd former OOM site): tools/list rebuilds the catalog from
        // the persisted bindings. The whole catalog must come back, with real
        // descriptions, and without re-parsing the 37MB spec.
        const tools = yield* client.tools.list({
          query: { integration: IntegrationSlug.make(integration), connection },
        });
        expect(
          tools.length,
          "the served catalog returns the whole set of operations, not a re-parse failure",
        ).toBeGreaterThan(5_000);

        const names = tools.map((tool: ToolView) => tool.name);
        const messageTools = names.filter((name) => name.toLowerCase().includes("message"));
        const siteTools = names.filter((name) => name.toLowerCase().includes("site"));
        const userTools = names.filter((name) => name.toLowerCase().includes("user"));
        expect(messageTools, "the served catalog spans mail operations").not.toEqual([]);
        expect(siteTools, "the served catalog spans SharePoint site operations").not.toEqual([]);
        expect(userTools, "the served catalog spans directory user operations").not.toEqual([]);
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
      }),
    );
  }),
);
