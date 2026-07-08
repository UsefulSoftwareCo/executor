/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor, executor/no-instanceof-error, executor/no-unknown-error-message, executor/no-json-parse -- boundary: one-shot provider service split planner preserves the throwing dry-run contract used by migration tooling */
import { createHash } from "node:crypto";

import {
  googleCatalog,
  googlePresetForDiscoveryUrl,
} from "@executor-js/plugin-openapi/providers/google";
import {
  MICROSOFT_GRAPH_DEFAULT_PRESET_IDS,
  microsoftCatalog,
} from "@executor-js/plugin-openapi/providers/microsoft";
import type { OpenApiPreset } from "@executor-js/plugin-openapi/presets";

type MonolithPluginId = "google" | "microsoft";

const normalizeUrl = (url: string): string => {
  const trimmed = url.trim();
  if (!URL.canParse(trimmed)) return trimmed.replace(/\/$/, "");
  const parsed = new URL(trimmed);
  parsed.hash = "";
  parsed.searchParams.sort();
  return parsed.toString().replace(/\/$/, "");
};

const googleCatalogByDiscoveryUrl = new Map(
  googleCatalog.flatMap((preset) =>
    preset.url ? [[normalizeUrl(preset.url), preset] as const] : [],
  ),
);

const matchPattern = (pattern: string, toolId: string): boolean => {
  if (pattern === "*") return true;
  const patternSegments = pattern.split(".");
  const toolSegments = toolId.split(".");
  for (let index = 0; index < patternSegments.length; index += 1) {
    const segment = patternSegments[index]!;
    if (segment === "*") {
      if (index === patternSegments.length - 1) return toolSegments.length >= index;
      if (index >= toolSegments.length) return false;
      continue;
    }
    if (index >= toolSegments.length || toolSegments[index] !== segment) return false;
  }
  return patternSegments.length === toolSegments.length;
};

export type PluginId = "openapi";

export interface IntegrationRow {
  readonly tenant: string;
  readonly slug: string;
  readonly plugin_id: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly config: unknown;
  readonly health_check?: unknown;
  readonly config_revised_at?: string | number | bigint | null;
  readonly can_remove: boolean;
  readonly can_refresh: boolean;
  readonly created_at: string;
  readonly updated_at: string;
  readonly row_id: string;
}

export interface ConnectionRow {
  readonly tenant: string;
  readonly owner: string;
  readonly subject: string;
  readonly integration: string;
  readonly name: string;
  readonly template: string;
  readonly provider: string;
  readonly item_ids: unknown;
  readonly identity_label: string | null;
  readonly description?: string | null;
  readonly last_health?: unknown;
  readonly tools_synced_at?: string | number | bigint | null;
  readonly oauth_client: string | null;
  readonly oauth_client_owner: string | null;
  readonly refresh_item_id: string | null;
  readonly expires_at: string | number | bigint | null;
  readonly oauth_scope: string | null;
  readonly oauth_token_url?: string | null;
  readonly provider_state: unknown;
  readonly created_at: string;
  readonly updated_at: string;
  readonly row_id: string;
}

export interface ToolRow {
  readonly tenant: string;
  readonly owner: string;
  readonly subject: string;
  readonly integration: string;
  readonly connection: string;
  readonly plugin_id: string;
  readonly name: string;
  readonly description?: string;
  readonly input_schema?: unknown;
  readonly output_schema?: unknown;
  readonly annotations?: unknown;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly row_id: string;
}

export interface PluginStorageRow {
  readonly tenant: string;
  readonly owner: string;
  readonly subject: string;
  readonly plugin_id: string;
  readonly collection: string;
  readonly key: string;
  readonly data: unknown;
  readonly created_at: string;
  readonly updated_at: string;
  readonly row_id: string;
}

export interface BlobRow {
  readonly id: string;
  readonly namespace: string;
  readonly key: string;
}

export interface ToolPolicyRow {
  readonly tenant: string;
  readonly owner: string;
  readonly subject: string;
  readonly id: string;
  readonly pattern: string;
  readonly action: string;
  readonly position: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly row_id: string;
}

export interface MigrationInput {
  readonly integrations: readonly IntegrationRow[];
  readonly connections: readonly ConnectionRow[];
  readonly tools: readonly ToolRow[];
  readonly pluginStorage?: readonly PluginStorageRow[];
  readonly blobs?: readonly BlobRow[];
  readonly policies: readonly ToolPolicyRow[];
  readonly completedTenants?: readonly string[];
  readonly trafficLastTenant?: string;
  readonly collectPolicyErrors?: boolean;
  readonly orphanPolicyMode?: "hard_error" | "retarget_all";
  readonly blobBackend?: "database" | "external";
  readonly assumeExternalBlobSourcePresent?: boolean;
  readonly bootRailCreateToolImpliedServices?: boolean;
}

export interface ServiceTarget {
  readonly family: MonolithPluginId;
  readonly pluginId: PluginId;
  readonly presetId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly specUrl?: string;
  readonly specFormat: "google-discovery" | "microsoft-graph";
  readonly authenticationTemplate?: readonly unknown[];
  readonly healthCheck?: unknown;
}

export interface PlannedIntegration {
  readonly source: Pick<IntegrationRow, "tenant" | "slug" | "plugin_id" | "name">;
  readonly sourceContributions: readonly {
    readonly source: IntegrationRow;
    readonly specHash?: string;
    readonly operationsToBuild: number;
    readonly operationToolNames: readonly string[];
    readonly specBlobPresent: boolean;
    readonly defsBlobPresent: boolean;
  }[];
  readonly target: ServiceTarget;
  readonly action: "create" | "skip_existing";
  readonly config: unknown;
  readonly healthCheck?: unknown;
  readonly servingState: {
    readonly specHash?: string;
    readonly specSource: string;
    readonly blobBackend: "database" | "external";
    readonly specBlobPresent: boolean;
    readonly defsBlobPresent: boolean;
    readonly operationsToBuild: number;
    readonly operationToolNames: readonly string[];
    readonly expectedZeroOperations: boolean;
  };
}

export interface PlannedBlobCopy {
  readonly source: Pick<IntegrationRow, "tenant" | "slug" | "plugin_id">;
  readonly specHash: string;
  readonly key: string;
  readonly sourceNamespace: string;
  readonly targetNamespace: string;
  readonly backend: "database" | "external";
  readonly sourcePresent: boolean;
  readonly targetPresent: boolean;
  readonly sourceObjectName: string;
  readonly targetObjectName: string;
}

export interface PlannedConnection {
  readonly source: Pick<ConnectionRow, "tenant" | "owner" | "subject" | "integration" | "name">;
  readonly targetIntegration: string;
  readonly action: "clone" | "skip_existing";
  readonly tokenReuse: "copy_item_ids_and_oauth_columns";
}

export interface PlannedPolicyRewrite {
  readonly policy: Pick<
    ToolPolicyRow,
    "tenant" | "owner" | "subject" | "id" | "pattern" | "action" | "position"
  >;
  readonly action: "rewrite";
  readonly afterPatterns: readonly string[];
  readonly matchedServices: readonly string[];
}

export interface OrgPlan {
  readonly tenant: string;
  readonly tenantHash: string;
  readonly completed: boolean;
  readonly integrations: readonly PlannedIntegration[];
  readonly connections: readonly PlannedConnection[];
  readonly policies: readonly PlannedPolicyRewrite[];
  readonly blobCopies: readonly PlannedBlobCopy[];
  readonly deleteMonoliths: readonly Pick<
    IntegrationRow,
    "tenant" | "slug" | "plugin_id" | "name"
  >[];
  readonly clonedToolRows: number;
  readonly operationsToBuild: number;
  readonly hardErrors: readonly string[];
}

export interface MigrationPlan {
  readonly orgs: readonly OrgPlan[];
  readonly summary: {
    readonly orgs: number;
    readonly completedOrgs: number;
    readonly integrationsCreate: number;
    readonly integrationsSkipExisting: number;
    readonly connectionsClone: number;
    readonly connectionsSkipExisting: number;
    readonly policiesRewrite: number;
    readonly policiesSkip: number;
    readonly policyRowsAfter: number;
    readonly monolithDeletes: number;
    readonly clonedToolRows: number;
    readonly operationsToBuild: number;
    readonly integrationsMissingSpecBlob: number;
    readonly integrationsMissingDefsBlob: number;
    readonly hardErrorOrgs: number;
    readonly policyHardErrors: number;
  };
}

const GOOGLE_IDENTITY_DISCOVERY_URL = "https://www.googleapis.com/discovery/v1/apis/oauth2/v2/rest";

const GOOGLE_TOOL_PREFIX_TO_PRESET_ID: ReadonlyMap<string, string> = new Map([
  ["calendar", "google-calendar"],
  ["gmail", "google-gmail"],
  ["sheets", "google-sheets"],
  ["drive", "google-drive"],
  ["docs", "google-docs"],
  ["slides", "google-slides"],
  ["forms", "google-forms"],
  ["tasks", "google-tasks"],
  ["people", "google-people"],
  ["photoslibrary", "google-photos-library"],
  ["photospicker", "google-photos-picker"],
  ["chat", "google-chat"],
  ["keep", "google-keep"],
  ["youtube", "google-youtube-data"],
  ["searchconsole", "google-search-console"],
  ["webmasters", "google-search-console"],
  ["classroom", "google-classroom"],
  ["directory", "google-admin-directory"],
  ["reports", "google-admin-reports"],
  ["script", "google-apps-script"],
  ["bigquery", "google-bigquery"],
  ["cloudresourcemanager", "google-cloud-resource-manager"],
]);

const unique = <T>(values: Iterable<T>): readonly T[] => [...new Set(values)];

export const tenantHash = (tenant: string): string =>
  createHash("sha256").update(tenant).digest("hex").slice(0, 12);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recordFromJsonLike = (value: unknown): Record<string, unknown> => {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const stringArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const configRecord = (integration: IntegrationRow): Record<string, unknown> =>
  recordFromJsonLike(integration.config);

const toolAddress = (
  tool: Pick<ToolRow, "integration" | "owner" | "connection" | "name">,
): string => `${tool.integration}.${tool.owner}.${tool.connection}.${tool.name}`;

const withoutToolsPrefix = (pattern: string): string =>
  pattern.startsWith("tools.") ? pattern.slice("tools.".length) : pattern;

const withOriginalToolsPrefix = (original: string, rewrittenTail: string): string =>
  original.startsWith("tools.") ? `tools.${rewrittenTail}` : rewrittenTail;

const integrationPatternSegment = (
  pattern: string,
): { readonly prefix: boolean; readonly integration: string } => {
  const prefix = pattern.startsWith("tools.");
  const tail = prefix ? pattern.slice("tools.".length) : pattern;
  return { prefix, integration: tail.split(".")[0] ?? "" };
};

const googleCatalogById: ReadonlyMap<string, OpenApiPreset> = new Map(
  googleCatalog.map((preset) => [preset.id, preset]),
);

const microsoftCatalogByMonolithPresetId: ReadonlyMap<string, OpenApiPreset> = new Map(
  microsoftCatalog.map((preset) => [preset.id.replace(/^microsoft-/, ""), preset]),
);

const MICROSOFT_UNMIGRATABLE_UMBRELLA_PRESET_IDS = new Set(["me-surface", "users", "groups"]);
const MICROSOFT_TOOL_IMPLIED_PRESET_IDS = new Set(MICROSOFT_GRAPH_DEFAULT_PRESET_IDS);
const microsoftCatalogBackedPresetIds = new Set(
  microsoftCatalog
    .filter((preset) => preset.defaultSlug && preset.defaultSlug.length > 0)
    .map((preset) => preset.id.replace(/^microsoft-/, "")),
);

export const microsoftToolFirstSegmentPresetIds: ReadonlyMap<string, readonly string[]> = new Map([
  ["chats", ["teams-chat"]],
  ["chatsChat", ["teams-chat"]],
  ["communications", ["meetings-calls"]],
  ["communicationsCall", ["meetings-calls"]],
  ["communicationsOnlineMeeting", ["meetings-calls"]],
  ["communicationsPresence", ["meetings-calls"]],
  ["drives", ["files"]],
  ["drivesDrive", ["files"]],
  ["drivesDriveItem", ["files"]],
  ["groupsDrive", ["files"]],
  ["groupsDrives", ["files"]],
  ["groupsOnenote", ["onenote"]],
  ["groupsTeam", ["teams-channels"]],
  ["meCalendar", ["calendar"]],
  ["meCalendarGroups", ["calendar"]],
  ["meCalendars", ["calendar"]],
  ["meCalendarView", ["calendar"]],
  ["meChat", ["teams-chat"]],
  ["meChats", ["teams-chat"]],
  ["meContact", ["contacts"]],
  ["meContactFolder", ["contacts"]],
  ["meContactFolders", ["contacts"]],
  ["meContacts", ["contacts"]],
  ["meDrive", ["files"]],
  ["meDrives", ["files"]],
  ["meEvent", ["calendar"]],
  ["meEvents", ["calendar"]],
  ["meFindMeetingTimes", ["calendar"]],
  ["meFollowedSites", ["files"]],
  ["meGetMailTips", ["mail"]],
  ["meInferenceClassification", ["mail"]],
  ["meJoinedTeams", ["teams-channels"]],
  ["meMailFolder", ["mail"]],
  ["meMailFolders", ["mail"]],
  ["meMailboxSettings", ["mail"]],
  ["meMessage", ["mail"]],
  ["meMessages", ["mail"]],
  ["meOnlineMeeting", ["meetings-calls"]],
  ["meOnlineMeetings", ["meetings-calls"]],
  ["meOnenote", ["onenote"]],
  ["meOutlook", ["mail"]],
  ["meOutlookUser", ["mail"]],
  ["mePeople", ["contacts"]],
  ["mePerson", ["contacts"]],
  ["mePhoto", ["profile"]],
  ["meProfilePhoto", ["profile"]],
  ["meReminderView", ["calendar"]],
  ["meSendMail", ["mail"]],
  ["meSite", ["files"]],
  ["meTeam", ["teams-channels"]],
  ["meTodo", ["tasks"]],
  ["meUser", ["profile"]],
  ["meUserActions", ["profile"]],
  ["meUserFunctions", ["profile"]],
  ["shares", ["files"]],
  ["sites", ["sites"]],
  ["sitesOnenote", ["onenote"]],
  ["sitesSite", ["sites"]],
  ["teams", ["teams-channels"]],
  ["teamsChannel", ["teams-channels"]],
  ["teamsTeam", ["teams-channels"]],
  ["teamsTemplates", ["teams-channels"]],
  ["teamwork", ["teams-channels"]],
  ["usersCalendar", ["calendar"]],
  ["usersCalendarGroups", ["calendar"]],
  ["usersCalendars", ["calendar"]],
  ["usersCalendarView", ["calendar"]],
  ["usersContact", ["contacts"]],
  ["usersContactFolder", ["contacts"]],
  ["usersContactFolders", ["contacts"]],
  ["usersContacts", ["contacts"]],
  ["usersDrive", ["files"]],
  ["usersDrives", ["files"]],
  ["usersEvent", ["calendar"]],
  ["usersEvents", ["calendar"]],
  ["usersFindMeetingTimes", ["calendar"]],
  ["usersMailFolder", ["mail"]],
  ["usersMailFolders", ["mail"]],
  ["usersMessage", ["mail"]],
  ["usersMessages", ["mail"]],
  ["usersOnlineMeeting", ["meetings-calls"]],
  ["usersOnlineMeetings", ["meetings-calls"]],
  ["usersOnenote", ["onenote"]],
  ["usersOutlook", ["mail"]],
  ["usersPeople", ["contacts"]],
  ["usersPerson", ["contacts"]],
  ["usersReminderView", ["calendar"]],
  ["usersSendMail", ["mail"]],
  ["usersTodo", ["tasks"]],
  ["usersUser", ["profile"]],
  ["usersUserActions", ["profile"]],
  ["usersUserFunctions", ["profile"]],
]);

const MICROSOFT_WORKBOOK_FIRST_SEGMENTS = new Set([
  "drivesDriveItem",
  "groupsDrive",
  "meDrive",
  "usersDrive",
]);

const microsoftFirstSegmentOwnershipKey = (firstSegment: string): string | undefined =>
  [...microsoftToolFirstSegmentPresetIds.keys()]
    .filter(
      (key) =>
        firstSegment === key ||
        (firstSegment.startsWith(key) &&
          firstSegment[key.length]?.toUpperCase() === firstSegment[key.length]),
    )
    .sort((left, right) => right.length - left.length)[0];

const serviceSlugForPreset = (family: MonolithPluginId, presetId: string): string | undefined => {
  const preset =
    family === "google"
      ? googleCatalogById.get(presetId)
      : microsoftCatalogByMonolithPresetId.get(presetId);
  return preset?.defaultSlug;
};

const serviceTargetForPreset = (
  family: MonolithPluginId,
  presetId: string,
): ServiceTarget | undefined => {
  if (family === "google") {
    const preset = googleCatalogById.get(presetId);
    if (!preset) return undefined;
    return {
      family,
      pluginId: "openapi",
      presetId,
      slug: preset.defaultSlug ?? preset.id,
      name: preset.name,
      description: preset.summary,
      ...(preset.url ? { specUrl: preset.url } : {}),
      specFormat: "google-discovery",
      ...(preset.authTemplate ? { authenticationTemplate: preset.authTemplate } : {}),
      ...(preset.healthCheck ? { healthCheck: preset.healthCheck } : {}),
    };
  }
  const preset = microsoftCatalogByMonolithPresetId.get(presetId);
  if (!preset) return undefined;
  return {
    family,
    pluginId: "openapi",
    presetId,
    slug: preset.defaultSlug ?? preset.id,
    name: preset.name,
    description: preset.summary,
    ...(preset.url ? { specUrl: preset.url } : {}),
    specFormat: "microsoft-graph",
    ...(preset.authTemplate ? { authenticationTemplate: preset.authTemplate } : {}),
    ...(preset.healthCheck ? { healthCheck: preset.healthCheck } : {}),
  };
};

const googlePresetIdsFromConfig = (integration: IntegrationRow): readonly string[] => {
  const urls = stringArray(configRecord(integration).googleDiscoveryUrls);
  return unique(
    urls.flatMap((url) => {
      if (url === GOOGLE_IDENTITY_DISCOVERY_URL || url.includes("/oauth2/")) return [];
      const preset =
        googleCatalogByDiscoveryUrl.get(normalizeUrl(url)) ?? googlePresetForDiscoveryUrl(url);
      return preset ? [preset.id] : [];
    }),
  );
};

const microsoftPresetIdsFromConfig = (integration: IntegrationRow): readonly string[] => {
  const config = configRecord(integration);
  const configured = [
    ...stringArray(config.microsoftGraphPresetIds),
    ...stringArray(config.microsoftGraphScopePresetIds),
  ];
  if (configured.length > 0) return unique(configured);
  throw new Error(
    `Microsoft monolith ${tenantHash(integration.tenant)}/${integration.slug} has no stored microsoftGraphPresetIds; refusing to fabricate ${MICROSOFT_GRAPH_DEFAULT_PRESET_IDS.length} default workloads`,
  );
};

const microsoftUnmigratablePresetIds = (presetIds: readonly string[]): readonly string[] =>
  presetIds.filter(
    (presetId) =>
      MICROSOFT_UNMIGRATABLE_UMBRELLA_PRESET_IDS.has(presetId) ||
      !microsoftCatalogBackedPresetIds.has(presetId),
  );

export const googlePresetIdForTool = (toolName: string): string | undefined => {
  const [first, second] = toolName.split(".");
  if (first === "admin") {
    return second === "channels" ? "google-admin-reports" : "google-admin-directory";
  }
  return GOOGLE_TOOL_PREFIX_TO_PRESET_ID.get(first ?? "");
};

export const microsoftPresetIdsForTool = (toolName: string): readonly string[] => {
  const segments = toolName.split(".");
  const first = segments[0] ?? "";
  const ownershipKey = microsoftFirstSegmentOwnershipKey(first);
  const fromFirstSegment = ownershipKey
    ? (microsoftToolFirstSegmentPresetIds.get(ownershipKey) ?? [])
    : [];
  const workbookOwned =
    ownershipKey !== undefined &&
    MICROSOFT_WORKBOOK_FIRST_SEGMENTS.has(ownershipKey) &&
    segments.some((segment) => segment.toLowerCase().includes("workbook"));
  return unique([...fromFirstSegment, ...(workbookOwned ? ["excel"] : [])]).filter((presetId) =>
    MICROSOFT_TOOL_IMPLIED_PRESET_IDS.has(presetId),
  );
};

const presetIdsForTool = (pluginId: MonolithPluginId, toolName: string): readonly string[] => {
  const presetId = pluginId === "google" ? googlePresetIdForTool(toolName) : undefined;
  return pluginId === "google" ? (presetId ? [presetId] : []) : microsoftPresetIdsForTool(toolName);
};

const deriveServices = (
  integration: IntegrationRow,
  tools: readonly ToolRow[],
  bootRailCreateToolImpliedServices: boolean,
): readonly ServiceTarget[] => {
  const pluginId = integration.plugin_id as MonolithPluginId;
  const fromConfig =
    pluginId === "google"
      ? googlePresetIdsFromConfig(integration)
      : microsoftPresetIdsFromConfig(integration);
  if (pluginId === "microsoft") {
    const unmigratablePresetIds = microsoftUnmigratablePresetIds(fromConfig);
    if (unmigratablePresetIds.length > 0) {
      throw new Error(
        `Monolith ${tenantHash(integration.tenant)}/${integration.plugin_id}/${integration.slug} references unmigratable-umbrella Microsoft Graph preset(s): ${unmigratablePresetIds.join(", ")}; org needs manual handling`,
      );
    }
  }
  const fromTools = unique(
    tools.flatMap((tool) => {
      const presetIds = presetIdsForTool(pluginId, tool.name);
      if (
        pluginId === "microsoft" &&
        fromConfig.length > 0 &&
        presetIds.some((presetId) => fromConfig.includes(presetId))
      ) {
        return [];
      }
      return presetIds;
    }),
  );
  const missingToolPresetIds = fromTools.filter((presetId) => !fromConfig.includes(presetId));
  if (
    fromConfig.length > 0 &&
    missingToolPresetIds.length > 0 &&
    !bootRailCreateToolImpliedServices
  ) {
    throw new Error(
      `Monolith ${tenantHash(integration.tenant)}/${integration.plugin_id}/${integration.slug} config omits tool-implied service preset(s): ${missingToolPresetIds.join(", ")}`,
    );
  }
  const presetIds =
    bootRailCreateToolImpliedServices && fromConfig.length > 0
      ? unique([...fromConfig, ...fromTools])
      : fromConfig.length > 0
        ? fromConfig
        : fromTools;
  const services = presetIds.flatMap(
    (presetId) => serviceTargetForPreset(pluginId, presetId) ?? [],
  );
  const missingCatalogPresetIds = presetIds.filter(
    (presetId) => !serviceTargetForPreset(pluginId, presetId),
  );
  if (missingCatalogPresetIds.length > 0) {
    throw new Error(
      `Monolith ${tenantHash(integration.tenant)}/${integration.plugin_id}/${integration.slug} references unknown service preset(s): ${missingCatalogPresetIds.join(", ")}`,
    );
  }
  if (services.length === 0) {
    throw new Error(
      `Monolith ${tenantHash(integration.tenant)}/${integration.plugin_id}/${integration.slug} has no derivable services`,
    );
  }
  return services;
};

const configForService = (source: IntegrationRow, target: ServiceTarget): unknown => {
  const config = configRecord(source);
  const specHash =
    typeof config.specHash === "string" && config.specHash.length > 0 ? config.specHash : undefined;
  return {
    ...(specHash ? { specHash } : {}),
    ...(target.specUrl ? { specUrl: target.specUrl } : {}),
    specFormat: target.specFormat,
    family: target.family,
    ...(target.authenticationTemplate
      ? { authenticationTemplate: target.authenticationTemplate }
      : {}),
  };
};

const rowKey = (...parts: readonly string[]): string => parts.join("\u0000");

const stableKeyHash = (value: string): string => {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(36).padStart(13, "0");
};

export const operationStorageKey = (integration: string, toolName: string): string =>
  `op.${stableKeyHash(integration)}.${stableKeyHash(toolName)}`;

export const storageDataRecord = (row: Pick<PluginStorageRow, "data">): Record<string, unknown> =>
  recordFromJsonLike(row.data);

const operationToolName = (row: PluginStorageRow): string | undefined => {
  const value = storageDataRecord(row).toolName;
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const operationIntegration = (row: PluginStorageRow): string | undefined => {
  const value = storageDataRecord(row).integration;
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const specHashFor = (integration: IntegrationRow): string => {
  const value = configRecord(integration).specHash;
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(
    `Monolith ${tenantHash(integration.tenant)}/${integration.plugin_id}/${integration.slug} has no specHash; serving state cannot be migrated`,
  );
};

const pluginBlobNamespace = (tenant: string, pluginId: string): string => `o:${tenant}/${pluginId}`;

const blobObjectName = (namespace: string, key: string): string => `${namespace}/${key}`;

const operationRowsForService = (
  monolith: IntegrationRow,
  target: ServiceTarget,
  rows: readonly PluginStorageRow[],
): readonly PluginStorageRow[] =>
  rows.filter((row) => {
    if (row.tenant !== monolith.tenant) return false;
    if (row.plugin_id !== monolith.plugin_id) return false;
    if (row.collection !== "operation") return false;
    if (operationIntegration(row) !== monolith.slug) return false;
    const toolName = operationToolName(row);
    if (!toolName) return false;
    if (isIntentionallyDroppedTool(monolith.plugin_id as MonolithPluginId, toolName)) return false;
    return serviceForMatchedTool(monolith.plugin_id as MonolithPluginId, toolName, [
      target,
    ]).includes(target.slug);
  });

const operationRowsForMonolith = (
  monolith: IntegrationRow,
  rows: readonly PluginStorageRow[],
): readonly PluginStorageRow[] =>
  rows.filter((row) => {
    if (row.tenant !== monolith.tenant) return false;
    if (row.plugin_id !== monolith.plugin_id) return false;
    if (row.collection !== "operation") return false;
    return operationIntegration(row) === monolith.slug;
  });

const isConfigOnlyMonolith = (input: {
  readonly tools: readonly ToolRow[];
  readonly connections: readonly ConnectionRow[];
  readonly operations: readonly PluginStorageRow[];
}): boolean =>
  input.tools.length === 0 && input.connections.length === 0 && input.operations.length === 0;

const isIntentionallyDroppedTool = (pluginId: MonolithPluginId, toolName: string): boolean =>
  pluginId === "google" && toolName.startsWith("oauth2.");

const serviceForMatchedTool = (
  pluginId: MonolithPluginId,
  toolName: string,
  services: readonly ServiceTarget[],
): readonly string[] => {
  const presetIds = presetIdsForTool(pluginId, toolName);
  return presetIds.flatMap((presetId) => {
    const slug = serviceSlugForPreset(pluginId, presetId);
    return slug && services.some((service) => service.slug === slug) ? [slug] : [];
  });
};

const allServiceSlugs = (services: readonly ServiceTarget[]): readonly string[] =>
  services.map((service) => service.slug);

const unassignedToolNames = (
  pluginId: MonolithPluginId,
  tools: readonly { readonly name: string }[],
  services: readonly ServiceTarget[],
): readonly string[] =>
  unique(
    tools.flatMap((tool) => {
      if (isIntentionallyDroppedTool(pluginId, tool.name)) return [];
      return serviceForMatchedTool(pluginId, tool.name, services).length === 0 ? [tool.name] : [];
    }),
  );

const assertNoUnassignedRows = (
  monolith: IntegrationRow,
  tools: readonly ToolRow[],
  operations: readonly PluginStorageRow[],
  services: readonly ServiceTarget[],
): void => {
  const pluginId = monolith.plugin_id as MonolithPluginId;
  const unassignedTools = unassignedToolNames(pluginId, tools, services);
  if (unassignedTools.length > 0) {
    throw new Error(
      `Monolith ${tenantHash(monolith.tenant)}/${monolith.plugin_id}/${monolith.slug} has tool row(s) with no target service: ${unassignedTools.slice(0, 20).join(", ")}`,
    );
  }
  const operationTools = operations.flatMap((row) => {
    const toolName = operationToolName(row);
    return toolName ? [{ name: toolName }] : [];
  });
  const unassignedOperations = unassignedToolNames(pluginId, operationTools, services);
  if (unassignedOperations.length > 0) {
    throw new Error(
      `Monolith ${tenantHash(monolith.tenant)}/${monolith.plugin_id}/${monolith.slug} has operation row(s) with no target service: ${unassignedOperations.slice(0, 20).join(", ")}`,
    );
  }
};

const serviceSlugsForToolPattern = (
  pluginId: MonolithPluginId,
  toolSegments: readonly string[],
  services: readonly ServiceTarget[],
): readonly string[] => {
  const firstToolSegment = toolSegments[0];
  if (!firstToolSegment || firstToolSegment === "*") return allServiceSlugs(services);
  const presetIds = presetIdsForTool(pluginId, toolSegments.join("."));
  return presetIds.flatMap((presetId) => {
    const slug = serviceSlugForPreset(pluginId, presetId);
    return slug && services.some((service) => service.slug === slug) ? [slug] : [];
  });
};

const serviceSlugsForPolicyPattern = (
  policy: ToolPolicyRow,
  monolith: IntegrationRow,
  services: readonly ServiceTarget[],
): readonly string[] => {
  const tail = withoutToolsPrefix(policy.pattern);
  const segments = tail.split(".");
  const rest = segments.slice(1);
  const pluginId = monolith.plugin_id as MonolithPluginId;
  if (rest.length === 0) return allServiceSlugs(services);

  if (rest[0] === "org" || rest[0] === "user") {
    return serviceSlugsForToolPattern(pluginId, rest.slice(2), services);
  }

  if (rest[0] === "*") {
    if (rest.length <= 2) return allServiceSlugs(services);
    return serviceSlugsForToolPattern(pluginId, rest.slice(2), services);
  }

  return serviceSlugsForToolPattern(pluginId, rest, services);
};

const rewritePatternIntegration = (pattern: string, targetSlug: string): string => {
  const hasTools = pattern.startsWith("tools.");
  const tail = hasTools ? pattern.slice("tools.".length) : pattern;
  const segments = tail.split(".");
  segments[0] = targetSlug;
  return withOriginalToolsPrefix(pattern, segments.join("."));
};

const policyMatches = (pattern: string, tool: ToolRow): boolean => {
  const normalized = withoutToolsPrefix(pattern);
  return matchPattern(normalized, toolAddress(tool));
};

const rewritePolicy = (
  policy: ToolPolicyRow,
  monolith: IntegrationRow,
  services: readonly ServiceTarget[],
  orphanPolicyMode: MigrationInput["orphanPolicyMode"],
): PlannedPolicyRewrite => {
  const patternIntegration = integrationPatternSegment(policy.pattern).integration;
  if (patternIntegration !== monolith.slug) {
    throw new Error(
      `Policy ${policy.id} for org ${tenantHash(policy.tenant)} does not target ${monolith.slug}`,
    );
  }

  // Orphan policies (pattern targets a service the org never derived) retarget
  // to every derived service as dormant rows: block/require_approval so the
  // guardrail intent survives a later add of that service, and approve because
  // dropping it is the only alternative and a dormant row is equally inert.
  const serviceSlugs = unique(serviceSlugsForPolicyPattern(policy, monolith, services));
  const orphanPolicyRetarget = orphanPolicyMode === "retarget_all" ? allServiceSlugs(services) : [];

  if (serviceSlugs.length === 0 && orphanPolicyRetarget.length === 0) {
    throw new Error(
      `Policy ${policy.id} (${policy.pattern}) for org ${tenantHash(policy.tenant)} would be dropped; no target service could be derived`,
    );
  }
  const matchedServices = serviceSlugs.length > 0 ? serviceSlugs : orphanPolicyRetarget;

  return {
    policy,
    action: "rewrite",
    afterPatterns: matchedServices.map((slug) => rewritePatternIntegration(policy.pattern, slug)),
    matchedServices,
  };
};

export interface NeverWidenResult {
  readonly ok: boolean;
  readonly checkedPolicies: number;
  readonly widened: readonly {
    readonly policyId: string;
    readonly beforePattern: string;
    readonly afterPatterns: readonly string[];
    readonly extraAddresses: readonly string[];
  }[];
  readonly narrowed: readonly {
    readonly policyId: string;
    readonly beforePattern: string;
    readonly missingServices: readonly string[];
  }[];
}

export const verifyPolicyRewriteNeverWidens = (
  plan: MigrationPlan,
  input: Pick<MigrationInput, "tools">,
): NeverWidenResult => {
  const widened: {
    readonly policyId: string;
    readonly beforePattern: string;
    readonly afterPatterns: readonly string[];
    readonly extraAddresses: readonly string[];
  }[] = [];
  const narrowed: {
    readonly policyId: string;
    readonly beforePattern: string;
    readonly missingServices: readonly string[];
  }[] = [];
  let checkedPolicies = 0;

  for (const org of plan.orgs) {
    const orgTools = input.tools.filter((tool) => tool.tenant === org.tenant);
    for (const policy of org.policies) {
      if (policy.action !== "rewrite") continue;
      checkedPolicies += 1;
      if (policy.policy.action === "block" || policy.policy.action === "require_approval") {
        const afterServices = new Set(
          policy.afterPatterns.map(
            (afterPattern) => integrationPatternSegment(afterPattern).integration,
          ),
        );
        const missingServices = policy.matchedServices.filter((service) => {
          if (!afterServices.has(service)) return true;
          const expectedPattern = rewritePatternIntegration(policy.policy.pattern, service);
          return !policy.afterPatterns.includes(expectedPattern);
        });
        if (missingServices.length > 0) {
          narrowed.push({
            policyId: policy.policy.id,
            beforePattern: policy.policy.pattern,
            missingServices,
          });
        }
      }
      const before = new Set(
        orgTools
          .filter((tool) => policyMatches(policy.policy.pattern, tool))
          .flatMap((tool) => {
            const monolith = org.deleteMonoliths.find((row) => row.slug === tool.integration);
            if (!monolith) return [];
            const services = policy.matchedServices.filter((slug) =>
              serviceForMatchedTool(
                monolith.plugin_id as MonolithPluginId,
                tool.name,
                org.integrations.map((i) => i.target),
              ).includes(slug),
            );
            return services.map((slug) => `${slug}.${tool.owner}.${tool.connection}.${tool.name}`);
          }),
      );
      const after = new Set(
        orgTools.flatMap((tool) => {
          const monolith = org.deleteMonoliths.find((row) => row.slug === tool.integration);
          if (!monolith) return [];
          const toolServices = serviceForMatchedTool(
            monolith.plugin_id as MonolithPluginId,
            tool.name,
            org.integrations.map((integration) => integration.target),
          );
          return policy.afterPatterns
            .filter((afterPattern) => {
              const targetSlug = integrationPatternSegment(afterPattern).integration;
              if (!toolServices.includes(targetSlug)) return false;
              const targetTool = { ...tool, integration: targetSlug };
              return policyMatches(afterPattern, targetTool);
            })
            .map((afterPattern) => {
              const targetSlug = integrationPatternSegment(afterPattern).integration;
              return `${targetSlug}.${tool.owner}.${tool.connection}.${tool.name}`;
            });
        }),
      );
      const extra = [...after].filter((address) => !before.has(address));
      if (extra.length > 0) {
        widened.push({
          policyId: policy.policy.id,
          beforePattern: policy.policy.pattern,
          afterPatterns: policy.afterPatterns,
          extraAddresses: extra.slice(0, 20),
        });
      }
    }
  }

  return {
    ok: widened.length === 0 && narrowed.length === 0,
    checkedPolicies,
    widened,
    narrowed,
  };
};

export const planMigration = (input: MigrationInput): MigrationPlan => {
  const completed = new Set(input.completedTenants ?? []);
  const monoliths = input.integrations.filter(
    (row) => row.plugin_id === "google" || row.plugin_id === "microsoft",
  );
  const tenants = [...unique(monoliths.map((row) => row.tenant))].sort();
  const trafficLastTenant = input.trafficLastTenant;
  const orderedTenants = trafficLastTenant
    ? [
        ...tenants.filter((tenant) => tenant !== trafficLastTenant),
        ...tenants.filter((tenant) => tenant === trafficLastTenant),
      ]
    : tenants;

  const integrationExists = new Set(input.integrations.map((row) => rowKey(row.tenant, row.slug)));
  const blobBackend = input.blobBackend ?? "database";
  const connectionExists = new Set(
    input.connections.map((row) =>
      rowKey(row.tenant, row.owner, row.subject, row.integration, row.name),
    ),
  );

  const orgs = orderedTenants.map((tenant): OrgPlan => {
    const orgMonoliths = monoliths.filter((row) => row.tenant === tenant);
    const orgTools = input.tools.filter((row) => row.tenant === tenant);
    const orgStorage = input.pluginStorage?.filter((row) => row.tenant === tenant) ?? [];
    const orgBlobs = input.blobs?.filter((row) => row.namespace.startsWith(`o:${tenant}/`)) ?? [];
    const orgConnections: PlannedConnection[] = [];
    const orgPolicies: PlannedPolicyRewrite[] = [];
    const orgBlobCopies: PlannedBlobCopy[] = [];
    const plannedBlobCopyKeys = new Set<string>();
    const hardErrors: string[] = [];
    const plannedIntegrationsBySlug = new Map<string, PlannedIntegration>();
    let clonedToolRows = 0;
    let operationsToBuild = 0;

    for (const monolith of orgMonoliths) {
      const monolithTools = orgTools.filter((tool) => tool.integration === monolith.slug);
      const monolithConnections = input.connections.filter(
        (connection) => connection.tenant === tenant && connection.integration === monolith.slug,
      );
      const monolithOperations = operationRowsForMonolith(monolith, orgStorage);
      let services: readonly ServiceTarget[];
      try {
        services = deriveServices(
          monolith,
          monolithTools,
          input.bootRailCreateToolImpliedServices ?? false,
        );
      } catch (error) {
        if (!input.collectPolicyErrors) throw error;
        hardErrors.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      if (
        isConfigOnlyMonolith({
          tools: monolithTools,
          connections: monolithConnections,
          operations: monolithOperations,
        })
      ) {
        continue;
      }
      try {
        assertNoUnassignedRows(monolith, monolithTools, monolithOperations, services);
      } catch (error) {
        if (!input.collectPolicyErrors) throw error;
        hardErrors.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      const specHash = specHashFor(monolith);
      const namespace = pluginBlobNamespace(tenant, monolith.plugin_id);
      const targetNamespace = pluginBlobNamespace(tenant, "openapi");
      const specBlobPresent =
        (blobBackend === "external" && input.assumeExternalBlobSourcePresent === true) ||
        orgBlobs.some((blob) => blob.namespace === namespace && blob.key === `spec/${specHash}`);
      const defsBlobPresent =
        (blobBackend === "external" && input.assumeExternalBlobSourcePresent === true) ||
        orgBlobs.some((blob) => blob.namespace === namespace && blob.key === `defs/${specHash}`);
      for (const key of [`spec/${specHash}`, `defs/${specHash}`]) {
        const copyKey = rowKey(namespace, targetNamespace, key);
        if (plannedBlobCopyKeys.has(copyKey)) continue;
        plannedBlobCopyKeys.add(copyKey);
        const sourcePresent =
          (blobBackend === "external" && input.assumeExternalBlobSourcePresent === true) ||
          orgBlobs.some((blob) => blob.namespace === namespace && blob.key === key);
        const targetPresent =
          blobBackend === "external"
            ? false
            : orgBlobs.some((blob) => blob.namespace === targetNamespace && blob.key === key);
        if (!sourcePresent) {
          hardErrors.push(
            `Missing source blob ${namespace}/${key} for migrated OpenAPI service namespace ${targetNamespace}`,
          );
        }
        orgBlobCopies.push({
          source: monolith,
          specHash,
          key,
          sourceNamespace: namespace,
          targetNamespace,
          backend: blobBackend,
          sourcePresent,
          targetPresent,
          sourceObjectName: blobObjectName(namespace, key),
          targetObjectName: blobObjectName(targetNamespace, key),
        });
      }
      for (const target of services) {
        const serviceOperations = operationRowsForService(monolith, target, orgStorage);
        const operationToolNames = unique(
          serviceOperations.flatMap((row) => operationToolName(row) ?? []),
        );
        operationsToBuild += operationToolNames.length;
        const contribution = {
          source: monolith,
          specHash,
          operationsToBuild: operationToolNames.length,
          operationToolNames,
          specBlobPresent,
          defsBlobPresent,
        };
        const existing = plannedIntegrationsBySlug.get(target.slug);
        if (existing) {
          const sourceContributions = [...existing.sourceContributions, contribution];
          const winner = sourceContributions.reduce((best, candidate) =>
            candidate.operationsToBuild > best.operationsToBuild ? candidate : best,
          );
          const mergedOperationToolNames = unique(
            sourceContributions.flatMap((item) => item.operationToolNames),
          );
          const next: PlannedIntegration = {
            ...existing,
            sourceContributions,
            source: winner.source,
            config: configForService(winner.source, target),
            servingState: {
              specHash: winner.specHash,
              specSource: `${winner.source.plugin_id}/${winner.source.slug}`,
              blobBackend,
              specBlobPresent: winner.specBlobPresent,
              defsBlobPresent: winner.defsBlobPresent,
              operationsToBuild: mergedOperationToolNames.length,
              operationToolNames: mergedOperationToolNames,
              expectedZeroOperations: false,
            },
          };
          plannedIntegrationsBySlug.set(target.slug, next);
        } else {
          const exists = integrationExists.has(rowKey(tenant, target.slug));
          const planned: PlannedIntegration = {
            source: monolith,
            sourceContributions: [contribution],
            target,
            action: exists ? "skip_existing" : "create",
            config: configForService(monolith, target),
            ...(target.healthCheck ? { healthCheck: target.healthCheck } : {}),
            servingState: {
              specHash,
              specSource: `${monolith.plugin_id}/${monolith.slug}`,
              blobBackend,
              specBlobPresent,
              defsBlobPresent,
              operationsToBuild: operationToolNames.length,
              operationToolNames,
              expectedZeroOperations: false,
            },
          };
          plannedIntegrationsBySlug.set(target.slug, planned);
        }
      }

      for (const connection of monolithConnections) {
        for (const target of services) {
          const key = rowKey(
            tenant,
            connection.owner,
            connection.subject,
            target.slug,
            connection.name,
          );
          const exists = connectionExists.has(key);
          orgConnections.push({
            source: connection,
            targetIntegration: target.slug,
            action: exists ? "skip_existing" : "clone",
            tokenReuse: "copy_item_ids_and_oauth_columns",
          });
          if (!exists) {
            connectionExists.add(key);
          }
          clonedToolRows += monolithTools.filter((tool) =>
            serviceForMatchedTool(monolith.plugin_id as MonolithPluginId, tool.name, [
              target,
            ]).includes(target.slug),
          ).length;
        }
      }

      const candidatePolicies = input.policies.filter((policy) => policy.tenant === tenant);
      for (const policy of candidatePolicies) {
        const patternIntegration = integrationPatternSegment(policy.pattern).integration;
        if (patternIntegration !== monolith.slug) continue;
        try {
          orgPolicies.push(rewritePolicy(policy, monolith, services, input.orphanPolicyMode));
        } catch (error) {
          if (!input.collectPolicyErrors) throw error;
          hardErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    return {
      tenant,
      tenantHash: tenantHash(tenant),
      completed: completed.has(tenant),
      integrations: [...plannedIntegrationsBySlug.values()],
      connections: orgConnections,
      policies: orgPolicies,
      blobCopies: orgBlobCopies,
      deleteMonoliths: orgMonoliths,
      clonedToolRows,
      operationsToBuild,
      hardErrors,
    };
  });

  const activeOrgs = orgs.filter((org) => !org.completed && org.hardErrors.length === 0);
  const summary = {
    orgs: orgs.length,
    completedOrgs: orgs.filter((org) => org.completed).length,
    integrationsCreate: activeOrgs
      .flatMap((org) => org.integrations)
      .filter((row) => row.action === "create").length,
    integrationsSkipExisting: activeOrgs
      .flatMap((org) => org.integrations)
      .filter((row) => row.action === "skip_existing").length,
    connectionsClone: activeOrgs
      .flatMap((org) => org.connections)
      .filter((row) => row.action === "clone").length,
    connectionsSkipExisting: activeOrgs
      .flatMap((org) => org.connections)
      .filter((row) => row.action === "skip_existing").length,
    policiesRewrite: activeOrgs
      .flatMap((org) => org.policies)
      .filter((row) => row.action === "rewrite").length,
    policiesSkip: 0,
    policyRowsAfter: activeOrgs
      .flatMap((org) => org.policies)
      .reduce((sum, row) => sum + row.afterPatterns.length, 0),
    monolithDeletes: activeOrgs.flatMap((org) => org.deleteMonoliths).length,
    clonedToolRows: activeOrgs.reduce((sum, org) => sum + org.clonedToolRows, 0),
    operationsToBuild: activeOrgs.reduce((sum, org) => sum + org.operationsToBuild, 0),
    integrationsMissingSpecBlob: activeOrgs
      .flatMap((org) => org.integrations)
      .filter((row) => !row.servingState.specBlobPresent).length,
    integrationsMissingDefsBlob: activeOrgs
      .flatMap((org) => org.integrations)
      .filter((row) => !row.servingState.defsBlobPresent).length,
    hardErrorOrgs: orgs.filter((org) => !org.completed && org.hardErrors.length > 0).length,
    policyHardErrors: orgs.reduce((sum, org) => sum + org.hardErrors.length, 0),
  };
  return { orgs, summary };
};

const printableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, inner) => (inner === undefined ? null : inner), 2);

export const renderOrgDiff = (org: OrgPlan): string => {
  const lines: string[] = [];
  lines.push(`# Org ${org.tenantHash}`);
  lines.push("");
  if (org.completed) {
    lines.push("Already completed, no changes planned.");
    lines.push("");
    return lines.join("\n");
  }
  if (org.hardErrors.length > 0) {
    lines.push("## Hard Errors");
    lines.push("Apply is blocked for this org until these errors are handled.");
    for (const error of org.hardErrors) {
      lines.push(`- ${error}`);
    }
    lines.push("");
  }
  lines.push("## Integrations");
  for (const row of org.integrations) {
    lines.push(
      `- ${row.action}: ${row.source.plugin_id}/${row.source.slug} (${row.source.name ?? "unnamed"}) -> ${row.target.slug} (${row.target.name})`,
    );
    lines.push(
      `  serving: operations to build: ${row.servingState.operationsToBuild} / spec source: ${row.servingState.specSource} / blob backend: ${row.servingState.blobBackend} / specHash: ${row.servingState.specHash} / spec blob: ${row.servingState.specBlobPresent ? "present" : "missing"} / defs blob: ${row.servingState.defsBlobPresent ? "present" : "missing"}`,
    );
    if (row.sourceContributions.length > 1) {
      for (const contribution of row.sourceContributions) {
        lines.push(
          `  contribution: ${contribution.source.plugin_id}/${contribution.source.slug} / operations: ${contribution.operationsToBuild} / specHash: ${contribution.specHash ?? "none"}`,
        );
      }
    }
    lines.push(`  config: ${printableJson(row.config).replaceAll("\n", "\n  ")}`);
  }
  for (const row of org.deleteMonoliths) {
    lines.push(
      `- delete monolith in apply mode: ${row.plugin_id}/${row.slug} (${row.name ?? "unnamed"})`,
    );
  }
  lines.push("");
  lines.push("## Blob Copies");
  for (const row of org.blobCopies) {
    lines.push(
      `- ${row.backend}: ${row.sourceObjectName} -> ${row.targetObjectName} / source: ${row.sourcePresent ? "present" : "missing"} / target: ${row.targetPresent ? "present" : "missing"}`,
    );
  }
  lines.push("");
  lines.push("## Connections");
  for (const row of org.connections) {
    lines.push(
      `- ${row.action}: ${row.source.integration}.${row.source.owner}.${row.source.name} -> ${row.targetIntegration}.${row.source.owner}.${row.source.name} (${row.tokenReuse})`,
    );
  }
  lines.push("");
  lines.push("## Policies");
  for (const row of org.policies) {
    lines.push(`- rewrite ${row.policy.id}: ${row.policy.pattern}`);
    for (const after of row.afterPatterns) {
      lines.push(`  -> ${after}`);
    }
  }
  lines.push("");
  lines.push("## Internal Rows");
  lines.push(`- tool rows cloned in apply mode: ${org.clonedToolRows}`);
  lines.push(`- operation rows copied in apply mode: ${org.operationsToBuild}`);
  lines.push("");
  return lines.join("\n");
};

export const renderSummary = (plan: MigrationPlan): string => {
  const s = plan.summary;
  return [
    `orgs=${s.orgs}`,
    `completed_orgs=${s.completedOrgs}`,
    `integrations_create=${s.integrationsCreate}`,
    `integrations_skip_existing=${s.integrationsSkipExisting}`,
    `connections_clone=${s.connectionsClone}`,
    `connections_skip_existing=${s.connectionsSkipExisting}`,
    `policies_rewrite=${s.policiesRewrite}`,
    `policy_rows_after=${s.policyRowsAfter}`,
    `policies_skip=${s.policiesSkip}`,
    `monolith_deletes=${s.monolithDeletes}`,
    `tool_rows_clone=${s.clonedToolRows}`,
    `operation_rows_build=${s.operationsToBuild}`,
    `integrations_missing_spec_blob=${s.integrationsMissingSpecBlob}`,
    `integrations_missing_defs_blob=${s.integrationsMissingDefsBlob}`,
    `hard_error_orgs=${s.hardErrorOrgs}`,
    `policy_hard_errors=${s.policyHardErrors}`,
  ].join("\n");
};
