export interface MicrosoftGraphPreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly icon?: string;
  readonly featured?: boolean;
}

export type MicrosoftGraphScopeAudience =
  | "productivity"
  | "files-content"
  | "collaboration"
  | "directory-identity"
  | "admin-security"
  | "platform-business";

export interface MicrosoftGraphScopePreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly icon?: string;
  readonly scopes: readonly string[];
  readonly exactPaths?: readonly string[];
  readonly pathPrefixes?: readonly string[];
  readonly tagPrefixes?: readonly string[];
  readonly featured?: boolean;
  readonly audience: MicrosoftGraphScopeAudience;
}

const MICROSOFT_ICON = "https://www.microsoft.com/favicon.ico";
const svglIcon = (name: string) => `https://svgl.app/library/${name}.svg`;

export const MICROSOFT_GRAPH_OPENAPI_URL =
  "https://raw.githubusercontent.com/microsoftgraph/msgraph-metadata/master/openapi/v1.0/openapi.yaml";
export const MICROSOFT_GRAPH_PERMISSIONS_REFERENCE_URL =
  "https://raw.githubusercontent.com/microsoftgraph/microsoft-graph-docs-contrib/main/concepts/permissions-reference.md";
export const MICROSOFT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
export const MICROSOFT_AUTHORIZATION_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
export const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
export const MICROSOFT_AUTH_TEMPLATE_SLUG = "azureAdDelegated";
export const MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG = "azureAdClientCredentials";
export const MICROSOFT_GRAPH_BASE_SCOPES: readonly string[] = ["offline_access"];
export const MICROSOFT_GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default";
export const MICROSOFT_GRAPH_DELEGATED_DEFAULT_SCOPES: readonly string[] = [
  ...MICROSOFT_GRAPH_BASE_SCOPES,
  MICROSOFT_GRAPH_DEFAULT_SCOPE,
];
export const MICROSOFT_GRAPH_CLIENT_CREDENTIALS_SCOPES: readonly string[] = [
  MICROSOFT_GRAPH_DEFAULT_SCOPE,
];

export const MICROSOFT_GRAPH_PRESET_ID = "microsoft";

export const microsoftGraphPreset: MicrosoftGraphPreset = {
  id: MICROSOFT_GRAPH_PRESET_ID,
  name: "Microsoft Graph",
  summary: "Bundle Microsoft 365 workloads into one Graph source and one OAuth consent.",
  icon: MICROSOFT_ICON,
  featured: true,
};

export const microsoftGraphScopePresets: readonly MicrosoftGraphScopePreset[] = [
  {
    id: "profile",
    name: "Profile",
    summary: "Signed-in user profile and photo.",
    icon: svglIcon("microsoft"),
    scopes: ["User.Read"],
    exactPaths: ["/me", "/me/photo", "/me/photo/$value"],
    featured: true,
    audience: "productivity",
  },
  {
    id: "me-surface",
    name: "My Graph Operations",
    summary: "All operation groups rooted under /me.",
    icon: svglIcon("microsoft"),
    scopes: ["User.Read"],
    pathPrefixes: ["/me"],
    audience: "productivity",
  },
  {
    id: "mail",
    name: "Outlook Mail",
    summary: "Messages, folders, attachments, settings, and send mail.",
    icon: svglIcon("microsoft-outlook"),
    scopes: ["Mail.ReadWrite", "Mail.Send", "MailboxSettings.ReadWrite"],
    pathPrefixes: [
      "/me/messages",
      "/me/mailFolders",
      "/me/sendMail",
      "/me/getMailTips",
      "/me/inferenceClassification",
      "/me/mailboxSettings",
      "/me/outlook",
      "/users/{user-id}/messages",
      "/users/{user-id}/mailFolders",
      "/users/{user-id}/sendMail",
      "/users/{user-id}/outlook",
    ],
    featured: true,
    audience: "productivity",
  },
  {
    id: "calendar",
    name: "Outlook Calendar",
    summary: "Calendars, events, and scheduling.",
    icon: svglIcon("microsoft-outlook"),
    scopes: ["Calendars.ReadWrite"],
    pathPrefixes: [
      "/me/calendar",
      "/me/calendars",
      "/me/calendarGroups",
      "/me/calendarView",
      "/me/events",
      "/me/findMeetingTimes",
      "/me/reminderView",
      "/users/{user-id}/calendar",
      "/users/{user-id}/calendars",
      "/users/{user-id}/calendarGroups",
      "/users/{user-id}/calendarView",
      "/users/{user-id}/events",
      "/users/{user-id}/findMeetingTimes",
      "/users/{user-id}/reminderView",
    ],
    featured: true,
    audience: "productivity",
  },
  {
    id: "contacts",
    name: "Outlook Contacts",
    summary: "Contacts, contact folders, and people suggestions.",
    icon: svglIcon("microsoft-outlook"),
    scopes: ["Contacts.ReadWrite", "People.Read.All"],
    pathPrefixes: [
      "/me/contacts",
      "/me/contactFolders",
      "/me/people",
      "/users/{user-id}/contacts",
      "/users/{user-id}/contactFolders",
      "/users/{user-id}/people",
    ],
    audience: "productivity",
  },
  {
    id: "tasks",
    name: "To Do Tasks",
    summary: "Task lists, tasks, and checklist items.",
    icon: svglIcon("microsoft-todo"),
    scopes: ["Tasks.ReadWrite"],
    pathPrefixes: ["/me/todo", "/users/{user-id}/todo"],
    audience: "productivity",
  },
  {
    id: "planner",
    name: "Planner",
    summary: "Plans, buckets, tasks, assignments, and Planner user data.",
    icon: svglIcon("microsoft"),
    scopes: ["Tasks.ReadWrite"],
    pathPrefixes: [
      "/planner",
      "/me/planner",
      "/users/{user-id}/planner",
      "/groups/{group-id}/planner",
    ],
    audience: "productivity",
  },
  {
    id: "files",
    name: "OneDrive Files",
    summary: "Drives, files, folders, sharing links, and permissions.",
    icon: svglIcon("microsoft-onedrive"),
    scopes: ["Files.ReadWrite.All", "Sites.ReadWrite.All"],
    pathPrefixes: [
      "/me/drive",
      "/me/drives",
      "/me/followedSites",
      "/users/{user-id}/drive",
      "/users/{user-id}/drives",
      "/groups/{group-id}/drive",
      "/groups/{group-id}/drives",
      "/drives",
      "/shares",
    ],
    featured: true,
    audience: "files-content",
  },
  {
    id: "excel",
    name: "Excel Workbooks",
    summary: "Workbook tables, worksheets, ranges, charts, and sessions.",
    icon: svglIcon("microsoft-excel"),
    scopes: ["Files.ReadWrite.All"],
    pathPrefixes: [
      "/me/drive/items/{driveItem-id}/workbook",
      "/users/{user-id}/drive/items/{driveItem-id}/workbook",
      "/groups/{group-id}/drive/items/{driveItem-id}/workbook",
      "/drives/{drive-id}/items/{driveItem-id}/workbook",
    ],
    audience: "files-content",
  },
  {
    id: "sites",
    name: "SharePoint Sites",
    summary: "Sites, lists, pages, columns, content types, and stores.",
    icon: svglIcon("microsoft-sharepoint"),
    scopes: ["Sites.ReadWrite.All"],
    pathPrefixes: ["/sites"],
    featured: true,
    audience: "files-content",
  },
  {
    id: "onenote",
    name: "OneNote",
    summary: "Notebooks, sections, pages, and page content.",
    icon: svglIcon("microsoft-onenote"),
    scopes: ["Notes.ReadWrite"],
    pathPrefixes: [
      "/me/onenote",
      "/users/{user-id}/onenote",
      "/groups/{group-id}/onenote",
      "/sites/{site-id}/onenote",
    ],
    audience: "files-content",
  },
  {
    id: "teams-chat",
    name: "Teams Chats",
    summary: "Chats, chat messages, installed apps, and members.",
    icon: svglIcon("microsoft-teams"),
    scopes: ["Chat.ReadWrite"],
    pathPrefixes: ["/me/chats", "/chats"],
    audience: "collaboration",
  },
  {
    id: "teams-channels",
    name: "Teams Channels",
    summary: "Teams, channels, channel messages, replies, and joined teams.",
    icon: svglIcon("microsoft-teams"),
    scopes: [
      "Team.ReadBasic.All",
      "Channel.ReadBasic.All",
      "ChannelMessage.Read.All",
      "ChannelMessage.Send",
    ],
    pathPrefixes: [
      "/me/joinedTeams",
      "/groups/{group-id}/team",
      "/teams",
      "/teamwork",
      "/teamsTemplates",
    ],
    audience: "collaboration",
  },
  {
    id: "meetings-calls",
    name: "Meetings and Calls",
    summary: "Online meetings, calls, call records, and communications APIs.",
    icon: svglIcon("microsoft-teams"),
    scopes: ["OnlineMeetings.ReadWrite"],
    pathPrefixes: ["/communications", "/me/onlineMeetings", "/users/{user-id}/onlineMeetings"],
    audience: "collaboration",
  },
  {
    id: "users",
    name: "Users",
    summary: "User objects plus user-scoped Graph operations.",
    icon: svglIcon("microsoft"),
    scopes: ["User.ReadWrite.All", "Directory.Read.All"],
    pathPrefixes: ["/users", "/users(userPrincipalName='{userPrincipalName}')"],
    featured: true,
    audience: "directory-identity",
  },
  {
    id: "groups",
    name: "Groups",
    summary: "Groups, settings, lifecycle policies, and group-scoped operations.",
    icon: svglIcon("microsoft"),
    scopes: ["Group.ReadWrite.All", "Directory.Read.All"],
    pathPrefixes: [
      "/groups",
      "/groups(uniqueName='{uniqueName}')",
      "/groupSettings",
      "/groupSettingTemplates",
      "/groupLifecyclePolicies",
    ],
    audience: "directory-identity",
  },
  {
    id: "directory",
    name: "Directory",
    summary: "Directory roles, objects, contacts, contracts, and invitations.",
    icon: svglIcon("microsoft"),
    scopes: ["Directory.Read.All"],
    pathPrefixes: [
      "/contacts",
      "/contracts",
      "/directory",
      "/directoryObjects",
      "/directoryRoles",
      "/directoryRoles(roleTemplateId='{roleTemplateId}')",
      "/directoryRoleTemplates",
      "/invitations",
      "/scopedRoleMemberships",
    ],
    audience: "directory-identity",
  },
  {
    id: "applications",
    name: "Applications",
    summary: "Applications, service principals, app templates, catalogs, and grants.",
    icon: svglIcon("microsoft"),
    scopes: ["Application.ReadWrite.All", "AppRoleAssignment.ReadWrite.All"],
    pathPrefixes: [
      "/applications",
      "/applications(appId='{appId}')",
      "/applications(uniqueName='{uniqueName}')",
      "/applicationTemplates",
      "/appCatalogs",
      "/oauth2PermissionGrants",
      "/permissionGrants",
      "/servicePrincipals",
      "/servicePrincipals(appId='{appId}')",
    ],
    audience: "directory-identity",
  },
  {
    id: "identity",
    name: "Identity and Governance",
    summary: "Identity, governance, policies, access reviews, roles, and providers.",
    icon: svglIcon("microsoft"),
    scopes: ["Policy.ReadWrite.ConditionalAccess", "RoleManagement.Read.Directory"],
    pathPrefixes: [
      "/agreementAcceptances",
      "/agreements",
      "/authenticationMethodConfigurations",
      "/authenticationMethodsPolicy",
      "/certificateBasedAuthConfiguration",
      "/identity",
      "/identityGovernance",
      "/identityProviders",
      "/identityProtection",
      "/policies",
      "/roleManagement",
    ],
    audience: "directory-identity",
  },
  {
    id: "admin-reports",
    name: "Admin and Reports",
    summary: "Admin centers, audit logs, domains, reports, organization, and tenants.",
    icon: svglIcon("microsoft"),
    scopes: ["AuditLog.Read.All", "Reports.Read.All"],
    pathPrefixes: [
      "/admin",
      "/auditLogs",
      "/domains",
      "/domainDnsRecords",
      "/organization",
      "/reports",
      "/subscribedSkus",
      "/tenantRelationships",
    ],
    audience: "admin-security",
  },
  {
    id: "security-compliance",
    name: "Security and Compliance",
    summary: "Security, compliance, privacy, information protection, and data policy.",
    icon: svglIcon("microsoft"),
    scopes: ["SecurityEvents.Read.All"],
    pathPrefixes: [
      "/compliance",
      "/dataPolicyOperations",
      "/informationProtection",
      "/privacy",
      "/security",
    ],
    audience: "admin-security",
  },
  {
    id: "devices",
    name: "Devices and Intune",
    summary: "Devices, device management, Intune apps, managed devices, and policies.",
    icon: svglIcon("microsoft"),
    scopes: ["DeviceManagementApps.ReadWrite.All", "DeviceManagementManagedDevices.ReadWrite.All"],
    pathPrefixes: [
      "/devices",
      "/devices(deviceId='{deviceId}')",
      "/deviceAppManagement",
      "/deviceManagement",
    ],
    audience: "admin-security",
  },
  {
    id: "education",
    name: "Education",
    summary: "Classes, schools, education users, assignments, and reports.",
    icon: svglIcon("microsoft"),
    scopes: [],
    pathPrefixes: ["/education"],
    audience: "admin-security",
  },
  {
    id: "search",
    name: "Microsoft Search",
    summary: "Search across Microsoft Graph content connectors.",
    icon: svglIcon("microsoft"),
    scopes: ["ExternalItem.Read.All", "Acronym.Read.All", "Bookmark.Read.All", "QnA.Read.All"],
    pathPrefixes: ["/search"],
    audience: "platform-business",
  },
  {
    id: "external-connections",
    name: "External Connections",
    summary: "External connections, schemas, items, and content connectors.",
    icon: svglIcon("microsoft"),
    scopes: ["ExternalConnection.ReadWrite.OwnedBy", "ExternalItem.ReadWrite.OwnedBy"],
    pathPrefixes: ["/connections", "/external"],
    audience: "platform-business",
  },
  {
    id: "solutions",
    name: "Solutions and Employee Experience",
    summary: "Bookings, virtual events, backup, employee experience, and Copilot.",
    icon: svglIcon("microsoft"),
    scopes: [],
    pathPrefixes: ["/copilot", "/employeeExperience", "/solutions"],
    audience: "platform-business",
  },
  {
    id: "platform-services",
    name: "Platform Services",
    summary: "Places, print, storage, subscriptions, functions, filters, and extensions.",
    icon: svglIcon("microsoft"),
    scopes: ["Place.Read.All", "Printer.ReadWrite.All"],
    pathPrefixes: [
      "/filterOperators",
      "/functions",
      "/places",
      "/print",
      "/schemaExtensions",
      "/storage",
      "/subscriptions",
    ],
    audience: "platform-business",
  },
];

export const MICROSOFT_GRAPH_DEFAULT_PRESET_IDS: readonly string[] = [
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

export const MICROSOFT_GRAPH_ALL_PRESET_IDS: readonly string[] = microsoftGraphScopePresets.map(
  (preset) => preset.id,
);

const orderedUnique = (values: Iterable<string>): readonly string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
};

export const microsoftGraphPresetForId = (
  presetId: string,
): MicrosoftGraphScopePreset | undefined =>
  microsoftGraphScopePresets.find((preset) => preset.id === presetId);

export const microsoftGraphPresetIdsCoverFullGraph = (presetIds: Iterable<string>): boolean => {
  const selected = new Set([...presetIds]);
  return microsoftGraphScopePresets.every((preset) => selected.has(preset.id));
};

export const microsoftGraphScopesForPresetIds = (
  presetIds: Iterable<string>,
  customScopes: Iterable<string> = [],
): readonly string[] =>
  orderedUnique([
    ...MICROSOFT_GRAPH_BASE_SCOPES,
    ...[...presetIds].flatMap((presetId) => microsoftGraphPresetForId(presetId)?.scopes ?? []),
    ...customScopes,
  ]);

export const microsoftGraphExactPathsForPresetIds = (
  presetIds: Iterable<string>,
): readonly string[] =>
  orderedUnique(
    [...presetIds].flatMap((presetId) => microsoftGraphPresetForId(presetId)?.exactPaths ?? []),
  );

export const microsoftGraphPathPrefixesForPresetIds = (
  presetIds: Iterable<string>,
): readonly string[] =>
  orderedUnique(
    [...presetIds].flatMap((presetId) => microsoftGraphPresetForId(presetId)?.pathPrefixes ?? []),
  );

export const microsoftGraphTagPrefixesForPresetIds = (
  presetIds: Iterable<string>,
): readonly string[] =>
  orderedUnique(
    [...presetIds].flatMap((presetId) => microsoftGraphPresetForId(presetId)?.tagPrefixes ?? []),
  );
