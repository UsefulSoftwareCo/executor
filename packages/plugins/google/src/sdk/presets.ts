import { normalizeGoogleDiscoveryUrl } from "./discovery";

export interface GooglePreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly url?: string;
  readonly icon?: string;
  readonly featured?: boolean;
}

export type GoogleOpenApiOAuthAudience =
  | "standard-user"
  | "advanced-user"
  | "workspace-admin"
  | "unsupported-user";

export type GoogleOpenApiPreset = GooglePreset & {
  readonly oauthAudience: GoogleOpenApiOAuthAudience;
};

const gd = (service: string, version: string) =>
  `https://www.googleapis.com/discovery/v1/apis/${service}/${version}/rest`;

const GOOGLE_G = "https://fonts.gstatic.com/s/i/productlogos/googleg/v6/192px.svg";
export const GOOGLE_BUNDLE_PRESET_ID = "google";
export const GOOGLE_PHOTOS_PRESET_ID = "google-photos";
export const GOOGLE_PHOTOS_ICON =
  "https://www.gstatic.com/images/branding/product/2x/photos_96dp.png";

export const googleOpenApiBundlePreset: GooglePreset = {
  id: GOOGLE_BUNDLE_PRESET_ID,
  name: "Google",
  summary: "Bundle Gmail, Calendar, Drive, Docs, and other Google APIs into one source.",
  icon: GOOGLE_G,
  featured: true,
};

export const googlePhotosOpenApiBundlePreset: GooglePreset = {
  id: GOOGLE_PHOTOS_PRESET_ID,
  name: "Google Photos",
  summary: "Albums, uploads, app-created media, and user-selected picker media.",
  icon: GOOGLE_PHOTOS_ICON,
  featured: true,
};

export const googleOpenApiPresets: readonly GoogleOpenApiPreset[] = [
  {
    id: "google-calendar",
    name: "Google Calendar",
    summary: "Calendars, events, ACLs, and scheduling.",
    url: gd("calendar", "v3"),
    icon: "https://fonts.gstatic.com/s/i/productlogos/calendar_2020q4/v8/192px.svg",
    featured: true,
    oauthAudience: "standard-user",
  },
  {
    id: "google-gmail",
    name: "Gmail",
    summary: "Messages, threads, labels, and drafts.",
    url: gd("gmail", "v1"),
    icon: "https://fonts.gstatic.com/s/i/productlogos/gmail_2020q4/v8/web-96dp/logo_gmail_2020q4_color_2x_web_96dp.png",
    featured: true,
    oauthAudience: "standard-user",
  },
  {
    id: "google-sheets",
    name: "Google Sheets",
    summary: "Spreadsheets, values, ranges, and formatting.",
    url: gd("sheets", "v4"),
    icon: "https://fonts.gstatic.com/s/i/productlogos/sheets_2020q4/v8/192px.svg",
    featured: true,
    oauthAudience: "standard-user",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    summary: "Files, folders, permissions, and shared drives.",
    url: gd("drive", "v3"),
    icon: "https://fonts.gstatic.com/s/i/productlogos/drive_2020q4/v8/192px.svg",
    featured: true,
    oauthAudience: "standard-user",
  },
  {
    id: "google-docs",
    name: "Google Docs",
    summary: "Documents, structural edits, and formatting.",
    url: gd("docs", "v1"),
    icon: "https://fonts.gstatic.com/s/i/productlogos/docs_2020q4/v12/192px.svg",
    featured: true,
    oauthAudience: "standard-user",
  },
  {
    id: "google-slides",
    name: "Google Slides",
    summary: "Presentations, slides, page elements, and deck updates.",
    url: gd("slides", "v1"),
    icon: "https://fonts.gstatic.com/s/i/productlogos/slides_2020q4/v12/192px.svg",
    oauthAudience: "standard-user",
  },
  {
    id: "google-forms",
    name: "Google Forms",
    summary: "Forms, questions, responses, and quizzes.",
    url: "https://forms.googleapis.com/$discovery/rest?version=v1",
    icon: "https://fonts.gstatic.com/s/i/productlogos/forms_2020q4/v6/192px.svg",
    oauthAudience: "standard-user",
  },
  {
    id: "google-tasks",
    name: "Google Tasks",
    summary: "Task lists, task items, notes, and due dates.",
    url: gd("tasks", "v1"),
    icon: "https://fonts.gstatic.com/s/i/productlogos/tasks/v5/192px.svg",
    oauthAudience: "standard-user",
  },
  {
    id: "google-people",
    name: "Google People",
    summary: "Contacts, profiles, directory people, and contact groups.",
    url: gd("people", "v1"),
    icon: "https://fonts.gstatic.com/s/i/productlogos/contacts_2022/v2/192px.svg",
    oauthAudience: "standard-user",
  },
  {
    id: "google-photos-library",
    name: "Google Photos Library",
    summary: "Albums, uploads, and app-created media through Google Photos.",
    url: gd("photoslibrary", "v1"),
    icon: GOOGLE_PHOTOS_ICON,
    oauthAudience: "advanced-user",
  },
  {
    id: "google-photos-picker",
    name: "Google Photos Picker",
    summary: "Picker sessions and user-selected Google Photos media items.",
    url: "https://photospicker.googleapis.com/$discovery/rest?version=v1",
    icon: GOOGLE_PHOTOS_ICON,
    oauthAudience: "advanced-user",
  },
  {
    id: "google-chat",
    name: "Google Chat",
    summary: "Spaces, messages, members, reactions, and chat workflows.",
    url: gd("chat", "v1"),
    icon: "https://fonts.gstatic.com/s/i/productlogos/chat_2020q4/v8/192px.svg",
    oauthAudience: "workspace-admin",
  },
  {
    id: "google-keep",
    name: "Google Keep",
    summary: "Notes, lists, attachments, and annotations.",
    url: "https://keep.googleapis.com/$discovery/rest?version=v1",
    icon: "https://fonts.gstatic.com/s/i/productlogos/keep_2020q4/v8/192px.svg",
    oauthAudience: "unsupported-user",
  },
  {
    id: "google-youtube-data",
    name: "YouTube Data",
    summary: "Channels, playlists, videos, comments, and uploads.",
    url: gd("youtube", "v3"),
    icon: "https://fonts.gstatic.com/s/i/productlogos/youtube/v9/192px.svg",
    oauthAudience: "advanced-user",
  },
  {
    id: "google-search-console",
    name: "Google Search Console",
    summary: "Sites, sitemaps, URL inspection, and search performance.",
    url: gd("searchconsole", "v1"),
    icon: GOOGLE_G,
    oauthAudience: "standard-user",
  },
  {
    id: "google-classroom",
    name: "Google Classroom",
    summary: "Courses, rosters, coursework, and grading.",
    url: gd("classroom", "v1"),
    icon: "https://fonts.gstatic.com/s/i/productlogos/classroom/v7/192px.svg",
    oauthAudience: "advanced-user",
  },
  {
    id: "google-admin-directory",
    name: "Google Admin Directory",
    summary: "Users, groups, org units, roles, and domain resources.",
    url: "https://admin.googleapis.com/$discovery/rest?version=directory_v1",
    icon: "https://fonts.gstatic.com/s/i/productlogos/admin_2020q4/v6/192px.svg",
    oauthAudience: "workspace-admin",
  },
  {
    id: "google-admin-reports",
    name: "Google Admin Reports",
    summary: "Audit events, usage reports, and admin activity logs.",
    url: "https://admin.googleapis.com/$discovery/rest?version=reports_v1",
    icon: "https://fonts.gstatic.com/s/i/productlogos/admin_2020q4/v6/192px.svg",
    oauthAudience: "workspace-admin",
  },
  {
    id: "google-apps-script",
    name: "Google Apps Script",
    summary: "Projects, deployments, and script execution.",
    url: gd("script", "v1"),
    icon: "https://fonts.gstatic.com/s/i/productlogos/apps_script/v10/192px.svg",
    oauthAudience: "advanced-user",
  },
  {
    id: "google-bigquery",
    name: "Google BigQuery",
    summary: "Datasets, tables, jobs, and analytical queries.",
    url: gd("bigquery", "v2"),
    icon: "https://fonts.gstatic.com/s/i/productlogos/google_cloud/v6/192px.svg",
    oauthAudience: "advanced-user",
  },
  {
    id: "google-cloud-resource-manager",
    name: "Google Cloud Resource Manager",
    summary: "Projects, folders, organizations, and IAM hierarchy.",
    url: "https://cloudresourcemanager.googleapis.com/$discovery/rest?version=v3",
    icon: "https://fonts.gstatic.com/s/i/productlogos/google_cloud/v6/192px.svg",
    oauthAudience: "advanced-user",
  },
];

export const googleStandardUserOAuthPresets = googleOpenApiPresets.filter(
  (preset) => preset.oauthAudience === "standard-user",
);

export const googlePhotosPresetIds: readonly string[] = [
  "google-photos-library",
  "google-photos-picker",
];

export const googlePhotosOpenApiPresets: readonly GoogleOpenApiPreset[] =
  googleOpenApiPresets.filter((preset) => googlePhotosPresetIds.includes(preset.id));

// ---------------------------------------------------------------------------
// Representative consent scopes per preset.
//
// The picker shows the OAuth consent a user is about to grant BEFORE connecting
// (the "View scopes" panel), but the authoritative scope list only exists in
// each API's live Discovery document, which the add flow fetches lazily at
// `addBundle` time. To preview consent without N network round-trips, each preset
// declares the broad top-level scope(s) a full integration grants. These flow
// through `googleOAuthConsentBatches` (which compacts sub-scopes under their
// broad parent), so the previewed grant matches the unioned scopes the bundle
// converter ultimately stores. Grounded against each API's published Discovery
// `auth.oauth2.scopes`.
// ---------------------------------------------------------------------------

export const googleOAuthConsentScopes: Readonly<Record<string, readonly string[]>> = {
  "google-calendar": ["https://www.googleapis.com/auth/calendar"],
  "google-gmail": ["https://mail.google.com/"],
  "google-sheets": ["https://www.googleapis.com/auth/spreadsheets"],
  "google-drive": ["https://www.googleapis.com/auth/drive"],
  "google-docs": ["https://www.googleapis.com/auth/documents"],
  "google-slides": ["https://www.googleapis.com/auth/presentations"],
  "google-forms": ["https://www.googleapis.com/auth/forms.body"],
  "google-tasks": ["https://www.googleapis.com/auth/tasks"],
  "google-people": ["https://www.googleapis.com/auth/contacts"],
  "google-photos-library": [
    "https://www.googleapis.com/auth/photoslibrary.appendonly",
    "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata",
  ],
  "google-photos-picker": ["https://www.googleapis.com/auth/photospicker.mediaitems.readonly"],
  "google-chat": ["https://www.googleapis.com/auth/chat.spaces"],
  "google-keep": ["https://www.googleapis.com/auth/keep"],
  "google-youtube-data": ["https://www.googleapis.com/auth/youtube"],
  "google-search-console": ["https://www.googleapis.com/auth/webmasters"],
  "google-classroom": ["https://www.googleapis.com/auth/classroom.courses"],
  "google-admin-directory": ["https://www.googleapis.com/auth/admin.directory.user"],
  "google-admin-reports": ["https://www.googleapis.com/auth/admin.reports.audit.readonly"],
  "google-apps-script": ["https://www.googleapis.com/auth/script.projects"],
  "google-bigquery": ["https://www.googleapis.com/auth/bigquery"],
  "google-cloud-resource-manager": ["https://www.googleapis.com/auth/cloud-platform"],
};

export const googleOAuthConsentScopesForPreset = (presetId: string): readonly string[] =>
  googleOAuthConsentScopes[presetId] ?? [];

// ---------------------------------------------------------------------------
// Resolve a stored/normalized Discovery URL back to its preset, so a bundled
// `google` integration can surface each selected API's `oauthAudience` (e.g. a
// caution on a connection's auth method when admin-only or unsupported-consent
// APIs are part of the bundle).
// ---------------------------------------------------------------------------

const normalizeGooglePresetUrl = (url: string): string => {
  const discoveryUrl = normalizeGoogleDiscoveryUrl(url);
  if (discoveryUrl) return discoveryUrl;
  const trimmed = url.trim();
  if (!URL.canParse(trimmed)) return trimmed.replace(/\/$/, "");
  const parsed = new URL(trimmed);
  parsed.hash = "";
  parsed.searchParams.sort();
  return parsed.toString().replace(/\/$/, "");
};

const googlePresetsByNormalizedUrl: ReadonlyMap<string, GoogleOpenApiPreset> = new Map(
  googleOpenApiPresets.flatMap((preset) =>
    preset.url ? [[normalizeGooglePresetUrl(preset.url), preset] as const] : [],
  ),
);

export const googlePresetForDiscoveryUrl = (url: string): GoogleOpenApiPreset | undefined =>
  googlePresetsByNormalizedUrl.get(normalizeGooglePresetUrl(url));

/** The distinct caution-tier audiences (`workspace-admin`, `unsupported-user`)
 *  among the supplied Discovery URLs - the ones whose consent the user should be
 *  warned about. Returns `[]` when every URL is a standard/advanced API. */
export const googleAudienceWarningsForUrls = (
  urls: readonly string[],
): readonly GoogleOpenApiOAuthAudience[] => {
  const seen = new Set<GoogleOpenApiOAuthAudience>();
  for (const url of urls) {
    const audience = googlePresetForDiscoveryUrl(url)?.oauthAudience;
    if (audience === "workspace-admin" || audience === "unsupported-user") seen.add(audience);
  }
  return [...seen];
};
