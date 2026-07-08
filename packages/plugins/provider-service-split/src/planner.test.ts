import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { streamOperationBindingsFromStructure, structuralSplit } from "@executor-js/plugin-openapi";

import {
  googlePresetIdForTool,
  microsoftPresetIdsForTool,
  microsoftToolFirstSegmentPresetIds,
  operationStorageKey,
  planMigration,
  verifyPolicyRewriteNeverWidens,
  type BlobRow,
  type ConnectionRow,
  type IntegrationRow,
  type MigrationInput,
  type PluginStorageRow,
  type ToolPolicyRow,
  type ToolRow,
} from "./planner";
import { googleCatalog } from "@executor-js/plugin-openapi/providers/google";

const now = "2026-01-01T00:00:00.000Z";

const integration = (overrides: Partial<IntegrationRow> = {}): IntegrationRow => ({
  tenant: "org_1",
  slug: "google",
  plugin_id: "google",
  name: "Google",
  description: "Google APIs",
  config: {
    googleDiscoveryUrls: ["https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest"],
    specHash: "mono-hash",
    authenticationTemplate: [{ slug: "googleOAuth", kind: "oauth2" }],
  },
  health_check: null,
  config_revised_at: null,
  can_remove: true,
  can_refresh: true,
  created_at: now,
  updated_at: now,
  row_id: "int_1",
  ...overrides,
});

const connection = (overrides: Partial<ConnectionRow> = {}): ConnectionRow => ({
  tenant: "org_1",
  owner: "org",
  subject: "",
  integration: "google",
  name: "main",
  template: "googleOAuth",
  provider: "vault",
  item_ids: { access: "access_item", refresh: "refresh_item" },
  identity_label: "person@example.test",
  description: null,
  last_health: null,
  tools_synced_at: 1,
  oauth_client: "google",
  oauth_client_owner: "org",
  refresh_item_id: "refresh_item",
  expires_at: 2,
  oauth_scope: "calendar gmail",
  oauth_token_url: "https://oauth2.googleapis.com/token",
  provider_state: { token: "metadata" },
  created_at: now,
  updated_at: now,
  row_id: "conn_1",
  ...overrides,
});

const tool = (name: string, overrides: Partial<ToolRow> = {}): ToolRow => ({
  tenant: "org_1",
  owner: "org",
  subject: "",
  integration: "google",
  connection: "main",
  plugin_id: "google",
  name,
  description: "tool",
  input_schema: {},
  output_schema: {},
  annotations: {},
  created_at: now,
  updated_at: now,
  row_id: `tool_${name}`,
  ...overrides,
});

const operation = (name: string, overrides: Partial<PluginStorageRow> = {}): PluginStorageRow => ({
  tenant: "org_1",
  owner: "org",
  subject: "",
  plugin_id: "google",
  collection: "operation",
  key: operationStorageKey("google", name),
  data: {
    integration: "google",
    toolName: name,
    binding: {
      method: "get",
      servers: [],
      pathTemplate: `/${name}`,
      parameters: [],
    },
    description: name,
  },
  created_at: now,
  updated_at: now,
  row_id: `op_${name}`,
  ...overrides,
});

const blob = (key: string, overrides: Partial<BlobRow> = {}): BlobRow => ({
  id: `blob_${key}`,
  namespace: "o:org_1/google",
  key,
  ...overrides,
});

const policy = (pattern: string, overrides: Partial<ToolPolicyRow> = {}): ToolPolicyRow => ({
  tenant: "org_1",
  owner: "org",
  subject: "",
  id: `pol_${pattern.replaceAll(".", "_").replaceAll("*", "star")}`,
  pattern,
  action: "block",
  position: "a0",
  created_at: now,
  updated_at: now,
  row_id: `row_${pattern}`,
  ...overrides,
});

const googleDiscoveryConfig = (urls: readonly string[], specHash = "mono-hash") => ({
  googleDiscoveryUrls: urls,
  specHash,
});

const youtubeDiscoveryUrl = "https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest";

const googleCatalogMethodPrefixFixtures: ReadonlyMap<string, readonly string[]> = new Map([
  ["google-calendar", ["calendar.events.list"]],
  ["google-gmail", ["gmail.users.messages.list"]],
  ["google-sheets", ["sheets.spreadsheets.get"]],
  ["google-drive", ["drive.files.list"]],
  ["google-docs", ["docs.documents.get"]],
  ["google-slides", ["slides.presentations.get"]],
  ["google-forms", ["forms.forms.get"]],
  ["google-tasks", ["tasks.tasks.list"]],
  ["google-people", ["people.people.get"]],
  ["google-photos-library", ["photoslibrary.albums.list"]],
  ["google-photos-picker", ["photospicker.sessions.create"]],
  ["google-chat", ["chat.spaces.list"]],
  ["google-keep", ["keep.notes.list"]],
  ["google-youtube-data", ["youtube.channels.list"]],
  ["google-search-console", ["searchconsole.sites.list", "webmasters.sites.list"]],
  ["google-classroom", ["classroom.courses.list"]],
  [
    "google-admin-directory",
    ["directory.users.list", "admin.customer.devices.chromeos.list", "admin.customers.get"],
  ],
  ["google-admin-reports", ["reports.activities.list", "admin.channels.stop"]],
  ["google-apps-script", ["script.projects.get"]],
  ["google-bigquery", ["bigquery.datasets.list"]],
  ["google-cloud-resource-manager", ["cloudresourcemanager.projects.list"]],
]);

const microsoftDefaultPresetIds = [
  "profile",
  "mail",
  "calendar",
  "contacts",
  "tasks",
  "files",
  "excel",
  "sites",
  "onenote",
  "teams-chat",
  "teams-channels",
  "meetings-calls",
] as const;

const microsoftFixtureTagForFirstSegment = (firstSegment: string): string =>
  firstSegment.replace(/([a-z0-9])([A-Z])/g, "$1 $2");

const microsoftToolFirstSegmentsFromSplitterFixture = () =>
  Effect.gen(function* () {
    const paths = [...microsoftToolFirstSegmentPresetIds.keys()]
      .map(
        (firstSegment) => `  /fixture/${firstSegment}:
    get:
      tags:
        - ${microsoftFixtureTagForFirstSegment(firstSegment)}
      operationId: ${firstSegment}.Get
      responses:
        "200":
          description: OK`,
      )
      .join("\n");
    const structure = structuralSplit(`openapi: 3.0.4
info:
  title: Microsoft Graph Tool Ownership Fixture
  version: v1.0
paths:
${paths}
components: {}
`);
    expect(structure).not.toBeNull();
    const toolNames: string[] = [];
    yield* streamOperationBindingsFromStructure(structure!, { chunkSize: 100 }, (chunk) =>
      Effect.sync(() => {
        toolNames.push(...chunk.map((row) => row.toolName));
      }),
    );
    return new Set(toolNames.map((toolName) => toolName.split(".")[0] ?? ""));
  });

const input = (overrides: Partial<MigrationInput> = {}): MigrationInput => ({
  integrations: [integration()],
  connections: [connection()],
  tools: [tool("calendar.events.list")],
  pluginStorage: [operation("calendar.events.list")],
  blobs: [blob("spec/mono-hash"), blob("defs/mono-hash")],
  policies: [],
  ...overrides,
});

describe("provider service split migration planner", () => {
  it("resolves Google reports, directory, and admin.channels tool prefixes", () => {
    expect(googlePresetIdForTool("reports.activities.list")).toBe("google-admin-reports");
    expect(googlePresetIdForTool("directory.users.list")).toBe("google-admin-directory");
    expect(googlePresetIdForTool("admin.channels.stop")).toBe("google-admin-reports");
    expect(googlePresetIdForTool("admin.channels.stopPost0019dmcn")).toBe("google-admin-reports");
    expect(googlePresetIdForTool("admin.customers.chrome.printers.list")).toBe(
      "google-admin-directory",
    );
    expect(googlePresetIdForTool("admin.customer.devices.chromeos.list")).toBe(
      "google-admin-directory",
    );
  });

  it("keeps Google catalog method prefixes mapped to their owning presets", () => {
    expect([...googleCatalogMethodPrefixFixtures.keys()]).toEqual(
      googleCatalog.map((preset) => preset.id),
    );
    for (const [presetId, methods] of googleCatalogMethodPrefixFixtures) {
      for (const method of methods) {
        expect(googlePresetIdForTool(method), method).toBe(presetId);
      }
    }
  });

  it.effect("keeps Microsoft planner ownership table aligned with splitter tool names", () =>
    Effect.gen(function* () {
      const splitterFirstSegments = yield* microsoftToolFirstSegmentsFromSplitterFixture();

      expect([...splitterFirstSegments].sort()).toEqual(
        [...microsoftToolFirstSegmentPresetIds.keys()].sort(),
      );
      for (const [firstSegment, presetIds] of microsoftToolFirstSegmentPresetIds) {
        expect(microsoftPresetIdsForTool(`${firstSegment}.get`), firstSegment).toEqual(presetIds);
      }
      expect(microsoftPresetIdsForTool("drivesDriveItem.workbook.worksheets.list")).toEqual([
        "files",
        "excel",
      ]);
    }),
  );

  it("plans a single-service monolith split", () => {
    const plan = planMigration(input());

    expect(plan.summary.integrationsCreate).toBe(1);
    expect(plan.summary.connectionsClone).toBe(1);
    expect(plan.orgs[0]?.integrations.map((row) => row.target.pluginId)).toEqual(["openapi"]);
    expect(plan.orgs[0]?.integrations.map((row) => row.target.slug)).toEqual(["google_calendar"]);
    expect(plan.orgs[0]?.deleteMonoliths.map((row) => row.slug)).toEqual(["google"]);
  });

  it("plans a multi-service monolith split from stored Discovery URLs", () => {
    const plan = planMigration(
      input({
        integrations: [
          integration({
            config: {
              googleDiscoveryUrls: [
                "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
                "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest",
              ],
              specHash: "mono-hash",
            },
          }),
        ],
        tools: [tool("calendar.events.list"), tool("gmail.users.messages.send")],
        pluginStorage: [
          operation("calendar.events.list"),
          operation("gmail.users.messages.send"),
          operation("oauth2.userinfo.get"),
        ],
      }),
    );

    expect(plan.orgs[0]?.integrations.map((row) => row.target.slug)).toEqual([
      "google_calendar",
      "google_gmail",
    ]);
    expect(plan.summary.connectionsClone).toBe(2);
  });

  it("models migrated integration serving storage under the new slug", () => {
    const plan = planMigration(input());
    const planned = plan.orgs[0]?.integrations[0];

    expect(planned?.config).toEqual({
      specHash: "mono-hash",
      sourceUrl: "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
      specFormat: "google-discovery",
      family: "google",
      authenticationTemplate: [
        {
          slug: "googleOAuth2",
          kind: "oauth2",
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          scopes: expect.arrayContaining([
            "openid",
            "email",
            "profile",
            "https://www.googleapis.com/auth/calendar",
          ]),
        },
      ],
    });
    expect(planned?.healthCheck).toEqual({
      operation: "calendar.calendarList.list",
    });
    expect(planned?.servingState).toMatchObject({
      specHash: "mono-hash",
      specSource: "google/google",
      specBlobPresent: true,
      defsBlobPresent: true,
      operationsToBuild: 1,
      operationToolNames: ["calendar.events.list"],
    });
    expect(plan.orgs[0]?.blobCopies).toEqual([
      expect.objectContaining({
        sourceNamespace: "o:org_1/google",
        targetNamespace: "o:org_1/openapi",
        key: "spec/mono-hash",
        sourcePresent: true,
      }),
      expect.objectContaining({
        sourceNamespace: "o:org_1/google",
        targetNamespace: "o:org_1/openapi",
        key: "defs/mono-hash",
        sourcePresent: true,
      }),
    ]);
    expect(operationStorageKey("google_calendar", "calendar.events.list")).toMatch(/^op\./);
  });

  it("keeps only the service discovery URL and drops the oauth2 document URL", () => {
    const plan = planMigration(
      input({
        integrations: [
          integration({
            config: {
              googleDiscoveryUrls: [
                "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
                "https://www.googleapis.com/discovery/v1/apis/oauth2/v2/rest",
              ],
              specHash: "mono-hash",
            },
          }),
        ],
        pluginStorage: [operation("calendar.events.list"), operation("oauth2.userinfo.get")],
      }),
    );

    const planned = plan.orgs[0]?.integrations[0];

    expect(planned?.config).toMatchObject({
      sourceUrl: "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
      specFormat: "google-discovery",
      family: "google",
    });
    expect(
      (planned?.config as { readonly sourceUrl?: string } | undefined)?.sourceUrl,
    ).not.toContain("oauth2");
    expect(planned?.servingState.operationToolNames).toEqual(["calendar.events.list"]);
  });

  it("fans out wildcard policies by matched service without widening inventory matches", () => {
    const migrationInput = input({
      integrations: [
        integration({
          config: {
            googleDiscoveryUrls: [
              "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
              "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest",
            ],
            specHash: "mono-hash",
          },
        }),
      ],
      tools: [tool("calendar.events.delete"), tool("gmail.users.messages.delete")],
      pluginStorage: [
        operation("calendar.events.delete"),
        operation("gmail.users.messages.delete"),
      ],
      policies: [policy("google.*")],
    });
    const plan = planMigration(migrationInput);

    expect(plan.orgs[0]?.policies[0]?.afterPatterns).toEqual([
      "google_calendar.*",
      "google_gmail.*",
    ]);
    expect(verifyPolicyRewriteNeverWidens(plan, migrationInput)).toMatchObject({
      ok: true,
      checkedPolicies: 1,
    });
  });

  it("fans restrictive wildcard policies out to every monolith service, not only currently matching tools", () => {
    const migrationInput = input({
      integrations: [
        integration({
          config: {
            googleDiscoveryUrls: [
              "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
              "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest",
              "https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest",
            ],
            specHash: "mono-hash",
          },
        }),
      ],
      tools: [tool("calendar.events.update")],
      pluginStorage: [
        operation("calendar.events.update"),
        operation("gmail.users.messages.update"),
      ],
      policies: [policy("google.*.*.*.*.update")],
    });
    const plan = planMigration(migrationInput);

    expect(plan.orgs[0]?.policies[0]?.afterPatterns).toEqual([
      "google_calendar.*.*.*.*.update",
      "google_gmail.*.*.*.*.update",
      "google_sheets.*.*.*.*.update",
    ]);
    expect(verifyPolicyRewriteNeverWidens(plan, migrationInput)).toMatchObject({
      ok: true,
      checkedPolicies: 1,
      narrowed: [],
    });
  });

  it("hard-errors when a policy would be dropped instead of silently skipped", () => {
    expect(() =>
      planMigration(
        input({
          integrations: [
            integration({
              config: {
                googleDiscoveryUrls: [
                  "https://www.googleapis.com/discovery/v1/apis/searchconsole/v1/rest",
                ],
                specHash: "mono-hash",
              },
            }),
          ],
          tools: [tool("searchconsole.sites.list")],
          pluginStorage: [operation("searchconsole.sites.list")],
          policies: [policy("google.*.*.gmail.users.messages.send")],
        }),
      ),
    ).toThrow(/would be dropped/);
  });

  it("hard-errors when config omits a tool-implied service", () => {
    expect(() =>
      planMigration(
        input({
          tools: [tool("calendar.events.list"), tool("gmail.users.messages.send")],
          pluginStorage: [
            operation("calendar.events.list"),
            operation("gmail.users.messages.send"),
          ],
        }),
      ),
    ).toThrow(/config omits tool-implied service preset\(s\): google-gmail/);
  });

  it("boot-rail mode creates a catalog-backed tool-implied service", () => {
    const plan = planMigration(
      input({
        tools: [tool("calendar.events.list"), tool("gmail.users.messages.send")],
        pluginStorage: [operation("calendar.events.list"), operation("gmail.users.messages.send")],
        bootRailCreateToolImpliedServices: true,
      }),
    );

    expect(plan.orgs[0]?.integrations.map((row) => row.target.slug)).toEqual([
      "google_calendar",
      "google_gmail",
    ]);
  });

  it("records a hard error when a source blob is missing", () => {
    const plan = planMigration(
      input({ blobs: [blob("spec/mono-hash")], collectPolicyErrors: true }),
    );

    expect(plan.orgs[0]?.hardErrors).toEqual([
      "Missing source blob o:org_1/google/defs/mono-hash for migrated OpenAPI service namespace o:org_1/openapi",
    ]);
    expect(plan.summary.hardErrorOrgs).toBe(1);
  });

  it("retargets orphan block policies in boot-rail mode", () => {
    const plan = planMigration(
      input({
        integrations: [
          integration({
            config: {
              googleDiscoveryUrls: [
                "https://www.googleapis.com/discovery/v1/apis/searchconsole/v1/rest",
              ],
              specHash: "mono-hash",
            },
          }),
        ],
        tools: [tool("searchconsole.sites.list")],
        pluginStorage: [operation("searchconsole.sites.list")],
        policies: [policy("google.*.*.gmail.users.messages.send")],
        orphanPolicyMode: "retarget_all",
      }),
    );

    expect(plan.orgs[0]?.policies[0]?.afterPatterns).toEqual([
      "google_search_console.*.*.gmail.users.messages.send",
    ]);
  });

  it("skips openapi lookalike google slugs because plugin ownership is not google", () => {
    const plan = planMigration(
      input({
        integrations: [integration({ plugin_id: "openapi", slug: "google" })],
        tools: [tool("calendar.events.list", { plugin_id: "openapi" })],
        policies: [policy("google.*")],
      }),
    );

    expect(plan.summary.orgs).toBe(0);
    expect(plan.summary.policiesRewrite).toBe(0);
  });

  it("includes non-canonical provider slugs and fans out their policies", () => {
    const migrationInput = input({
      integrations: [
        integration({
          slug: "google_photos_youtube",
          config: googleDiscoveryConfig([youtubeDiscoveryUrl]),
        }),
      ],
      connections: [connection({ integration: "google_photos_youtube" })],
      tools: [tool("youtube.channels.list", { integration: "google_photos_youtube" })],
      pluginStorage: [
        operation("youtube.channels.list", {
          key: operationStorageKey("google_photos_youtube", "youtube.channels.list"),
          data: {
            integration: "google_photos_youtube",
            toolName: "youtube.channels.list",
          },
        }),
      ],
      policies: [policy("google_photos_youtube.*.*.youtube.*")],
    });
    const plan = planMigration(migrationInput);

    expect(plan.summary.orgs).toBe(1);
    expect(plan.orgs[0]?.integrations.map((row) => row.target.slug)).toEqual([
      "google_youtube_data",
    ]);
    expect(plan.orgs[0]?.policies[0]?.afterPatterns).toEqual(["google_youtube_data.*.*.youtube.*"]);
    expect(verifyPolicyRewriteNeverWidens(plan, migrationInput).ok).toBe(true);
  });

  it("merges same-tenant monoliths that derive the same target service", () => {
    const migrationInput = input({
      integrations: [
        integration({
          slug: "google",
          config: googleDiscoveryConfig([youtubeDiscoveryUrl], "google-hash"),
        }),
        integration({
          slug: "google_photos_youtube",
          name: "Google Photos YouTube",
          config: googleDiscoveryConfig([youtubeDiscoveryUrl], "photos-hash"),
          row_id: "int_google_photos_youtube",
        }),
      ],
      connections: [
        connection({ integration: "google", row_id: "conn_google" }),
        connection({
          integration: "google_photos_youtube",
          row_id: "conn_google_photos_youtube",
        }),
      ],
      tools: [
        tool("youtube.channels.list", { integration: "google" }),
        tool("youtube.videos.list", { integration: "google" }),
        tool("youtube.channels.list", {
          integration: "google_photos_youtube",
          row_id: "tool_photos_youtube_channels_list",
        }),
      ],
      pluginStorage: [
        operation("youtube.channels.list", {
          key: operationStorageKey("google", "youtube.channels.list"),
          data: { integration: "google", toolName: "youtube.channels.list" },
        }),
        operation("youtube.videos.list", {
          key: operationStorageKey("google", "youtube.videos.list"),
          data: { integration: "google", toolName: "youtube.videos.list" },
        }),
        operation("youtube.channels.list", {
          key: operationStorageKey("google_photos_youtube", "youtube.channels.list"),
          data: {
            integration: "google_photos_youtube",
            toolName: "youtube.channels.list",
          },
          row_id: "op_photos_youtube_channels_list",
        }),
      ],
      blobs: [
        blob("spec/google-hash"),
        blob("defs/google-hash"),
        blob("spec/photos-hash"),
        blob("defs/photos-hash"),
      ],
      policies: [policy("google.*"), policy("google_photos_youtube.*", { id: "pol_photos" })],
    });
    const plan = planMigration(migrationInput);
    const org = plan.orgs[0];
    const planned = org?.integrations[0];

    expect(org?.integrations).toHaveLength(1);
    expect(planned?.target.slug).toBe("google_youtube_data");
    expect(planned?.servingState.specHash).toBe("google-hash");
    expect(planned?.sourceContributions.map((item) => item.source.slug)).toEqual([
      "google",
      "google_photos_youtube",
    ]);
    expect(planned?.sourceContributions.map((item) => item.operationsToBuild)).toEqual([2, 1]);
    expect(org?.connections.map((row) => [row.source.integration, row.action])).toEqual([
      ["google", "clone"],
      ["google_photos_youtube", "skip_existing"],
    ]);
    expect(org?.policies.map((row) => row.afterPatterns)).toEqual([
      ["google_youtube_data.*"],
      ["google_youtube_data.*"],
    ]);
    expect(org?.blobCopies.map((row) => row.key)).toEqual([
      "spec/google-hash",
      "defs/google-hash",
      "spec/photos-hash",
      "defs/photos-hash",
    ]);
    expect(plan.summary.integrationsCreate).toBe(1);
    expect(plan.summary.operationsToBuild).toBe(3);
  });

  it("deletes config-only monoliths without creating specHash-less service rows", () => {
    const plan = planMigration(
      input({
        integrations: [
          integration({
            slug: "google_mark_life",
            config: {
              googleDiscoveryUrls: [
                "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
                "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest",
              ],
            },
          }),
        ],
        connections: [],
        tools: [],
        pluginStorage: [],
        blobs: [],
      }),
    );

    expect(plan.orgs[0]?.integrations).toEqual([]);
    expect(plan.orgs[0]?.blobCopies).toEqual([]);
    expect(plan.orgs[0]?.deleteMonoliths.map((row) => row.slug)).toEqual(["google_mark_life"]);
    expect(plan.summary.monolithDeletes).toBe(1);
    expect(plan.summary.integrationsCreate).toBe(0);
  });

  it("reads microsoft preset ids from the legacy scope preset config key", () => {
    const plan = planMigration(
      input({
        integrations: [
          integration({
            plugin_id: "microsoft",
            slug: "microsoft_graph_api",
            name: "Microsoft Graph API",
            config: {
              microsoftGraphScopePresetIds: ["mail"],
              specHash: "graph-hash",
            },
          }),
        ],
        connections: [
          connection({
            integration: "microsoft_graph_api",
            template: "microsoftOAuth",
            oauth_client: "microsoft",
          }),
        ],
        tools: [
          tool("meMessagesList", {
            integration: "microsoft_graph_api",
            plugin_id: "microsoft",
          }),
        ],
        pluginStorage: [
          operation("meMessagesList", {
            plugin_id: "microsoft",
            key: operationStorageKey("microsoft_graph_api", "meMessagesList"),
            data: {
              integration: "microsoft_graph_api",
              toolName: "meMessagesList",
            },
          }),
        ],
        blobs: [
          blob("spec/graph-hash", { namespace: "o:org_1/microsoft" }),
          blob("defs/graph-hash", { namespace: "o:org_1/microsoft" }),
        ],
      }),
    );

    expect(plan.orgs[0]?.integrations.map((row) => row.target.slug)).toEqual(["microsoft_mail"]);
  });

  it("plans Microsoft workbook operations into files and excel to match fresh adds", () => {
    const migrationInput = input({
      integrations: [
        integration({
          plugin_id: "microsoft",
          slug: "microsoft_graph_api",
          name: "Microsoft Graph API",
          config: {
            microsoftGraphPresetIds: ["files", "excel"],
            specHash: "graph-hash",
          },
        }),
      ],
      connections: [
        connection({
          integration: "microsoft_graph_api",
          template: "microsoftOAuth",
          oauth_client: "microsoft",
        }),
      ],
      tools: [
        tool("drivesDriveItem.get", {
          integration: "microsoft_graph_api",
          plugin_id: "microsoft",
        }),
        tool("drivesDriveItem.workbook.worksheets.list", {
          integration: "microsoft_graph_api",
          plugin_id: "microsoft",
        }),
      ],
      pluginStorage: [
        operation("drivesDriveItem.get", {
          plugin_id: "microsoft",
          key: operationStorageKey("microsoft_graph_api", "drivesDriveItem.get"),
          data: {
            integration: "microsoft_graph_api",
            toolName: "drivesDriveItem.get",
          },
        }),
        operation("drivesDriveItem.workbook.worksheets.list", {
          plugin_id: "microsoft",
          key: operationStorageKey(
            "microsoft_graph_api",
            "drivesDriveItem.workbook.worksheets.list",
          ),
          data: {
            integration: "microsoft_graph_api",
            toolName: "drivesDriveItem.workbook.worksheets.list",
          },
        }),
      ],
      blobs: [
        blob("spec/graph-hash", { namespace: "o:org_1/microsoft" }),
        blob("defs/graph-hash", { namespace: "o:org_1/microsoft" }),
      ],
    });
    const plan = planMigration(migrationInput);
    const bySlug = new Map(plan.orgs[0]?.integrations.map((row) => [row.target.slug, row]));

    expect(bySlug.get("microsoft_files")?.servingState.operationToolNames).toEqual([
      "drivesDriveItem.get",
      "drivesDriveItem.workbook.worksheets.list",
    ]);
    expect(bySlug.get("microsoft_excel")?.servingState.operationToolNames).toEqual([
      "drivesDriveItem.workbook.worksheets.list",
    ]);
    expect(bySlug.get("microsoft_excel")?.servingState.operationsToBuild).toBe(1);
    expect(plan.summary.hardErrorOrgs).toBe(0);
  });

  it("maps Microsoft me-surface tools to only configured specific presets", () => {
    const toolNames = [
      "meInferenceClassification",
      "meMailboxSettings",
      "meOutlookUser",
      "mePerson",
      "meSite",
      "meDrive",
      "meTeam",
      "meUser",
      "meUserActions",
      "meUserFunctions",
      "meChat",
      "meOnlineMeeting",
    ];
    const migrationInput = input({
      integrations: [
        integration({
          plugin_id: "microsoft",
          slug: "microsoft_graph_api",
          name: "Microsoft Graph API",
          config: {
            microsoftGraphPresetIds: microsoftDefaultPresetIds,
            specHash: "graph-hash",
          },
        }),
      ],
      connections: [
        connection({
          integration: "microsoft_graph_api",
          template: "microsoftOAuth",
          oauth_client: "microsoft",
        }),
      ],
      tools: toolNames.map((name) =>
        tool(name, {
          integration: "microsoft_graph_api",
          plugin_id: "microsoft",
        }),
      ),
      pluginStorage: toolNames.map((name) =>
        operation(name, {
          plugin_id: "microsoft",
          key: operationStorageKey("microsoft_graph_api", name),
          data: {
            integration: "microsoft_graph_api",
            toolName: name,
          },
        }),
      ),
      blobs: [
        blob("spec/graph-hash", { namespace: "o:org_1/microsoft" }),
        blob("defs/graph-hash", { namespace: "o:org_1/microsoft" }),
      ],
    });
    const plan = planMigration(migrationInput);
    const bySlug = new Map(plan.orgs[0]?.integrations.map((row) => [row.target.slug, row]));

    expect(microsoftPresetIdsForTool("meInferenceClassification")).toEqual(["mail"]);
    expect(microsoftPresetIdsForTool("meMailboxSettings")).toEqual(["mail"]);
    expect(microsoftPresetIdsForTool("meOutlookUser")).toEqual(["mail"]);
    expect(microsoftPresetIdsForTool("mePerson")).toEqual(["contacts"]);
    expect(microsoftPresetIdsForTool("meSite")).toEqual(["files"]);
    expect(microsoftPresetIdsForTool("meDrive")).toEqual(["files"]);
    expect(microsoftPresetIdsForTool("meTeam")).toEqual(["teams-channels"]);
    expect(microsoftPresetIdsForTool("meUser")).toEqual(["profile"]);
    expect(microsoftPresetIdsForTool("meUserActions")).toEqual(["profile"]);
    expect(microsoftPresetIdsForTool("meUserFunctions")).toEqual(["profile"]);
    expect(microsoftPresetIdsForTool("meChat")).toEqual(["teams-chat"]);
    expect(microsoftPresetIdsForTool("meOnlineMeeting")).toEqual(["meetings-calls"]);
    expect(bySlug.get("microsoft_mail")?.servingState.operationToolNames).toEqual([
      "meInferenceClassification",
      "meMailboxSettings",
      "meOutlookUser",
    ]);
    expect(bySlug.get("microsoft_contacts")?.servingState.operationToolNames).toEqual(["mePerson"]);
    expect(bySlug.get("microsoft_files")?.servingState.operationToolNames).toEqual([
      "meSite",
      "meDrive",
    ]);
    expect(bySlug.get("microsoft_teams_channels")?.servingState.operationToolNames).toEqual([
      "meTeam",
    ]);
    expect(bySlug.get("microsoft_profile")?.servingState.operationToolNames).toEqual([
      "meUser",
      "meUserActions",
      "meUserFunctions",
    ]);
    expect(bySlug.get("microsoft_teams_chat")?.servingState.operationToolNames).toEqual(["meChat"]);
    expect(bySlug.get("microsoft_meetings_calls")?.servingState.operationToolNames).toEqual([
      "meOnlineMeeting",
    ]);
    expect(plan.summary.hardErrorOrgs).toBe(0);
  });

  it("hard-errors when a Microsoft operation row maps to no target service", () => {
    expect(() =>
      planMigration(
        input({
          integrations: [
            integration({
              plugin_id: "microsoft",
              slug: "microsoft_graph_api",
              name: "Microsoft Graph API",
              config: {
                microsoftGraphPresetIds: ["mail"],
                specHash: "graph-hash",
              },
            }),
          ],
          connections: [
            connection({
              integration: "microsoft_graph_api",
              template: "microsoftOAuth",
              oauth_client: "microsoft",
            }),
          ],
          tools: [
            tool("meMessagesList", {
              integration: "microsoft_graph_api",
              plugin_id: "microsoft",
            }),
          ],
          pluginStorage: [
            operation("unknownGraphThing", {
              plugin_id: "microsoft",
              key: operationStorageKey("microsoft_graph_api", "unknownGraphThing"),
              data: {
                integration: "microsoft_graph_api",
                toolName: "unknownGraphThing",
              },
            }),
          ],
          blobs: [
            blob("spec/graph-hash", { namespace: "o:org_1/microsoft" }),
            blob("defs/graph-hash", { namespace: "o:org_1/microsoft" }),
          ],
        }),
      ),
    ).toThrow(/operation row\(s\) with no target service: unknownGraphThing/);
  });

  it("hard-errors when a Microsoft tool row maps to no target service", () => {
    expect(() =>
      planMigration(
        input({
          integrations: [
            integration({
              plugin_id: "microsoft",
              slug: "microsoft_graph_api",
              name: "Microsoft Graph API",
              config: {
                microsoftGraphPresetIds: ["mail"],
                specHash: "graph-hash",
              },
            }),
          ],
          connections: [
            connection({
              integration: "microsoft_graph_api",
              template: "microsoftOAuth",
              oauth_client: "microsoft",
            }),
          ],
          tools: [
            tool("unknownGraphThing", {
              integration: "microsoft_graph_api",
              plugin_id: "microsoft",
            }),
          ],
          pluginStorage: [],
          blobs: [
            blob("spec/graph-hash", { namespace: "o:org_1/microsoft" }),
            blob("defs/graph-hash", { namespace: "o:org_1/microsoft" }),
          ],
        }),
      ),
    ).toThrow(/tool row\(s\) with no target service: unknownGraphThing/);
  });

  it("hard-errors when Microsoft config lists an unmigratable umbrella preset", () => {
    expect(() =>
      planMigration(
        input({
          integrations: [
            integration({
              plugin_id: "microsoft",
              slug: "microsoft_graph_api",
              name: "Microsoft Graph API",
              config: {
                microsoftGraphPresetIds: ["me-surface"],
                specHash: "graph-hash",
              },
            }),
          ],
          connections: [],
          tools: [],
          pluginStorage: [],
        }),
      ),
    ).toThrow(/unmigratable-umbrella Microsoft Graph preset\(s\): me-surface/);
  });

  it("fans Microsoft workbook policies to files and excel without widening", () => {
    const migrationInput = input({
      integrations: [
        integration({
          plugin_id: "microsoft",
          slug: "microsoft_graph_api",
          name: "Microsoft Graph API",
          config: {
            microsoftGraphPresetIds: ["files", "excel"],
            specHash: "graph-hash",
          },
        }),
      ],
      connections: [
        connection({
          integration: "microsoft_graph_api",
          template: "microsoftOAuth",
          oauth_client: "microsoft",
        }),
      ],
      tools: [
        tool("drivesDriveItem.workbook.worksheets.list", {
          integration: "microsoft_graph_api",
          plugin_id: "microsoft",
        }),
      ],
      pluginStorage: [
        operation("drivesDriveItem.workbook.worksheets.list", {
          plugin_id: "microsoft",
          key: operationStorageKey(
            "microsoft_graph_api",
            "drivesDriveItem.workbook.worksheets.list",
          ),
          data: {
            integration: "microsoft_graph_api",
            toolName: "drivesDriveItem.workbook.worksheets.list",
          },
        }),
      ],
      blobs: [
        blob("spec/graph-hash", { namespace: "o:org_1/microsoft" }),
        blob("defs/graph-hash", { namespace: "o:org_1/microsoft" }),
      ],
      policies: [policy("microsoft_graph_api.*.*.drivesDriveItem.*workbook*")],
    });
    const plan = planMigration(migrationInput);

    expect(plan.orgs[0]?.policies[0]?.afterPatterns).toEqual([
      "microsoft_files.*.*.drivesDriveItem.*workbook*",
      "microsoft_excel.*.*.drivesDriveItem.*workbook*",
    ]);
    expect(verifyPolicyRewriteNeverWidens(plan, migrationInput)).toMatchObject({
      ok: true,
      checkedPolicies: 1,
      widened: [],
      narrowed: [],
    });
  });

  it("is idempotent when target integration and connection already exist", () => {
    const plan = planMigration(
      input({
        integrations: [
          integration(),
          integration({
            slug: "google_calendar",
            plugin_id: "openapi",
            name: "Google Calendar",
            row_id: "int_calendar",
          }),
        ],
        connections: [
          connection(),
          connection({
            integration: "google_calendar",
            row_id: "conn_calendar",
          }),
        ],
      }),
    );

    expect(plan.summary.integrationsCreate).toBe(0);
    expect(plan.summary.integrationsSkipExisting).toBe(1);
    expect(plan.summary.connectionsClone).toBe(0);
    expect(plan.summary.connectionsSkipExisting).toBe(1);
  });

  it("skips completed orgs for resume-after-partial", () => {
    const plan = planMigration(input({ completedTenants: ["org_1"] }));

    expect(plan.orgs[0]?.completed).toBe(true);
    expect(plan.summary.completedOrgs).toBe(1);
    expect(plan.summary.integrationsCreate).toBe(0);
    expect(plan.summary.monolithDeletes).toBe(0);
  });
});
