import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import {
  MICROSOFT_AUTH_TEMPLATE_SLUG,
  MICROSOFT_GRAPH_ALL_PRESET_IDS,
  MICROSOFT_GRAPH_DELEGATED_DEFAULT_SCOPES,
} from "@executor-js/plugin-microsoft";
import { microsoftHttpPlugin } from "@executor-js/plugin-microsoft/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([microsoftHttpPlugin()] as const);

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
        const added = yield* client.microsoft.addGraph({
          payload: {
            presetIds: [...MICROSOFT_GRAPH_ALL_PRESET_IDS],
            customScopes: [],
            slug: integration,
            name: "Microsoft Graph (full)",
          },
        });
        expect(added.slug, "the full Graph source keeps the requested slug").toBe(integration);
        expect(
          added.toolCount,
          "adding every Graph workload extracts the whole catalog (thousands of operations)",
        ).toBeGreaterThan(5_000);

        const config = yield* client.microsoft.getConfig({ params: { slug: integration } });
        expect(config?.microsoftGraphPresetIds, "every Graph workload preset is persisted").toEqual(
          [...MICROSOFT_GRAPH_ALL_PRESET_IDS],
        );
        expect(
          config?.microsoftGraphCoversFullGraph,
          "selecting every workload is recognized as full Graph",
        ).toBe(true);
        expect(
          config?.microsoftGraphScopes,
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
        yield* client.microsoft
          .removeGraph({ params: { slug: IntegrationSlug.make(integration) } })
          .pipe(Effect.ignore);
      }),
    );
  }),
);
