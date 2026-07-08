import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { compileOpenApiSpec } from "@executor-js/plugin-openapi";

import { convertGoogleDiscoveryBundleToOpenApi } from "./discovery";
import { googleCatalog, googleOpenApiPresets, googleStandardUserOAuthPresets } from "./presets";

const googleHealthCheckDiscoveryFixtures = {
  "google-calendar": {
    url: "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
    document: {
      name: "calendar",
      version: "v3",
      title: "Calendar API",
      rootUrl: "https://www.googleapis.com/",
      servicePath: "calendar/v3/",
      resources: {
        calendarList: {
          methods: {
            list: {
              id: "calendar.calendarList.list",
              path: "users/me/calendarList",
              httpMethod: "GET",
              response: { $ref: "CalendarList" },
            },
          },
        },
      },
      schemas: {
        CalendarList: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: { $ref: "CalendarListEntry" },
            },
          },
        },
        CalendarListEntry: {
          type: "object",
          properties: {
            id: { type: "string" },
            summary: { type: "string" },
          },
        },
      },
    },
  },
  "google-gmail": {
    url: "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest",
    document: {
      name: "gmail",
      version: "v1",
      title: "Gmail API",
      rootUrl: "https://gmail.googleapis.com/",
      servicePath: "",
      resources: {
        users: {
          methods: {
            labelsList: {
              id: "gmail.users.labels.list",
              path: "gmail/v1/users/{userId}/labels",
              httpMethod: "GET",
              parameters: {
                userId: {
                  type: "string",
                  location: "path",
                  required: true,
                },
              },
              response: { $ref: "ListLabelsResponse" },
            },
          },
        },
      },
      schemas: {
        ListLabelsResponse: {
          type: "object",
          properties: {
            labels: {
              type: "array",
              items: { $ref: "Label" },
            },
          },
        },
        Label: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
          },
        },
      },
    },
  },
  "google-drive": {
    url: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
    document: {
      name: "drive",
      version: "v3",
      title: "Google Drive API",
      rootUrl: "https://www.googleapis.com/",
      servicePath: "drive/v3/",
      resources: {
        about: {
          methods: {
            get: {
              id: "drive.about.get",
              path: "about",
              httpMethod: "GET",
              response: { $ref: "About" },
            },
          },
        },
      },
      schemas: {
        About: {
          type: "object",
          properties: {
            user: { $ref: "User" },
          },
        },
        User: {
          type: "object",
          properties: {
            emailAddress: { type: "string" },
            displayName: { type: "string" },
          },
        },
      },
    },
  },
  "google-tasks": {
    url: "https://www.googleapis.com/discovery/v1/apis/tasks/v1/rest",
    document: {
      name: "tasks",
      version: "v1",
      title: "Google Tasks API",
      rootUrl: "https://tasks.googleapis.com/",
      servicePath: "",
      resources: {
        tasklists: {
          methods: {
            list: {
              id: "tasks.tasklists.list",
              path: "tasks/v1/users/@me/lists",
              httpMethod: "GET",
              response: { $ref: "TaskLists" },
            },
          },
        },
      },
      schemas: {
        TaskLists: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: { $ref: "TaskList" },
            },
          },
        },
        TaskList: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
          },
        },
      },
    },
  },
} as const;

const FROZEN_GOOGLE_SLUGS = [
  "google_calendar",
  "google_gmail",
  "google_sheets",
  "google_drive",
  "google_docs",
  "google_slides",
  "google_forms",
  "google_tasks",
  "google_people",
  "google_photos_library",
  "google_photos_picker",
  "google_chat",
  "google_keep",
  "google_youtube_data",
  "google_search_console",
  "google_classroom",
  "google_admin_directory",
  "google_admin_reports",
  "google_apps_script",
  "google_bigquery",
  "google_cloud_resource_manager",
] as const;

it("keeps Select all limited to Google services that can use normal user OAuth", () => {
  const standardIds = new Set(googleStandardUserOAuthPresets.map((preset) => preset.id));

  expect(standardIds).toContain("google-calendar");
  expect(standardIds).toContain("google-gmail");
  expect(standardIds).toContain("google-tasks");
  expect(standardIds).toContain("google-people");
  expect(standardIds).toContain("google-search-console");

  expect(standardIds).not.toContain("google-youtube-data");
  expect(standardIds).not.toContain("google-cloud-resource-manager");
  expect(standardIds).not.toContain("google-chat");
  expect(standardIds).not.toContain("google-keep");
  expect(standardIds).not.toContain("google-admin-directory");
  expect(standardIds).not.toContain("google-admin-reports");
});

it("classifies every Google service for bundle OAuth UX", () => {
  expect(
    googleOpenApiPresets.map((preset) => ({
      id: preset.id,
      oauthAudience: preset.oauthAudience,
    })),
  ).toMatchSnapshot();
});

it("exports one catalog row per Google service with stable slugs and per-service OAuth", () => {
  expect(googleCatalog.map((preset) => preset.defaultSlug)).toEqual([...FROZEN_GOOGLE_SLUGS]);
  for (const preset of googleCatalog) {
    expect(preset.family).toBe("google");
    expect(preset.specFormat).toBe("google-discovery");
    expect(preset.defaultSlug).toBeTruthy();
    expect(preset.authTemplate).toHaveLength(1);
    const oauthTemplates = (preset.authTemplate ?? []).filter(
      (template) => template.kind === "oauth2",
    );
    expect(oauthTemplates).toHaveLength(1);
    expect(oauthTemplates[0]?.scopes).toEqual(
      expect.arrayContaining(["openid", "email", "profile"]),
    );
  }
});

it.effect("resolves fixture-backed Google catalog health checks in converted specs", () =>
  Effect.gen(function* () {
    for (const [presetId, fixture] of Object.entries(googleHealthCheckDiscoveryFixtures)) {
      const preset = googleCatalog.find((candidate) => candidate.id === presetId);
      expect(preset, `${presetId} catalog row exists`).toBeTruthy();
      expect(preset?.healthCheck, `${presetId} declares a health check`).toBeTruthy();

      const converted = yield* convertGoogleDiscoveryBundleToOpenApi({
        documents: [{ discoveryUrl: fixture.url, documentText: JSON.stringify(fixture.document) }],
      });
      const compiled = yield* compileOpenApiSpec(converted.specText);
      expect(compiled.definitions.map((definition) => definition.toolPath)).toContain(
        preset!.healthCheck!.operation,
      );
    }
  }),
);

it("omits Google health checks when the service spec has no stable cheap read", () => {
  const omitted = [
    "google-sheets",
    "google-docs",
    "google-slides",
    "google-forms",
    "google-photos-picker",
    "google-admin-reports",
  ];

  for (const presetId of omitted) {
    const preset = googleCatalog.find((candidate) => candidate.id === presetId);
    expect(preset?.healthCheck, `${presetId} should not declare a health check`).toBeUndefined();
  }
});
