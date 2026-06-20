export interface MicrosoftGraphPreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly icon?: string;
  readonly featured?: boolean;
}

export type MicrosoftGraphScopeAudience = "standard-user" | "admin";

export interface MicrosoftGraphScopePreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly icon?: string;
  readonly scopes: readonly string[];
  readonly exactPaths?: readonly string[];
  readonly pathPrefixes?: readonly string[];
  readonly featured?: boolean;
  readonly audience: MicrosoftGraphScopeAudience;
}

const MICROSOFT_ICON = "https://www.microsoft.com/favicon.ico";
const svglIcon = (name: string) => `https://svgl.app/library/${name}.svg`;

export const MICROSOFT_GRAPH_OPENAPI_URL =
  "https://raw.githubusercontent.com/microsoftgraph/msgraph-metadata/master/openapi/v1.0/openapi.yaml";
export const MICROSOFT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
export const MICROSOFT_AUTHORIZATION_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
export const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
export const MICROSOFT_AUTH_TEMPLATE_SLUG = "azureAdDelegated";
export const MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG = "azureAdClientCredentials";
export const MICROSOFT_GRAPH_CLIENT_CREDENTIALS_SCOPES: readonly string[] = [
  "https://graph.microsoft.com/.default",
];

export const MICROSOFT_GRAPH_PRESET_ID = "microsoft";

export const microsoftGraphPreset: MicrosoftGraphPreset = {
  id: MICROSOFT_GRAPH_PRESET_ID,
  name: "Microsoft Graph",
  summary: "Bundle Microsoft 365 workloads into one Graph source and one OAuth consent.",
  icon: MICROSOFT_ICON,
  featured: true,
};

export const MICROSOFT_GRAPH_BASE_SCOPES: readonly string[] = ["offline_access"];

export const microsoftGraphScopePresets: readonly MicrosoftGraphScopePreset[] = [
  {
    id: "profile",
    name: "Profile",
    summary: "Signed-in user profile and photo.",
    icon: svglIcon("microsoft"),
    scopes: ["User.Read"],
    exactPaths: ["/me", "/me/photo", "/me/photo/$value"],
    featured: true,
    audience: "standard-user",
  },
  {
    id: "mail",
    name: "Outlook Mail",
    summary: "Messages, folders, attachments, and send mail.",
    icon: svglIcon("microsoft-outlook"),
    scopes: ["Mail.ReadWrite", "Mail.Send"],
    pathPrefixes: [
      "/me/messages",
      "/me/mailFolders",
      "/me/sendMail",
      "/users/{user-id}/messages",
      "/users/{user-id}/mailFolders",
      "/users/{user-id}/sendMail",
    ],
    featured: true,
    audience: "standard-user",
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
      "/me/events",
      "/users/{user-id}/calendar",
      "/users/{user-id}/calendars",
      "/users/{user-id}/calendarGroups",
      "/users/{user-id}/events",
    ],
    featured: true,
    audience: "standard-user",
  },
  {
    id: "files",
    name: "OneDrive Files",
    summary: "Drives, files, folders, sharing links, and permissions.",
    icon: svglIcon("microsoft-onedrive"),
    scopes: ["Files.ReadWrite.All"],
    pathPrefixes: ["/me/drive", "/users/{user-id}/drive", "/drives", "/shares"],
    featured: true,
    audience: "standard-user",
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
      "/drives/{drive-id}/items/{driveItem-id}/workbook",
    ],
    audience: "standard-user",
  },
  {
    id: "contacts",
    name: "Outlook Contacts",
    summary: "Contacts and contact folders.",
    icon: svglIcon("microsoft-outlook"),
    scopes: ["Contacts.ReadWrite"],
    pathPrefixes: [
      "/me/contacts",
      "/me/contactFolders",
      "/users/{user-id}/contacts",
      "/users/{user-id}/contactFolders",
    ],
    audience: "standard-user",
  },
  {
    id: "tasks",
    name: "To Do Tasks",
    summary: "Task lists, tasks, and checklist items.",
    icon: svglIcon("microsoft-todo"),
    scopes: ["Tasks.ReadWrite"],
    pathPrefixes: ["/me/todo", "/users/{user-id}/todo"],
    audience: "standard-user",
  },
  {
    id: "teams-chat",
    name: "Teams Chats",
    summary: "Chats, chat messages, installed apps, and members.",
    icon: svglIcon("microsoft-teams"),
    scopes: ["Chat.ReadWrite"],
    pathPrefixes: ["/me/chats", "/chats"],
    audience: "standard-user",
  },
  {
    id: "sites",
    name: "SharePoint Sites",
    summary: "Sites, lists, pages, and columns.",
    icon: svglIcon("microsoft-sharepoint"),
    scopes: ["Sites.ReadWrite.All"],
    pathPrefixes: ["/sites"],
    audience: "admin",
  },
  {
    id: "users",
    name: "Directory Users",
    summary: "Users, managers, app role assignments, and directory metadata.",
    icon: svglIcon("microsoft"),
    scopes: ["User.ReadWrite.All", "Directory.Read.All"],
    pathPrefixes: ["/users"],
    audience: "admin",
  },
];

export const MICROSOFT_GRAPH_DEFAULT_PRESET_IDS: readonly string[] = [
  "profile",
  "mail",
  "calendar",
  "files",
];

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
