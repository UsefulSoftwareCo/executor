// ---------------------------------------------------------------------------
// Google per-service add flow, "customize your Google connection".
//
// The product picker emits preset ids and custom Discovery URLs. The server
// fans them out into separate integrations, deriving custom identity from the
// fetched Discovery document before it compiles the OpenAPI surface.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  ConnectionName,
  IntegrationSlug,
  createExecutor,
  AuthTemplateSlug,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { defaultGoogleHealthCheck, googlePlugin } from "./plugin";

// --- Canned Discovery documents -------------------------------------------
// Each carries one method. Calendar and Gmail BOTH expose a generic `list`
// method id segment, so a naive merge that keyed tools on the trailing method
// name would collide. The bundle converter keys on the full method id
// (`calendar.events.list`, `gmail.users.messages.list`, …), so they don't.

const CALENDAR_URL = "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest";
const GMAIL_URL = "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest";
const SHEETS_URL = "https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest";
const DRIVE_URL = "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest";
const DOCS_URL = "https://www.googleapis.com/discovery/v1/apis/docs/v1/rest";
const TASKS_URL = "https://www.googleapis.com/discovery/v1/apis/tasks/v1/rest";
const PHOTOS_LIBRARY_URL = "https://www.googleapis.com/discovery/v1/apis/photoslibrary/v1/rest";
const PHOTOS_PICKER_URL = "https://photospicker.googleapis.com/$discovery/rest?version=v1";
const PEOPLE_URL = "https://www.googleapis.com/discovery/v1/apis/people/v1/rest";
const OAUTH2_URL = "https://www.googleapis.com/discovery/v1/apis/oauth2/v2/rest";
const OAUTH2_USERINFO_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
] as const;

const calendarDoc = {
  name: "calendar",
  version: "v3",
  title: "Calendar API",
  rootUrl: "https://www.googleapis.com/",
  servicePath: "calendar/v3/",
  auth: {
    oauth2: {
      scopes: {
        "https://www.googleapis.com/auth/calendar": { description: "Manage calendars" },
        "https://www.googleapis.com/auth/calendar.readonly": { description: "Read calendars" },
      },
    },
  },
  resources: {
    events: {
      methods: {
        list: {
          id: "calendar.events.list",
          httpMethod: "GET",
          path: "calendars/{calendarId}/events",
          scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
          parameters: {
            calendarId: { location: "path", required: true, type: "string" },
          },
        },
      },
    },
  },
  schemas: {
    Event: { id: "Event", type: "object", properties: { id: { type: "string" } } },
  },
};

const gmailDoc = {
  name: "gmail",
  version: "v1",
  title: "Gmail API",
  rootUrl: "https://gmail.googleapis.com/",
  servicePath: "",
  auth: {
    oauth2: {
      scopes: {
        "https://mail.google.com/": { description: "Full Gmail access" },
        "https://www.googleapis.com/auth/gmail.readonly": { description: "Read Gmail" },
      },
    },
  },
  resources: {
    users: {
      resources: {
        messages: {
          methods: {
            // Same trailing `list` as calendar.events.list - would collide on a
            // naive merge; service-prefixed method id keeps them distinct.
            list: {
              id: "gmail.users.messages.list",
              httpMethod: "GET",
              path: "gmail/v1/users/{userId}/messages",
              scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
              parameters: {
                userId: { location: "path", required: true, type: "string" },
              },
            },
          },
        },
      },
    },
  },
  schemas: {
    Message: { id: "Message", type: "object", properties: { id: { type: "string" } } },
  },
};

const driveDoc = {
  name: "drive",
  version: "v3",
  title: "Drive API",
  rootUrl: "https://www.googleapis.com/",
  servicePath: "drive/v3/",
  auth: {
    oauth2: {
      scopes: {
        "https://www.googleapis.com/auth/drive": { description: "Manage Drive" },
      },
    },
  },
  resources: {
    files: {
      methods: {
        // A third `list` - three generic method names across three APIs.
        list: {
          id: "drive.files.list",
          httpMethod: "GET",
          path: "files",
          scopes: ["https://www.googleapis.com/auth/drive"],
          parameters: {},
        },
      },
    },
  },
  schemas: {
    File: { id: "File", type: "object", properties: { id: { type: "string" } } },
  },
};

const sheetsDoc = {
  name: "sheets",
  version: "v4",
  title: "Google Sheets API",
  rootUrl: "https://sheets.googleapis.com/",
  servicePath: "v4/",
  auth: {
    oauth2: {
      scopes: {
        "https://www.googleapis.com/auth/spreadsheets": { description: "Manage spreadsheets" },
      },
    },
  },
  resources: {
    spreadsheets: {
      methods: {
        get: {
          id: "sheets.spreadsheets.get",
          httpMethod: "GET",
          path: "spreadsheets/{spreadsheetId}",
          scopes: ["https://www.googleapis.com/auth/spreadsheets"],
          parameters: {
            spreadsheetId: { location: "path", required: true, type: "string" },
          },
        },
      },
    },
  },
  schemas: {
    Spreadsheet: { id: "Spreadsheet", type: "object", properties: { id: { type: "string" } } },
  },
};

const docsDoc = {
  name: "docs",
  version: "v1",
  title: "Google Docs API",
  rootUrl: "https://docs.googleapis.com/",
  servicePath: "v1/",
  auth: {
    oauth2: {
      scopes: {
        "https://www.googleapis.com/auth/documents": { description: "Manage documents" },
      },
    },
  },
  resources: {
    documents: {
      methods: {
        get: {
          id: "docs.documents.get",
          httpMethod: "GET",
          path: "documents/{documentId}",
          scopes: ["https://www.googleapis.com/auth/documents"],
          parameters: {
            documentId: { location: "path", required: true, type: "string" },
          },
        },
      },
    },
  },
  schemas: {
    Document: { id: "Document", type: "object", properties: { documentId: { type: "string" } } },
  },
};

const tasksDoc = {
  name: "tasks",
  version: "v1",
  title: "Tasks API",
  description: "Manage your tasks and task lists.",
  rootUrl: "https://tasks.googleapis.com/",
  servicePath: "tasks/v1/",
  auth: {
    oauth2: {
      scopes: {
        "https://www.googleapis.com/auth/tasks": { description: "Manage tasks" },
      },
    },
  },
  resources: {
    tasks: {
      methods: {
        list: {
          id: "tasks.tasks.list",
          httpMethod: "GET",
          path: "lists/{tasklist}/tasks",
          scopes: ["https://www.googleapis.com/auth/tasks"],
          parameters: {
            tasklist: { location: "path", required: true, type: "string" },
          },
        },
      },
    },
  },
  schemas: {
    Task: { id: "Task", type: "object", properties: { id: { type: "string" } } },
  },
};

const photosLibraryDoc = {
  name: "photoslibrary",
  version: "v1",
  title: "Google Photos Library API",
  rootUrl: "https://photoslibrary.googleapis.com/",
  servicePath: "v1/",
  auth: {
    oauth2: {
      scopes: {
        "https://www.googleapis.com/auth/photoslibrary": {
          description: "Manage the full Google Photos library",
        },
        "https://www.googleapis.com/auth/photoslibrary.appendonly": {
          description: "Upload to Google Photos",
        },
        "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata": {
          description: "Read app-created Google Photos media",
        },
      },
    },
  },
  resources: {
    albums: {
      methods: {
        list: {
          id: "photoslibrary.albums.list",
          httpMethod: "GET",
          path: "albums",
          scopes: ["https://www.googleapis.com/auth/photoslibrary"],
          parameters: {},
        },
      },
    },
    mediaItems: {
      methods: {
        search: {
          id: "photoslibrary.mediaItems.search",
          httpMethod: "POST",
          path: "mediaItems:search",
          scopes: ["https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata"],
          parameters: {},
        },
      },
    },
  },
  schemas: {},
};

const photosPickerDoc = {
  name: "photospicker",
  version: "v1",
  title: "Google Photos Picker API",
  rootUrl: "https://photospicker.googleapis.com/",
  servicePath: "v1/",
  resources: {
    mediaItems: {
      methods: {
        list: {
          id: "photospicker.mediaItems.list",
          httpMethod: "GET",
          path: "mediaItems",
          parameters: {},
        },
      },
    },
  },
  schemas: {},
};

const peopleDoc = {
  name: "people",
  version: "v1",
  title: "People API",
  rootUrl: "https://people.googleapis.com/",
  servicePath: "",
  auth: {
    oauth2: {
      scopes: {
        "https://www.googleapis.com/auth/userinfo.email": { description: "See your email" },
      },
    },
  },
  resources: {
    people: {
      methods: {
        get: {
          id: "people.people.get",
          httpMethod: "GET",
          path: "v1/{+resourceName}",
          scopes: ["https://www.googleapis.com/auth/userinfo.email"],
          parameters: {
            resourceName: { location: "path", required: true, type: "string" },
            personFields: { location: "query", type: "string" },
          },
          response: { $ref: "Person" },
        },
      },
    },
  },
  schemas: {
    Person: {
      id: "Person",
      type: "object",
      properties: {
        resourceName: { type: "string" },
        emailAddresses: { type: "array", items: { $ref: "EmailAddress" } },
      },
    },
    EmailAddress: { id: "EmailAddress", type: "object", properties: { value: { type: "string" } } },
  },
};

const oauth2Doc = {
  name: "oauth2",
  version: "v2",
  title: "Google OAuth2 API",
  rootUrl: "https://www.googleapis.com/",
  servicePath: "",
  auth: {
    oauth2: {
      scopes: {
        openid: { description: "Associate you with your personal info on Google" },
        "https://www.googleapis.com/auth/userinfo.email": {
          description: "See your primary Google Account email address",
        },
        "https://www.googleapis.com/auth/userinfo.profile": {
          description: "See your personal info",
        },
      },
    },
  },
  methods: {
    tokeninfo: {
      id: "oauth2.tokeninfo",
      httpMethod: "POST",
      path: "oauth2/v2/tokeninfo",
      response: { $ref: "Tokeninfo" },
    },
  },
  resources: {
    userinfo: {
      methods: {
        get: {
          id: "oauth2.userinfo.get",
          httpMethod: "GET",
          path: "oauth2/v2/userinfo",
          scopes: OAUTH2_USERINFO_SCOPES,
          response: { $ref: "Userinfo" },
        },
      },
      resources: {
        v2: {
          resources: {
            me: {
              methods: {
                get: {
                  id: "oauth2.userinfo.v2.me.get",
                  httpMethod: "GET",
                  path: "userinfo/v2/me",
                  scopes: OAUTH2_USERINFO_SCOPES,
                  response: { $ref: "Userinfo" },
                },
              },
            },
          },
        },
      },
    },
  },
  schemas: {
    Tokeninfo: {
      id: "Tokeninfo",
      type: "object",
      properties: {
        audience: { type: "string" },
        scope: { type: "string" },
      },
    },
    Userinfo: {
      id: "Userinfo",
      type: "object",
      properties: {
        email: { type: "string" },
        family_name: { type: "string" },
        gender: { type: "string" },
        given_name: { type: "string" },
        hd: { type: "string" },
        id: { type: "string" },
        link: { type: "string" },
        locale: { type: "string" },
        name: { type: "string" },
        picture: { type: "string" },
        verified_email: { type: "boolean" },
      },
    },
  },
};

const toJson = (value: unknown): string => JSON.stringify(value);

const DISCOVERY_BODIES: Readonly<Record<string, string>> = {
  [CALENDAR_URL]: toJson(calendarDoc),
  [GMAIL_URL]: toJson(gmailDoc),
  [SHEETS_URL]: toJson(sheetsDoc),
  [DRIVE_URL]: toJson(driveDoc),
  [DOCS_URL]: toJson(docsDoc),
  [TASKS_URL]: toJson(tasksDoc),
  [PHOTOS_LIBRARY_URL]: toJson(photosLibraryDoc),
  [PHOTOS_PICKER_URL]: toJson(photosPickerDoc),
  [PEOPLE_URL]: toJson(peopleDoc),
  [OAUTH2_URL]: toJson(oauth2Doc),
};

interface DiscoveryHttpClientOptions {
  readonly failedUrls?: ReadonlySet<string>;
  readonly beforeResponse?: (url: string) => Effect.Effect<void, never, never>;
}

const waitOneTurn: Effect.Effect<void, never, never> = Effect.promise(() => Promise.resolve()).pipe(
  Effect.orDie,
);

// A stub HTTP client that serves the canned Discovery document for whichever
// URL the bundle converter fetches. Service-hosted Discovery URLs carry their
// version in the query string, so match the full URL before falling back to the
// path-only key used by central Discovery URLs.
const makeDiscoveryHttpClientLayer = (options: DiscoveryHttpClientOptions = {}) =>
  Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
      const url = new URL(request.url);
      const key = `${url.origin}${url.pathname}`;
      const body = DISCOVERY_BODIES[url.toString()] ?? DISCOVERY_BODIES[key];
      const discoveryUrl = DISCOVERY_BODIES[url.toString()] !== undefined ? url.toString() : key;
      const failed =
        options.failedUrls?.has(url.toString()) === true || options.failedUrls?.has(key) === true;
      const response = HttpClientResponse.fromWeb(
        request,
        failed
          ? new Response("forced failure", { status: 503 })
          : body === undefined
            ? new Response("not found", { status: 404 })
            : new Response(body, {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
      );
      return (options.beforeResponse?.(discoveryUrl) ?? Effect.void).pipe(Effect.as(response));
    }),
  );

const discoveryHttpClientLayer = makeDiscoveryHttpClientLayer();

const oauthScopesFromConfig = (
  config: {
    readonly authenticationTemplate?: readonly {
      readonly kind: string;
      readonly scopes?: readonly string[];
    }[];
  } | null,
): readonly string[] | undefined => {
  const oauth = config?.authenticationTemplate?.find((entry) => entry.kind === "oauth2");
  return oauth?.scopes ? [...oauth.scopes].sort() : undefined;
};

const googleDiscoveryToolNames = (toolName: string): readonly string[] =>
  [toolName, "oauth2.tokeninfo", "oauth2.userinfo.get", "oauth2.userinfo.v2.me.get"].sort();

const bundlePlugins = () =>
  [googlePlugin({ httpClientLayer: discoveryHttpClientLayer }), memoryCredentialsPlugin()] as const;

describe("Google custom service add flow", () => {
  it("SDK catalog includes the Google Photos focused preset", () => {
    const presetIds =
      googlePlugin({ httpClientLayer: discoveryHttpClientLayer }).integrationPresets?.map(
        (preset) => preset.id,
      ) ?? [];

    expect(presetIds).toContain("google");
    expect(presetIds).toContain("google-photos");
  });

  it.effect("derives custom integration identity from the Discovery document", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: bundlePlugins() }));

        const result = yield* executor.google.addServices({
          services: [
            {
              custom: {
                urls: [TASKS_URL],
              },
            },
          ],
        });

        expect(result).toEqual({
          added: [
            {
              slug: IntegrationSlug.make("google_tasks"),
              presetId: "google_tasks",
              toolCount: 4,
            },
          ],
          skipped: [],
          failed: [],
        });

        const integration = (yield* executor.integrations.list()).find(
          (item) => String(item.slug) === "google_tasks",
        );
        expect(integration?.name).toBe("Google Tasks");
        expect(integration?.description).toBe("Manage your tasks and task lists.");

        const config = yield* executor.google.getConfig("google_tasks");
        expect(config?.googleDiscoveryUrls).toEqual([TASKS_URL, OAUTH2_URL]);
        expect(oauthScopesFromConfig(config)).toEqual(
          ["email", "https://www.googleapis.com/auth/tasks", "openid", "profile"].sort(),
        );
      }),
    ),
  );

  it.effect("uses explicit custom identity overrides for a single Discovery URL", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: bundlePlugins() }));

        const result = yield* executor.google.addServices({
          services: [
            {
              custom: {
                urls: [TASKS_URL],
                slug: "team_tasks",
                name: "Team Tasks",
                description: "Internal task workflow.",
              },
            },
          ],
        });

        expect(result).toEqual({
          added: [
            {
              slug: IntegrationSlug.make("team_tasks"),
              presetId: "team_tasks",
              toolCount: 4,
            },
          ],
          skipped: [],
          failed: [],
        });

        const integration = (yield* executor.integrations.list()).find(
          (item) => String(item.slug) === "team_tasks",
        );
        expect(integration?.name).toBe("Team Tasks");
        expect(integration?.description).toBe("Internal task workflow.");
      }),
    ),
  );

  it.effect("rejects explicit custom identity overrides for multiple Discovery URLs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: bundlePlugins() }));

        const result = yield* executor.google.addServices({
          services: [
            {
              custom: {
                urls: [TASKS_URL, CALENDAR_URL],
                slug: "team_google",
                name: "Team Google",
              },
            },
          ],
        });

        expect(result).toEqual({
          added: [],
          skipped: [],
          failed: [
            {
              slug: IntegrationSlug.make("team_google"),
              presetId: "team_google",
              error: "Custom Google service identity overrides require exactly one Discovery URL",
            },
          ],
        });
      }),
    ),
  );

  it.effect("reports fetch failures with the fallback custom slug", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failingLayer = makeDiscoveryHttpClientLayer({
          failedUrls: new Set([TASKS_URL]),
        });
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [googlePlugin({ httpClientLayer: failingLayer }), memoryCredentialsPlugin()],
          }),
        );

        const result = yield* executor.google.addServices({
          services: [
            {
              custom: {
                urls: [TASKS_URL],
              },
            },
          ],
        });

        expect(result).toEqual({
          added: [],
          skipped: [],
          failed: [
            {
              slug: IntegrationSlug.make("google_custom"),
              presetId: "google_custom",
              error: "Failed to fetch Google Discovery document: HTTP 503",
            },
          ],
        });
        expect(yield* executor.google.getIntegration("google_custom")).toBeNull();
      }),
    ),
  );

  it.effect("adds one integration per custom Discovery URL", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: bundlePlugins() }));

        const result = yield* executor.google.addServices({
          services: [
            {
              custom: {
                urls: [TASKS_URL, CALENDAR_URL],
              },
            },
          ],
        });

        expect(result).toEqual({
          added: [
            {
              slug: IntegrationSlug.make("google_tasks"),
              presetId: "google_tasks",
              toolCount: 4,
            },
            {
              slug: IntegrationSlug.make("google_calendar"),
              presetId: "google_calendar",
              toolCount: 4,
            },
          ],
          skipped: [],
          failed: [],
        });
        const integrations = yield* executor.integrations.list();
        expect(integrations.find((item) => String(item.slug) === "google_tasks")?.name).toBe(
          "Google Tasks",
        );
        expect(integrations.find((item) => String(item.slug) === "google_calendar")?.name).toBe(
          "Google Calendar",
        );
      }),
    ),
  );

  it.effect("skips a duplicate custom Discovery URL in the same request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: bundlePlugins() }));

        const result = yield* executor.google.addServices({
          services: [
            {
              custom: {
                urls: [TASKS_URL, TASKS_URL],
              },
            },
          ],
        });

        expect(result).toEqual({
          added: [
            {
              slug: IntegrationSlug.make("google_tasks"),
              presetId: "google_tasks",
              toolCount: 4,
            },
          ],
          skipped: [
            {
              slug: IntegrationSlug.make("google_tasks"),
              presetId: "google_tasks",
              reason: "already_exists",
            },
          ],
          failed: [],
        });

        const integrations = yield* executor.integrations.list();
        expect(
          integrations.filter((integration) => String(integration.slug) === "google_tasks"),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("rejects lookalike Discovery hosts before fetching custom service documents", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let requests = 0;
        const blockedHttpClientLayer = Layer.succeed(HttpClient.HttpClient)(
          HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
            Effect.sync(() => {
              requests += 1;
              return HttpClientResponse.fromWeb(
                request,
                new Response("unexpected request", { status: 500 }),
              );
            }),
          ),
        );
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              googlePlugin({ httpClientLayer: blockedHttpClientLayer }),
              memoryCredentialsPlugin(),
            ],
          }),
        );

        const result = yield* executor.google.addServices({
          services: [
            {
              custom: {
                urls: ["https://evilgoogleapis.com/discovery/v1/apis/calendar/v3/rest"],
                slug: "bad_google",
                name: "Bad Google",
              },
            },
          ],
        });

        expect(result).toEqual({
          added: [],
          skipped: [],
          failed: [
            {
              slug: IntegrationSlug.make("bad_google"),
              presetId: "bad_google",
              error:
                "Google Discovery document URL must be a supported googleapis.com HTTPS Discovery endpoint",
            },
          ],
        });
        expect(requests).toBe(0);
      }),
    ),
  );

  it.effect("custom Google Photos Library uses the focused Photos scopes and upload tool", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: bundlePlugins() }));

        yield* executor.google.addServices({
          services: [
            {
              custom: {
                urls: [PHOTOS_LIBRARY_URL],
              },
            },
          ],
        });

        const config = yield* executor.google.getConfig("google_photoslibrary");
        const oauth = config?.authenticationTemplate?.find((entry) => entry.kind === "oauth2");
        expect(oauth?.kind === "oauth2" ? [...oauth.scopes].sort() : undefined).toEqual(
          [
            "email",
            "https://www.googleapis.com/auth/photoslibrary.appendonly",
            "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata",
            "openid",
            "profile",
          ].sort(),
        );

        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make("google_photoslibrary"),
          template: AuthTemplateSlug.make("googleOAuth2"),
          value: "token-xyz",
        });

        const toolNames = (yield* executor.tools.list()).map((tool) => String(tool.name));
        expect(toolNames).toContain("photoslibrary.mediaItems.upload");
        expect(toolNames).toContain("photoslibrary.mediaItems.search");
        expect(toolNames).not.toContain("photoslibrary.albums.list");
      }),
    ),
  );
});

describe("Google per-service add flow", () => {
  const serviceExpectations = [
    {
      presetId: "google-calendar",
      slug: "google_calendar",
      name: "Google Calendar",
      description: "Calendars, events, ACLs, and scheduling.",
      discoveryUrl: CALENDAR_URL,
      scopes: ["email", "https://www.googleapis.com/auth/calendar", "openid", "profile"],
      toolNames: googleDiscoveryToolNames("calendar.events.list"),
    },
    {
      presetId: "google-gmail",
      slug: "google_gmail",
      name: "Gmail",
      description: "Messages, threads, labels, and drafts.",
      discoveryUrl: GMAIL_URL,
      scopes: ["email", "https://mail.google.com/", "openid", "profile"],
      toolNames: googleDiscoveryToolNames("gmail.users.messages.list"),
    },
    {
      presetId: "google-drive",
      slug: "google_drive",
      name: "Google Drive",
      description: "Files, folders, permissions, and shared drives.",
      discoveryUrl: DRIVE_URL,
      scopes: ["email", "https://www.googleapis.com/auth/drive", "openid", "profile"],
      toolNames: googleDiscoveryToolNames("drive.files.list"),
    },
  ] as const;

  it.effect(
    "addServices creates one integration per preset with exact scopes and health checks",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const executor = yield* createExecutor(makeTestConfig({ plugins: bundlePlugins() }));
          const connectedToolNames = (slug: string) =>
            Effect.gen(function* () {
              yield* executor.connections.create({
                owner: "org",
                name: ConnectionName.make(slug),
                integration: IntegrationSlug.make(slug),
                template: AuthTemplateSlug.make("googleOAuth2"),
                value: "token-xyz",
              });
              return (yield* executor.tools.list({ integration: IntegrationSlug.make(slug) }))
                .map((tool) => String(tool.name))
                .sort();
            });

          const result = yield* executor.google.addServices({
            services: serviceExpectations.map((service) => ({ presetId: service.presetId })),
          });

          expect(result).toEqual({
            added: serviceExpectations.map((service) => ({
              slug: IntegrationSlug.make(service.slug),
              presetId: service.presetId,
              toolCount: 4,
            })),
            skipped: [],
            failed: [],
          });

          const integrations = yield* executor.integrations.list();
          for (const service of serviceExpectations) {
            const integration = integrations.find((item) => String(item.slug) === service.slug);
            expect(integration?.name).toBe(service.name);
            expect(integration?.description).toBe(service.description);

            const config = yield* executor.google.getConfig(service.slug);
            expect(config?.googleDiscoveryUrls).toEqual([service.discoveryUrl, OAUTH2_URL]);
            expect(oauthScopesFromConfig(config)).toEqual([...service.scopes].sort());

            const stored = yield* executor.integrations.healthCheck.get(
              IntegrationSlug.make(service.slug),
            );
            expect(stored?.operation).toBe("oauth2.userinfo.get");
            expect(stored?.args).toBeUndefined();
            expect(stored?.identityField).toBe("email");

            expect(yield* connectedToolNames(service.slug)).toEqual(service.toolNames);
          }
        }),
      ),
  );

  it.effect(
    "addServices isolates a Discovery fetch failure and keeps other services registered",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const failingLayer = makeDiscoveryHttpClientLayer({
            failedUrls: new Set([GMAIL_URL]),
          });
          const executor = yield* createExecutor(
            makeTestConfig({
              plugins: [googlePlugin({ httpClientLayer: failingLayer }), memoryCredentialsPlugin()],
            }),
          );
          const connectedToolNames = (slug: string) =>
            Effect.gen(function* () {
              yield* executor.connections.create({
                owner: "org",
                name: ConnectionName.make(slug),
                integration: IntegrationSlug.make(slug),
                template: AuthTemplateSlug.make("googleOAuth2"),
                value: "token-xyz",
              });
              return (yield* executor.tools.list({ integration: IntegrationSlug.make(slug) }))
                .map((tool) => String(tool.name))
                .sort();
            });

          const result = yield* executor.google.addServices({
            services: [
              { presetId: "google-calendar" },
              { presetId: "google-gmail" },
              { presetId: "google-drive" },
            ],
          });

          expect(result).toEqual({
            added: [
              {
                slug: IntegrationSlug.make("google_calendar"),
                presetId: "google-calendar",
                toolCount: 4,
              },
              {
                slug: IntegrationSlug.make("google_drive"),
                presetId: "google-drive",
                toolCount: 4,
              },
            ],
            skipped: [],
            failed: [
              {
                slug: IntegrationSlug.make("google_gmail"),
                presetId: "google-gmail",
                error: "Failed to fetch Google Discovery document: HTTP 503",
              },
            ],
          });

          expect(yield* executor.google.getIntegration("google_gmail")).toBeNull();
          expect(yield* connectedToolNames("google_calendar")).toEqual(
            googleDiscoveryToolNames("calendar.events.list"),
          );
          expect(yield* connectedToolNames("google_drive")).toEqual(
            googleDiscoveryToolNames("drive.files.list"),
          );
        }),
      ),
  );

  it.effect("addServices skips an existing service without duplicating integration rows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: bundlePlugins() }));

        yield* executor.google.addServices({
          services: [{ presetId: "google-calendar" }],
        });
        const result = yield* executor.google.addServices({
          services: [{ presetId: "google-calendar" }],
        });

        expect(result).toEqual({
          added: [],
          skipped: [
            {
              slug: IntegrationSlug.make("google_calendar"),
              presetId: "google-calendar",
              reason: "already_exists",
            },
          ],
          failed: [],
        });

        const integrations = yield* executor.integrations.list();
        expect(
          integrations.filter((integration) => String(integration.slug) === "google_calendar"),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("addServices starts each service Discovery fetch sequentially", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let activeServiceFetches = 0;
        let maxActiveServiceFetches = 0;
        const serviceFetchOrder: string[] = [];
        const sequentialLayer = makeDiscoveryHttpClientLayer({
          beforeResponse: (url) => {
            if (url === OAUTH2_URL) return Effect.void;
            return Effect.gen(function* () {
              activeServiceFetches += 1;
              maxActiveServiceFetches = Math.max(maxActiveServiceFetches, activeServiceFetches);
              serviceFetchOrder.push(url);
              yield* waitOneTurn;
              activeServiceFetches -= 1;
            });
          },
        });
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              googlePlugin({ httpClientLayer: sequentialLayer }),
              memoryCredentialsPlugin(),
            ],
          }),
        );

        const result = yield* executor.google.addServices({
          services: [
            { presetId: "google-calendar" },
            { presetId: "google-gmail" },
            { presetId: "google-drive" },
          ],
        });

        expect(result.failed).toEqual([]);
        expect(serviceFetchOrder).toEqual([CALENDAR_URL, GMAIL_URL, DRIVE_URL]);
        expect(maxActiveServiceFetches).toBe(1);
      }),
    ),
  );
});

describe("Google health-check default", () => {
  it.effect("custom service auto-configures OAuth2 userinfo identity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: bundlePlugins() }));

        yield* executor.google.addServices({
          services: [
            {
              custom: {
                urls: [TASKS_URL],
              },
            },
          ],
        });

        const stored = yield* executor.integrations.healthCheck.get(
          IntegrationSlug.make("google_tasks"),
        );
        expect(stored?.operation, "the default check targets OAuth2 userinfo").toBe(
          "oauth2.userinfo.get",
        );
        expect(stored?.args, "userinfo needs no args").toBeUndefined();
        expect(stored?.identityField, "the default reads the account email").toBe("email");

        const config = yield* executor.google.getConfig("google_tasks");
        expect(config?.googleDiscoveryUrls).toEqual([TASKS_URL, OAUTH2_URL]);
        const oauth = config?.authenticationTemplate?.find((entry) => entry.kind === "oauth2");
        expect(oauth?.kind === "oauth2" ? [...oauth.scopes].sort() : undefined).toEqual(
          ["email", "https://www.googleapis.com/auth/tasks", "openid", "profile"].sort(),
        );

        const candidates = yield* executor.integrations.healthCheck.candidates(
          IntegrationSlug.make("google_tasks"),
        );
        const userinfo = candidates.find((c) => c.operation === "oauth2.userinfo.get");
        expect(userinfo, "OAuth2 userinfo is a ranked candidate").toBeDefined();
        expect(
          (userinfo?.responseFields ?? []).map((field) => field.path),
          "the email identity field is projected from the response schema",
        ).toContain("email");
      }),
    ),
  );

  it.effect("custom service with People still prefers OAuth2 userinfo", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: bundlePlugins() }));

        yield* executor.google.addServices({
          services: [
            {
              custom: {
                urls: [PEOPLE_URL],
              },
            },
          ],
        });

        const stored = yield* executor.integrations.healthCheck.get(
          IntegrationSlug.make("google_people"),
        );
        expect(stored?.operation, "OAuth2 userinfo beats the People identity call").toBe(
          "oauth2.userinfo.get",
        );
        expect(stored?.args).toBeUndefined();
        expect(stored?.identityField).toBe("email");
      }),
    ),
  );

  it("falls back to People when OAuth2 userinfo is absent", () => {
    expect(
      defaultGoogleHealthCheck(
        [PEOPLE_URL],
        [
          {
            toolPath: "people.people.get",
            operation: { method: "get", pathTemplate: "/v1/{+resourceName}" },
          },
        ],
      ),
    ).toEqual({
      operation: "people.people.get",
      args: { resourceName: "people/me", personFields: "names,emailAddresses" },
      identityField: "emailAddresses.0.value",
    });
  });
});
