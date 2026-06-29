import { describe, expect, it } from "@effect/vitest";

import {
  MICROSOFT_GRAPH_ALL_PRESET_IDS,
  MICROSOFT_GRAPH_BASE_SCOPES,
  MICROSOFT_GRAPH_DEFAULT_PRESET_IDS,
  microsoftGraphExactPathsForPresetIds,
  microsoftGraphPathPrefixesForPresetIds,
  microsoftGraphPresetIdsCoverFullGraph,
  microsoftGraphScopePresets,
  microsoftGraphScopesForPresetIds,
  microsoftGraphTagPrefixesForPresetIds,
} from "./presets";

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
});
