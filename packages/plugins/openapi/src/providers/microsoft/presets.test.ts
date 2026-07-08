import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { parseEntry, structuralSplit, type KeepPathItem } from "@executor-js/plugin-openapi";

import { microsoftGraphAdapter } from "./spec-format-adapter";
import {
  MICROSOFT_GRAPH_ALL_PRESET_IDS,
  MICROSOFT_GRAPH_BASE_SCOPES,
  MICROSOFT_GRAPH_DEFAULT_PRESET_IDS,
  MICROSOFT_GRAPH_OPENAPI_URL,
  microsoftCatalog,
  microsoftGraphExactPathsForPresetIds,
  microsoftGraphPathPrefixesForPresetIds,
  microsoftGraphPresetIdsCoverFullGraph,
  microsoftGraphScopePresets,
  microsoftGraphScopesForPresetIds,
  microsoftGraphTagPrefixesForPresetIds,
} from "./presets";

const graphHealthCheckFixture = `
openapi: 3.0.4
info:
  title: Microsoft Graph Fixture
  version: v1.0
servers:
  - url: https://graph.microsoft.com/v1.0
paths:
  /me:
    get:
      operationId: me.GetUser
      security:
        - azureAdDelegated:
            - User.Read
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/microsoft.graph.user'
  /me/messages:
    get:
      operationId: me.messages.ListMessages
      security:
        - azureAdDelegated:
            - Mail.ReadWrite
      responses:
        "200":
          description: OK
components:
  schemas:
    microsoft.graph.user:
      type: object
      properties:
        mail:
          type: string
`;

const graphHealthCheckHttpClientLayer = Layer.succeed(HttpClient.HttpClient)(
  HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          request.url === MICROSOFT_GRAPH_OPENAPI_URL ? graphHealthCheckFixture : "not found",
          {
            status: request.url === MICROSOFT_GRAPH_OPENAPI_URL ? 200 : 404,
            headers: { "content-type": "application/yaml" },
          },
        ),
      ),
    ),
  ),
);

const operationIdsFromStructure = (
  specText: string,
  keepPathItem: KeepPathItem,
): readonly string[] => {
  const structure = structuralSplit(specText);
  expect(structure, "fixture structurally splits").not.toBeNull();
  return structure!.pathItems.flatMap((range) => {
    const entry = parseEntry(structure!.text, range, 2);
    expect(entry, "fixture path item parses").not.toBeNull();
    const [path, rawPathItem] = entry!;
    const pathItem = keepPathItem(path, rawPathItem as Record<string, unknown>);
    if (!pathItem) return [];
    return Object.values(pathItem as Record<string, unknown>).flatMap((operation) => {
      const operationId = (operation as { readonly operationId?: unknown }).operationId;
      return typeof operationId === "string" ? [operationId] : [];
    });
  });
};

const FROZEN_MICROSOFT_SLUGS = [
  "microsoft_profile",
  "microsoft_me_surface",
  "microsoft_mail",
  "microsoft_calendar",
  "microsoft_contacts",
  "microsoft_tasks",
  "microsoft_planner",
  "microsoft_files",
  "microsoft_excel",
  "microsoft_sites",
  "microsoft_onenote",
  "microsoft_teams_chat",
  "microsoft_teams_channels",
  "microsoft_meetings_calls",
  "microsoft_users",
  "microsoft_groups",
  "microsoft_directory",
  "microsoft_applications",
  "microsoft_identity",
  "microsoft_admin_reports",
  "microsoft_security_compliance",
  "microsoft_devices",
  "microsoft_education",
  "microsoft_search",
  "microsoft_external_connections",
  "microsoft_solutions",
  "microsoft_platform_services",
] as const;

describe("Microsoft Graph scope presets", () => {
  it("keeps default workload ids backed by categorized presets", () => {
    const ids = new Set(microsoftGraphScopePresets.map((preset) => preset.id));
    expect(MICROSOFT_GRAPH_DEFAULT_PRESET_IDS.every((id) => ids.has(id))).toBe(true);
    expect(MICROSOFT_GRAPH_DEFAULT_PRESET_IDS).toEqual([
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
    ]);
    expect(ids.has("all")).toBe(false);
  });

  it("keeps the full workload ids backed by every categorized preset", () => {
    const ids = new Set(microsoftGraphScopePresets.map((preset) => preset.id));
    expect(MICROSOFT_GRAPH_ALL_PRESET_IDS.every((id) => ids.has(id))).toBe(true);
    expect(MICROSOFT_GRAPH_ALL_PRESET_IDS).toEqual(
      microsoftGraphScopePresets.map((preset) => preset.id),
    );
  });

  it("detects when the categorized catalog covers full Graph", () => {
    expect(microsoftGraphPresetIdsCoverFullGraph(MICROSOFT_GRAPH_ALL_PRESET_IDS)).toBe(true);
    expect(microsoftGraphPresetIdsCoverFullGraph(MICROSOFT_GRAPH_DEFAULT_PRESET_IDS)).toBe(false);
    expect(microsoftGraphPresetIdsCoverFullGraph(["profile", "mail"])).toBe(false);
  });

  it("unions selected preset scopes with base and custom scopes", () => {
    expect(microsoftGraphScopesForPresetIds(["profile", "mail"], ["Sites.Read.All"])).toEqual([
      ...MICROSOFT_GRAPH_BASE_SCOPES,
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
      "MailboxSettings.ReadWrite",
      "Sites.Read.All",
    ]);
  });

  it("includes User.Read for identity when profile is not selected", () => {
    expect(microsoftGraphScopesForPresetIds(["mail"])).toEqual([
      ...MICROSOFT_GRAPH_BASE_SCOPES,
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
      "MailboxSettings.ReadWrite",
    ]);
  });

  it("returns path filters for the selected workloads", () => {
    expect(microsoftGraphExactPathsForPresetIds(["profile"])).toContain("/me");
    expect(microsoftGraphPathPrefixesForPresetIds(["mail"])).toContain("/me/messages");
    expect(microsoftGraphTagPrefixesForPresetIds(["mail"])).toEqual([]);
  });

  it("covers Microsoft Graph root surfaces through category presets", () => {
    const prefixes = new Set(
      microsoftGraphPathPrefixesForPresetIds(MICROSOFT_GRAPH_ALL_PRESET_IDS),
    );
    for (const root of [
      "/agreementAcceptances",
      "/agreements",
      "/admin",
      "/appCatalogs",
      "/applicationTemplates",
      "/applications",
      "/applications(appId='{appId}')",
      "/applications(uniqueName='{uniqueName}')",
      "/authenticationMethodConfigurations",
      "/authenticationMethodsPolicy",
      "/auditLogs",
      "/certificateBasedAuthConfiguration",
      "/chats",
      "/communications",
      "/compliance",
      "/connections",
      "/contacts",
      "/contracts",
      "/copilot",
      "/dataPolicyOperations",
      "/deviceAppManagement",
      "/deviceManagement",
      "/devices",
      "/devices(deviceId='{deviceId}')",
      "/directory",
      "/directoryObjects",
      "/directoryRoleTemplates",
      "/directoryRoles",
      "/directoryRoles(roleTemplateId='{roleTemplateId}')",
      "/domainDnsRecords",
      "/domains",
      "/drives",
      "/education",
      "/employeeExperience",
      "/external",
      "/filterOperators",
      "/functions",
      "/groupLifecyclePolicies",
      "/groupSettingTemplates",
      "/groupSettings",
      "/groups",
      "/groups(uniqueName='{uniqueName}')",
      "/identity",
      "/identityGovernance",
      "/identityProviders",
      "/identityProtection",
      "/informationProtection",
      "/invitations",
      "/me",
      "/oauth2PermissionGrants",
      "/organization",
      "/permissionGrants",
      "/places",
      "/planner",
      "/policies",
      "/print",
      "/privacy",
      "/reports",
      "/roleManagement",
      "/schemaExtensions",
      "/scopedRoleMemberships",
      "/search",
      "/security",
      "/servicePrincipals",
      "/servicePrincipals(appId='{appId}')",
      "/shares",
      "/sites",
      "/solutions",
      "/storage",
      "/subscribedSkus",
      "/subscriptions",
      "/teamwork",
      "/teams",
      "/teamsTemplates",
      "/tenantRelationships",
      "/users",
      "/users(userPrincipalName='{userPrincipalName}')",
    ]) {
      expect(prefixes.has(root)).toBe(true);
    }
  });

  it("declares product icons for each workload", () => {
    for (const preset of microsoftGraphScopePresets) {
      expect(preset.icon).toMatch(/^https:\/\/svgl\.app\/library\/.+\.svg$/);
    }
  });

  it("exports one catalog row per workload with stable slugs and Graph auth templates", () => {
    expect(microsoftCatalog.map((preset) => preset.defaultSlug)).toEqual([
      ...FROZEN_MICROSOFT_SLUGS,
    ]);
    for (const preset of microsoftCatalog) {
      expect(preset.family).toBe("microsoft");
      expect(preset.specFormat).toBe("microsoft-graph");
      expect(preset.defaultSlug).toBeTruthy();
      expect(preset.authTemplate).toHaveLength(2);
      expect(preset.authTemplate?.map((template) => template.kind)).toEqual(["oauth2", "oauth2"]);
    }
  });

  it.effect("resolves fixture-backed Microsoft catalog health checks in workload splits", () =>
    Effect.gen(function* () {
      const fixtureCases = [
        { presetId: "profile", expectedOperation: "me.GetUser" },
        { presetId: "mail", expectedOperation: undefined },
      ] as const;

      for (const { presetId, expectedOperation } of fixtureCases) {
        const preset = microsoftCatalog.find(
          (candidate) => candidate.id === `microsoft-${presetId}`,
        );
        expect(preset, `${presetId} catalog row exists`).toBeTruthy();
        expect(preset?.healthCheck?.operation, `${presetId} catalog health check`).toBe(
          expectedOperation,
        );

        const converted = yield* microsoftGraphAdapter.fetch({
          urls: [`${MICROSOFT_GRAPH_OPENAPI_URL}#preset=${presetId}`],
          httpClientLayer: graphHealthCheckHttpClientLayer,
        });
        expect(converted.keepPathItem, `${presetId} keeps a workload split`).toBeTruthy();
        const operationIds = operationIdsFromStructure(converted.specText, converted.keepPathItem!);
        expect(
          expectedOperation === undefined || operationIds.includes(expectedOperation),
          `${presetId} fixture resolves declared health check`,
        ).toBe(true);
      }
    }),
  );

  it("keeps Microsoft catalog health checks as liveness probes without identity fields", () => {
    for (const preset of microsoftCatalog) {
      expect(
        preset.healthCheck?.identityField,
        `${preset.id} should not declare health identity extraction`,
      ).toBeUndefined();
    }
  });
});
