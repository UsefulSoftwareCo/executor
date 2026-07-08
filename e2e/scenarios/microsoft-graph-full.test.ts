import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import {
  MICROSOFT_AUTH_TEMPLATE_SLUG,
  MICROSOFT_GRAPH_OPENAPI_URL,
  microsoftCatalog,
  microsoftGraphAdapter,
} from "@executor-js/plugin-openapi/providers/microsoft";
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
const MICROSOFT_FILES_PRESET_ID = "files";
const MICROSOFT_FILES_DELEGATED_SCOPES = [
  "offline_access",
  "User.Read",
  "Files.ReadWrite.All",
  "Sites.ReadWrite.All",
] as const;

// Adding a catalog service extracts only that service's Microsoft Graph subtree
// and persists a binding per operation. This is the regression guard for both
// former worker pressure sites: the add streams compile and persist, and
// tools/list serves from persisted bindings plus the content-addressed defs blob
// without re-parsing the Graph spec.
scenario(
  "Microsoft Graph: the files catalog service adds and serves without re-parsing the spec",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeApiClient(api, identity);

    const integration = unique("msgraph_files");
    const connection = ConnectionName.make("main");

    yield* Effect.ensuring(
      Effect.gen(function* () {
        // Add path, first former OOM site: the Graph spec is fetched and
        // stream-compiled into one persisted binding per selected operation.
        const added = yield* client.openapi.addSpec({
          payload: {
            spec: {
              kind: "url",
              url: `${MICROSOFT_GRAPH_OPENAPI_URL}#preset=${MICROSOFT_FILES_PRESET_ID}`,
            },
            slug: integration,
            name: "Microsoft Graph Files",
            family: "microsoft",
            specFormat: "microsoft-graph",
          },
        });
        expect(added.slug, "the Microsoft files source keeps the requested slug").toBe(integration);
        expect(
          added.toolCount,
          "adding the files catalog service extracts a focused Graph operation subtree",
        ).toBeGreaterThan(10);

        const config = yield* client.openapi.getConfig({ params: { slug: integration } });
        const delegatedScopes = config?.authenticationTemplate?.flatMap((template) =>
          template.slug === MICROSOFT_AUTH_TEMPLATE_SLUG && template.kind === "oauth2"
            ? [...template.scopes]
            : [],
        );
        expect(
          delegatedScopes,
          "the files service delegates only the file-service scope set",
        ).toEqual([...MICROSOFT_FILES_DELEGATED_SCOPES]);

        yield* client.connections.create({
          payload: {
            owner: "org",
            name: connection,
            integration: IntegrationSlug.make(integration),
            template: AuthTemplateSlug.make(MICROSOFT_AUTH_TEMPLATE_SLUG),
            value: "token-xyz",
          },
        });

        // Serve path, second former OOM site: tools/list rebuilds the catalog
        // from persisted bindings, with real descriptions, and without
        // re-parsing the Graph spec.
        const tools = yield* client.tools.list({
          query: { integration: IntegrationSlug.make(integration), connection },
        });
        expect(
          tools.length,
          "the served catalog returns the files operation subtree, not a re-parse failure",
        ).toBeGreaterThan(10);

        const names = tools.map((tool: ToolView) => tool.name);
        const driveTools = names.filter((name) => name.toLowerCase().includes("drive"));
        const shareTools = names.filter((name) => name.toLowerCase().includes("share"));
        expect(driveTools, "the served catalog spans drive operations").not.toEqual([]);
        expect(shareTools, "the served catalog spans sharing operations").not.toEqual([]);
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
