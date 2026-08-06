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
const MICROSOFT_FILES_SPEC_URL = `${MICROSOFT_GRAPH_OPENAPI_URL}#preset=${MICROSOFT_FILES_PRESET_ID}`;
const MICROSOFT_FILES_DELEGATED_SCOPES = [
  "offline_access",
  "User.Read",
  "Files.ReadWrite.All",
  "Sites.ReadWrite.All",
] as const;
const MICROSOFT_FILES_AUTH_TEMPLATE = microsoftCatalog
  .filter((preset) => preset.id === `microsoft-${MICROSOFT_FILES_PRESET_ID}`)
  .flatMap((preset) => preset.authTemplate ?? [])
  .flatMap((template) =>
    template.kind === "oauth2" ? [{ ...template, scopes: [...template.scopes] }] : [],
  );

// The real add-integration flow previews the selected catalog service before it
// submits the add request. The preview parses the extracted Microsoft Graph
// spec, then the add must still stream-compile and persist one binding per
// operation. This guards that sequence as well as tools/list serving from the
// persisted bindings and content-addressed defs blob without re-parsing Graph.
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
        // Match AddOpenApiIntegration: analyze the URL first, then submit the
        // preset's explicit auth template and empty base-URL override. Supplying
        // both keeps addSpec on the streaming persistence path instead of having
        // it derive defaults by previewing the spec again inside the add call.
        const preview = yield* client.openapi.previewSpec({
          payload: {
            spec: MICROSOFT_FILES_SPEC_URL,
            specFormat: "microsoft-graph",
          },
        });
        expect(
          preview.operationCount,
          "previewing the Microsoft files service parses its focused Graph subtree",
        ).toBeGreaterThan(10);

        const added = yield* client.openapi.addSpec({
          payload: {
            spec: {
              kind: "url",
              url: MICROSOFT_FILES_SPEC_URL,
            },
            slug: integration,
            name: "Microsoft Graph Files",
            baseUrl: "",
            family: "microsoft",
            specFormat: "microsoft-graph",
            authenticationTemplate: MICROSOFT_FILES_AUTH_TEMPLATE,
          },
        });
        expect(added.slug, "the Microsoft files integration keeps the requested slug").toBe(
          integration,
        );
        expect(
          added.toolCount,
          "adding the files catalog service extracts a focused Graph operation subtree",
        ).toBeGreaterThan(10);
        expect(
          preview.operationCount,
          "preview and streaming persistence apply the same Microsoft workload filter",
        ).toBe(added.toolCount);

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
