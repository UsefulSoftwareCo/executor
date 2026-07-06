import { createHash } from "node:crypto";

interface ServicePreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly url?: string;
  readonly scopes?: readonly string[];
}

const gd = (service: string, version: string): string =>
  `https://www.googleapis.com/discovery/v1/apis/${service}/${version}/rest`;

const googleOpenApiPresets: readonly ServicePreset[] = [
  {
    id: "google-calendar",
    name: "Google Calendar",
    summary: "Calendars, events, ACLs, and scheduling.",
    url: gd("calendar", "v3"),
  },
  {
    id: "google-gmail",
    name: "Gmail",
    summary: "Messages, threads, labels, and drafts.",
    url: gd("gmail", "v1"),
  },
  {
    id: "google-sheets",
    name: "Google Sheets",
    summary: "Spreadsheets, values, ranges, and formatting.",
    url: gd("sheets", "v4"),
  },
  {
    id: "google-drive",
    name: "Google Drive",
    summary: "Files, folders, permissions, and shared drives.",
    url: gd("drive", "v3"),
  },
  {
    id: "google-docs",
    name: "Google Docs",
    summary: "Documents, structural edits, and formatting.",
    url: gd("docs", "v1"),
  },
  {
    id: "google-slides",
    name: "Google Slides",
    summary: "Presentations, slides, page elements, and deck updates.",
    url: gd("slides", "v1"),
  },
  {
    id: "google-forms",
    name: "Google Forms",
    summary: "Forms, questions, responses, and quizzes.",
    url: "https://forms.googleapis.com/$discovery/rest?version=v1",
  },
  {
    id: "google-tasks",
    name: "Google Tasks",
    summary: "Task lists, task items, notes, and due dates.",
    url: gd("tasks", "v1"),
  },
  {
    id: "google-people",
    name: "Google People",
    summary: "Contacts, profiles, directory people, and contact groups.",
    url: gd("people", "v1"),
  },
  {
    id: "google-photos-library",
    name: "Google Photos Library",
    summary: "Albums, uploads, and app-created media through Google Photos.",
    url: gd("photoslibrary", "v1"),
  },
  {
    id: "google-photos-picker",
    name: "Google Photos Picker",
    summary: "Picker sessions and user-selected Google Photos media items.",
    url: "https://photospicker.googleapis.com/$discovery/rest?version=v1",
  },
  {
    id: "google-chat",
    name: "Google Chat",
    summary: "Spaces, messages, members, reactions, and chat workflows.",
    url: gd("chat", "v1"),
  },
  {
    id: "google-keep",
    name: "Google Keep",
    summary: "Notes, lists, attachments, and annotations.",
    url: "https://keep.googleapis.com/$discovery/rest?version=v1",
  },
  {
    id: "google-youtube-data",
    name: "YouTube Data",
    summary: "Channels, playlists, videos, comments, and uploads.",
    url: gd("youtube", "v3"),
  },
  {
    id: "google-search-console",
    name: "Google Search Console",
    summary: "Sites, sitemaps, URL inspection, and search performance.",
    url: gd("searchconsole", "v1"),
  },
  {
    id: "google-classroom",
    name: "Google Classroom",
    summary: "Courses, rosters, coursework, and grading.",
    url: gd("classroom", "v1"),
  },
  {
    id: "google-admin-directory",
    name: "Google Admin Directory",
    summary: "Users, groups, org units, roles, and domain resources.",
    url: "https://www.googleapis.com/discovery/v1/apis/admin/directory_v1/rest",
  },
  {
    id: "google-admin-reports",
    name: "Google Admin Reports",
    summary: "Audit events, usage reports, and admin activity logs.",
    url: "https://www.googleapis.com/discovery/v1/apis/admin/reports_v1/rest",
  },
  {
    id: "google-apps-script",
    name: "Google Apps Script",
    summary: "Projects, deployments, and script execution.",
    url: gd("script", "v1"),
  },
  {
    id: "google-bigquery",
    name: "Google BigQuery",
    summary: "Datasets, tables, jobs, and analytical queries.",
    url: gd("bigquery", "v2"),
  },
  {
    id: "google-cloud-resource-manager",
    name: "Google Cloud Resource Manager",
    summary: "Projects, folders, organizations, and IAM hierarchy.",
    url: "https://cloudresourcemanager.googleapis.com/$discovery/rest?version=v3",
  },
];

const microsoftGraphScopePresets: readonly ServicePreset[] = [
  {
    id: "profile",
    name: "Profile",
    summary: "Signed-in user profile and photo.",
    scopes: ["User.Read"],
  },
  {
    id: "me-surface",
    name: "My Graph Operations",
    summary: "All operation groups rooted under /me.",
    scopes: ["User.Read"],
  },
  {
    id: "mail",
    name: "Outlook Mail",
    summary: "Messages, folders, attachments, settings, and send mail.",
    scopes: ["Mail.ReadWrite", "Mail.Send", "MailboxSettings.ReadWrite"],
  },
  {
    id: "calendar",
    name: "Outlook Calendar",
    summary: "Calendars, events, and scheduling.",
    scopes: ["Calendars.ReadWrite"],
  },
  {
    id: "contacts",
    name: "Outlook Contacts",
    summary: "Contacts, contact folders, and people suggestions.",
    scopes: ["Contacts.ReadWrite", "People.Read.All"],
  },
  {
    id: "tasks",
    name: "To Do Tasks",
    summary: "Task lists, tasks, and checklist items.",
    scopes: ["Tasks.ReadWrite"],
  },
  {
    id: "planner",
    name: "Planner",
    summary: "Plans, buckets, tasks, assignments, and Planner user data.",
    scopes: ["Tasks.ReadWrite"],
  },
  {
    id: "files",
    name: "OneDrive Files",
    summary: "Drives, files, folders, sharing links, and permissions.",
    scopes: ["Files.ReadWrite.All", "Sites.ReadWrite.All"],
  },
  {
    id: "excel",
    name: "Excel Workbooks",
    summary: "Workbook tables, worksheets, ranges, charts, and sessions.",
    scopes: ["Files.ReadWrite.All"],
  },
  {
    id: "sites",
    name: "SharePoint Sites",
    summary: "Sites, lists, pages, columns, content types, and stores.",
    scopes: ["Sites.ReadWrite.All"],
  },
  {
    id: "onenote",
    name: "OneNote",
    summary: "Notebooks, sections, pages, and page content.",
    scopes: ["Notes.ReadWrite"],
  },
  {
    id: "teams-chat",
    name: "Teams Chats",
    summary: "Chats, chat messages, installed apps, and members.",
    scopes: ["Chat.ReadWrite"],
  },
  {
    id: "teams-channels",
    name: "Teams Channels",
    summary: "Teams, channels, channel messages, replies, and joined teams.",
    scopes: [
      "Team.ReadBasic.All",
      "Channel.ReadBasic.All",
      "ChannelMessage.Read.All",
      "ChannelMessage.Send",
    ],
  },
  {
    id: "meetings-calls",
    name: "Meetings and Calls",
    summary: "Online meetings, calls, call records, and presence.",
    scopes: ["OnlineMeetings.ReadWrite", "Calls.AccessMedia.All"],
  },
];

const MICROSOFT_GRAPH_DEFAULT_PRESET_IDS: readonly string[] = [
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
];

const googleServiceSlug = (presetId: string): string => presetId.replaceAll("-", "_");
const microsoftServiceSlug = (presetId: string): string =>
  `microsoft_${presetId.replaceAll("-", "_")}`;
const microsoftGraphScopesForPresetIds = (
  presetIds: Iterable<string>,
  customScopes: Iterable<string> = [],
): readonly string[] =>
  unique([
    ...[...presetIds].flatMap((presetId) => microsoftPresetById.get(presetId)?.scopes ?? []),
    ...customScopes,
  ]);

const normalizeUrl = (url: string): string => {
  const trimmed = url.trim();
  if (!URL.canParse(trimmed)) return trimmed.replace(/\/$/, "");
  const parsed = new URL(trimmed);
  parsed.hash = "";
  parsed.searchParams.sort();
  return parsed.toString().replace(/\/$/, "");
};

const googlePresetByNormalizedUrl = new Map(
  googleOpenApiPresets.flatMap((preset) =>
    preset.url ? [[normalizeUrl(preset.url), preset] as const] : [],
  ),
);

const googlePresetForDiscoveryUrl = (url: string): ServicePreset | undefined =>
  googlePresetByNormalizedUrl.get(normalizeUrl(url));

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

export type PluginId = "google" | "microsoft";

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
  readonly blobBackend?: "database" | "external";
}

export interface ServiceTarget {
  readonly pluginId: PluginId;
  readonly presetId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
}

export interface PlannedIntegration {
  readonly source: Pick<IntegrationRow, "tenant" | "slug" | "plugin_id" | "name">;
  readonly target: ServiceTarget;
  readonly action: "create" | "skip_existing";
  readonly config: unknown;
  readonly servingState: {
    readonly specHash: string;
    readonly specSource: string;
    readonly blobBackend: "database" | "external";
    readonly specBlobPresent: boolean;
    readonly defsBlobPresent: boolean;
    readonly operationsToBuild: number;
    readonly operationToolNames: readonly string[];
  };
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
  ["admin", "google-admin-directory"],
  ["script", "google-apps-script"],
  ["bigquery", "google-bigquery"],
  ["cloudresourcemanager", "google-cloud-resource-manager"],
]);

const googlePresetById: ReadonlyMap<string, ServicePreset> = new Map(
  googleOpenApiPresets.map((preset) => [preset.id, preset]),
);

const microsoftPresetById: ReadonlyMap<string, ServicePreset> = new Map(
  microsoftGraphScopePresets.map((preset) => [preset.id, preset]),
);

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

const serviceSlugForPreset = (pluginId: PluginId, presetId: string): string =>
  pluginId === "google" ? googleServiceSlug(presetId) : microsoftServiceSlug(presetId);

const serviceTargetForPreset = (
  pluginId: PluginId,
  presetId: string,
): ServiceTarget | undefined => {
  if (pluginId === "google") {
    const preset = googlePresetById.get(presetId);
    if (!preset) return undefined;
    return {
      pluginId,
      presetId,
      slug: googleServiceSlug(preset.id),
      name: preset.name,
      description: preset.summary,
    };
  }
  const preset = microsoftPresetById.get(presetId);
  if (!preset) return undefined;
  return {
    pluginId,
    presetId,
    slug: microsoftServiceSlug(preset.id),
    name: preset.name,
    description: preset.summary,
  };
};

const googlePresetIdsFromConfig = (integration: IntegrationRow): readonly string[] => {
  const urls = stringArray(configRecord(integration).googleDiscoveryUrls);
  return unique(
    urls.flatMap((url) => {
      if (url === GOOGLE_IDENTITY_DISCOVERY_URL || url.includes("/oauth2/")) return [];
      const preset = googlePresetForDiscoveryUrl(url);
      return preset ? [preset.id] : [];
    }),
  );
};

const microsoftPresetIdsFromConfig = (integration: IntegrationRow): readonly string[] => {
  const config = configRecord(integration);
  const configured = stringArray(config.microsoftGraphPresetIds);
  if (configured.length > 0) return unique(configured);
  throw new Error(
    `Microsoft monolith ${tenantHash(integration.tenant)}/${integration.slug} has no stored microsoftGraphPresetIds; refusing to fabricate ${MICROSOFT_GRAPH_DEFAULT_PRESET_IDS.length} default workloads`,
  );
};

const googlePresetIdForTool = (toolName: string): string | undefined =>
  GOOGLE_TOOL_PREFIX_TO_PRESET_ID.get(toolName.split(".")[0] ?? "");

const microsoftPresetIdForTool = (toolName: string): string | undefined => {
  const first = toolName.split(".")[0] ?? "";
  if (/^(me|users).*Message|^meMail|^usersMail|^meMailbox|^meOutlook|^usersOutlook/.test(first)) {
    return "mail";
  }
  if (/Calendar|Event|Reminder|findMeetingTimes/.test(first)) return "calendar";
  if (/Contact|Person/.test(first)) return "contacts";
  if (/Todo/.test(first)) return "tasks";
  if (/Planner/.test(first)) return "planner";
  if (/Drive|drives|shares/.test(first)) return "files";
  if (/Workbook|Excel/.test(first)) return "excel";
  if (/sites|Site|List|SharePoint/.test(first)) return "sites";
  if (/Onenote/.test(first)) return "onenote";
  if (/chats|Chat/.test(first)) return "teams-chat";
  if (/teams|Team|teamwork|Channel/.test(first)) return "teams-channels";
  if (/communications|OnlineMeeting|Call|Presence/.test(first)) return "meetings-calls";
  if (/^meUser|^usersUser|ProfilePhoto/.test(first)) return "profile";
  return undefined;
};

const presetIdForTool = (pluginId: PluginId, toolName: string): string | undefined =>
  pluginId === "google" ? googlePresetIdForTool(toolName) : microsoftPresetIdForTool(toolName);

const deriveServices = (
  integration: IntegrationRow,
  tools: readonly ToolRow[],
): readonly ServiceTarget[] => {
  const pluginId = integration.plugin_id as PluginId;
  const fromConfig =
    pluginId === "google"
      ? googlePresetIdsFromConfig(integration)
      : microsoftPresetIdsFromConfig(integration);
  const fromTools = unique(tools.flatMap((tool) => presetIdForTool(pluginId, tool.name) ?? []));
  const presetIds = fromConfig.length > 0 ? fromConfig : fromTools;
  return presetIds.flatMap((presetId) => serviceTargetForPreset(pluginId, presetId) ?? []);
};

const configForService = (source: IntegrationRow, target: ServiceTarget): unknown => {
  const config = configRecord(source);
  const specHash =
    typeof config.specHash === "string" && config.specHash.length > 0 ? config.specHash : undefined;
  if (target.pluginId === "google") {
    const preset = googlePresetById.get(target.presetId);
    const sourceUrls = stringArray(config.googleDiscoveryUrls);
    const hasIdentity = sourceUrls.some(
      (url) => url === GOOGLE_IDENTITY_DISCOVERY_URL || url.includes("/oauth2/"),
    );
    const googleDiscoveryUrls = [
      ...(preset?.url ? [preset.url] : []),
      ...(hasIdentity ? [GOOGLE_IDENTITY_DISCOVERY_URL] : []),
    ];
    return {
      ...config,
      googleDiscoveryUrls,
      specHash,
    };
  }
  const presetIds = [target.presetId];
  return {
    ...config,
    microsoftGraphPresetIds: presetIds,
    microsoftGraphScopes: microsoftGraphScopesForPresetIds(
      presetIds,
      stringArray(config.microsoftGraphCustomScopes),
    ),
    specHash,
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
    return serviceForMatchedTool(monolith.plugin_id as PluginId, toolName, [target]).includes(
      target.slug,
    );
  });

const serviceForMatchedTool = (
  pluginId: PluginId,
  toolName: string,
  services: readonly ServiceTarget[],
): readonly string[] => {
  const presetId = presetIdForTool(pluginId, toolName);
  if (presetId) {
    const slug = serviceSlugForPreset(pluginId, presetId);
    return services.some((service) => service.slug === slug) ? [slug] : [];
  }
  if (pluginId === "google" && toolName.startsWith("oauth2.")) {
    return services.map((service) => service.slug);
  }
  return [];
};

const allServiceSlugs = (services: readonly ServiceTarget[]): readonly string[] =>
  services.map((service) => service.slug);

const serviceSlugsForToolPattern = (
  pluginId: PluginId,
  toolSegments: readonly string[],
  services: readonly ServiceTarget[],
): readonly string[] => {
  const firstToolSegment = toolSegments[0];
  if (!firstToolSegment || firstToolSegment === "*") return allServiceSlugs(services);
  const presetId =
    pluginId === "google"
      ? GOOGLE_TOOL_PREFIX_TO_PRESET_ID.get(firstToolSegment)
      : microsoftPresetIdForTool(firstToolSegment);
  if (!presetId) return [];
  const slug = serviceSlugForPreset(pluginId, presetId);
  return services.some((service) => service.slug === slug) ? [slug] : [];
};

const serviceSlugsForPolicyPattern = (
  policy: ToolPolicyRow,
  monolith: IntegrationRow,
  services: readonly ServiceTarget[],
): readonly string[] => {
  const tail = withoutToolsPrefix(policy.pattern);
  const segments = tail.split(".");
  const rest = segments.slice(1);
  const pluginId = monolith.plugin_id as PluginId;
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
): PlannedPolicyRewrite => {
  const patternIntegration = integrationPatternSegment(policy.pattern).integration;
  if (patternIntegration !== monolith.slug) {
    throw new Error(
      `Policy ${policy.id} for org ${tenantHash(policy.tenant)} does not target ${monolith.slug}`,
    );
  }

  const serviceSlugs = unique(serviceSlugsForPolicyPattern(policy, monolith, services));

  if (serviceSlugs.length === 0) {
    throw new Error(
      `Policy ${policy.id} (${policy.pattern}) for org ${tenantHash(policy.tenant)} would be dropped; no target service could be derived`,
    );
  }

  return {
    policy,
    action: "rewrite",
    afterPatterns: serviceSlugs.map((slug) => rewritePatternIntegration(policy.pattern, slug)),
    matchedServices: serviceSlugs,
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
                monolith.plugin_id as PluginId,
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
            monolith.plugin_id as PluginId,
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

  return { ok: widened.length === 0 && narrowed.length === 0, checkedPolicies, widened, narrowed };
};

export const planMigration = (input: MigrationInput): MigrationPlan => {
  const completed = new Set(input.completedTenants ?? []);
  const monoliths = input.integrations.filter(
    (row) =>
      (row.plugin_id === "google" && row.slug === "google") ||
      (row.plugin_id === "microsoft" && row.slug === "microsoft"),
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
    const orgIntegrations: PlannedIntegration[] = [];
    const orgConnections: PlannedConnection[] = [];
    const orgPolicies: PlannedPolicyRewrite[] = [];
    const hardErrors: string[] = [];
    let clonedToolRows = 0;
    let operationsToBuild = 0;

    for (const monolith of orgMonoliths) {
      const monolithTools = orgTools.filter((tool) => tool.integration === monolith.slug);
      const services = deriveServices(monolith, monolithTools);
      const specHash = specHashFor(monolith);
      const namespace = pluginBlobNamespace(tenant, monolith.plugin_id);
      const specBlobPresent =
        blobBackend === "external" ||
        orgBlobs.some((blob) => blob.namespace === namespace && blob.key === `spec/${specHash}`);
      const defsBlobPresent =
        blobBackend === "external" ||
        orgBlobs.some((blob) => blob.namespace === namespace && blob.key === `defs/${specHash}`);
      for (const target of services) {
        const exists = integrationExists.has(rowKey(tenant, target.slug));
        const serviceOperations = operationRowsForService(monolith, target, orgStorage);
        const operationToolNames = unique(
          serviceOperations.flatMap((row) => operationToolName(row) ?? []),
        );
        operationsToBuild += operationToolNames.length;
        orgIntegrations.push({
          source: monolith,
          target,
          action: exists ? "skip_existing" : "create",
          config: configForService(monolith, target),
          servingState: {
            specHash,
            specSource: `${monolith.plugin_id}/${monolith.slug}`,
            blobBackend,
            specBlobPresent,
            defsBlobPresent,
            operationsToBuild: operationToolNames.length,
            operationToolNames,
          },
        });
      }

      const monolithConnections = input.connections.filter(
        (connection) => connection.tenant === tenant && connection.integration === monolith.slug,
      );
      for (const connection of monolithConnections) {
        for (const target of services) {
          const exists = connectionExists.has(
            rowKey(tenant, connection.owner, connection.subject, target.slug, connection.name),
          );
          orgConnections.push({
            source: connection,
            targetIntegration: target.slug,
            action: exists ? "skip_existing" : "clone",
            tokenReuse: "copy_item_ids_and_oauth_columns",
          });
          clonedToolRows += monolithTools.filter((tool) =>
            serviceForMatchedTool(monolith.plugin_id as PluginId, tool.name, [target]).includes(
              target.slug,
            ),
          ).length;
        }
      }

      const candidatePolicies = input.policies.filter((policy) => policy.tenant === tenant);
      for (const policy of candidatePolicies) {
        const patternIntegration = integrationPatternSegment(policy.pattern).integration;
        if (patternIntegration !== monolith.slug) continue;
        try {
          orgPolicies.push(rewritePolicy(policy, monolith, services));
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
      integrations: orgIntegrations,
      connections: orgConnections,
      policies: orgPolicies,
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
    lines.push("Apply is blocked for this org until these policies are handled.");
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
    lines.push(`  config: ${printableJson(row.config).replaceAll("\n", "\n  ")}`);
  }
  for (const row of org.deleteMonoliths) {
    lines.push(
      `- delete monolith in apply mode: ${row.plugin_id}/${row.slug} (${row.name ?? "unnamed"})`,
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
