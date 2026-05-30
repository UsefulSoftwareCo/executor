import type { OpenApiPreset } from "./presets";

export type GoogleOpenApiOAuthAudience =
  | "standard-user"
  | "advanced-user"
  | "workspace-admin"
  | "unsupported-user";

export type GoogleOpenApiPreset = OpenApiPreset & {
  readonly oauthAudience: GoogleOpenApiOAuthAudience;
};

const gd = (service: string, version: string) =>
  `https://www.googleapis.com/discovery/v1/apis/${service}/${version}/rest`;

const GOOGLE_G = "https://fonts.gstatic.com/s/i/productlogos/googleg/v6/192px.svg";
export const GOOGLE_BUNDLE_PRESET_ID = "google";

export const googleOpenApiBundlePreset: OpenApiPreset = {
  id: GOOGLE_BUNDLE_PRESET_ID,
  name: "Google",
  summary: "Bundle Gmail, Calendar, Drive, Docs, and other Google APIs into one source.",
  icon: GOOGLE_G,
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
