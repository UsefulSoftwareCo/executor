// ---------------------------------------------------------------------------
// Google bundle add flow, "customize your Google connection".
//
// The product picker emits a URL list. The server fetches each Discovery
// document, merges them into ONE `google`
// integration spec, and stores the unioned `googleOAuth2` auth template. These
// tests exercise that path end-to-end against a stubbed Discovery host:
//   - a 3-API bundle (calendar + gmail + drive) produces a single `google`
//     integration whose merged tools carry NO name collisions (each method id
//     is service-prefixed) even when two APIs share a generic method name;
//   - the stored oauth template carries the UNION of every API's scopes.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  ConnectionName,
  IntegrationSlug,
  createExecutor,
  AuthTemplateSlug,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { defaultGoogleHealthCheck, googlePlugin } from "./plugin";
import { googleOpenApiPresets, type GoogleOpenApiPreset } from "./presets";

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
  [PHOTOS_LIBRARY_URL]: toJson(photosLibraryDoc),
  [PHOTOS_PICKER_URL]: toJson(photosPickerDoc),
  [PEOPLE_URL]: toJson(peopleDoc),
  [OAUTH2_URL]: toJson(oauth2Doc),
};

// A stub HTTP client that serves the canned Discovery document for whichever
// URL the bundle converter fetches. Service-hosted Discovery URLs carry their
// version in the query string, so match the full URL before falling back to the
// path-only key used by central Discovery URLs.
const discoveryHttpClientLayer = Layer.succeed(HttpClient.HttpClient)(
  HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
    const url = new URL(request.url);
    const key = `${url.origin}${url.pathname}`;
    const body = DISCOVERY_BODIES[url.toString()] ?? DISCOVERY_BODIES[key];
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        body === undefined
          ? new Response("not found", { status: 404 })
          : new Response(body, {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
      ),
    );
  }),
);

const bundlePlugins = () =>
  [googlePlugin({ httpClientLayer: discoveryHttpClientLayer }), memoryCredentialsPlugin()] as const;

describe("Google bundle add flow", () => {
  it("SDK catalog includes the Google Photos focused preset", () => {
    const presetIds =
      googlePlugin({ httpClientLayer: discoveryHttpClientLayer }).integrationPresets?.map(
        (preset) => preset.id,
      ) ?? [];

    expect(presetIds).toContain("google");
    expect(presetIds).toContain("google-photos");
  });

  it.effect("rejects lookalike Discovery hosts before fetching bundle documents", () =>
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

        const exit = yield* executor.google
          .addBundle({
            urls: ["https://evilgoogleapis.com/discovery/v1/apis/calendar/v3/rest"],
            slug: "bad_google",
          })
          .pipe(Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(requests).toBe(0);
      }),
    ),
  );

  it.effect(
    "addBundle merges calendar+gmail+drive into one google integration with no tool-name collisions",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const executor = yield* createExecutor(makeTestConfig({ plugins: bundlePlugins() }));

          const result = yield* executor.google.addBundle({
            urls: [CALENDAR_URL, GMAIL_URL, DRIVE_URL],
            slug: "google",
            description: "Google",
          });
          expect(String(result.slug)).toBe("google");

          // ONE integration, not three.
          const integration = yield* executor.google.getIntegration("google");
          expect(integration?.slug).toBe(IntegrationSlug.make("google"));

          // The stored oauth template carries the COMPACTED union of every API's
          // scopes plus the hidden OAuth2 identity scopes that `oauth.start`
          // requests.
          // `calendar.readonly` collapses under `calendar`, and `gmail.readonly`
          // collapses under `https://mail.google.com/`, so the requested consent
          // is clean rather than the raw per-method union.
          const config = yield* executor.google.getConfig("google");
          expect(config?.googleDiscoveryUrls).toEqual([
            CALENDAR_URL,
            GMAIL_URL,
            DRIVE_URL,
            OAUTH2_URL,
          ]);
          const oauth = config?.authenticationTemplate?.find((entry) => entry.kind === "oauth2");
          expect(oauth?.kind === "oauth2" ? [...oauth.scopes].sort() : undefined).toEqual(
            [
              "email",
              "https://mail.google.com/",
              "https://www.googleapis.com/auth/calendar",
              "https://www.googleapis.com/auth/drive",
              "openid",
              "profile",
            ].sort(),
          );

          // A connection stamps the merged tools; assert all three `list`s are
          // present under distinct service-prefixed names (no collision).
          yield* executor.connections.create({
            owner: "org",
            name: ConnectionName.make("main"),
            integration: IntegrationSlug.make("google"),
            template: AuthTemplateSlug.make("googleOAuth2"),
            value: "token-xyz",
          });

          const toolNames = (yield* executor.tools.list()).map((tool) => String(tool.name));
          expect(toolNames).toContain("calendar.events.list");
          expect(toolNames).toContain("gmail.users.messages.list");
          expect(toolNames).toContain("drive.files.list");

          // No duplicate tool names across the merged surface.
          const googleTools = toolNames.filter((name) => name.endsWith(".list"));
          expect(new Set(googleTools).size).toBe(googleTools.length);
          expect(googleTools.length).toBe(3);
        }),
      ),
  );

  it.effect("addBundle constrains Google Photos to the preset scopes and upload tool", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: bundlePlugins() }));

        yield* executor.google.addBundle({
          urls: [
            PHOTOS_LIBRARY_URL,
            "https://photospicker.googleapis.com/$discovery/rest?version=v1",
          ],
          slug: "google_photos",
          name: "Google Photos",
        });

        const config = yield* executor.google.getConfig("google_photos");
        const oauth = config?.authenticationTemplate?.find((entry) => entry.kind === "oauth2");
        expect(oauth?.kind === "oauth2" ? [...oauth.scopes].sort() : undefined).toEqual(
          [
            "email",
            "https://www.googleapis.com/auth/photoslibrary.appendonly",
            "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata",
            "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
            "openid",
            "profile",
          ].sort(),
        );

        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make("google_photos"),
          template: AuthTemplateSlug.make("googleOAuth2"),
          value: "token-xyz",
        });

        const toolNames = (yield* executor.tools.list()).map((tool) => String(tool.name));
        expect(toolNames).toContain("photoslibrary.mediaItems.upload");
        expect(toolNames).toContain("photoslibrary.mediaItems.search");
        expect(toolNames).toContain("photospicker.mediaItems.list");
        expect(toolNames).not.toContain("photoslibrary.albums.list");
      }),
    ),
  );

  it.effect("addBundle keeps Google Photos scoped when combined with another API", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: bundlePlugins() }));

        yield* executor.google.addBundle({
          urls: [CALENDAR_URL, PHOTOS_LIBRARY_URL, PHOTOS_PICKER_URL],
          slug: "google_photos_calendar",
          name: "Google Photos and Calendar",
        });

        const config = yield* executor.google.getConfig("google_photos_calendar");
        const oauth = config?.authenticationTemplate?.find((entry) => entry.kind === "oauth2");
        expect(oauth?.kind === "oauth2" ? [...oauth.scopes].sort() : undefined).toEqual(
          [
            "email",
            "https://www.googleapis.com/auth/calendar",
            "https://www.googleapis.com/auth/photoslibrary.appendonly",
            "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata",
            "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
            "openid",
            "profile",
          ].sort(),
        );

        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make("google_photos_calendar"),
          template: AuthTemplateSlug.make("googleOAuth2"),
          value: "token-xyz",
        });

        const toolNames = (yield* executor.tools.list()).map((tool) => String(tool.name));
        expect(toolNames).toContain("calendar.events.list");
        expect(toolNames).toContain("photoslibrary.mediaItems.upload");
        expect(toolNames).toContain("photoslibrary.mediaItems.search");
        expect(toolNames).toContain("photospicker.mediaItems.list");
        expect(toolNames).not.toContain("photoslibrary.albums.list");
      }),
    ),
  );

  it.effect("addBundle scopes a partial Google Photos bundle when mixed with another API", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: bundlePlugins() }));

        yield* executor.google.addBundle({
          urls: [CALENDAR_URL, PHOTOS_LIBRARY_URL],
          slug: "google_photos_library_calendar",
          name: "Google Photos Library and Calendar",
        });

        const config = yield* executor.google.getConfig("google_photos_library_calendar");
        const oauth = config?.authenticationTemplate?.find((entry) => entry.kind === "oauth2");
        expect(oauth?.kind === "oauth2" ? [...oauth.scopes].sort() : undefined).toEqual(
          [
            "email",
            "https://www.googleapis.com/auth/calendar",
            "https://www.googleapis.com/auth/photoslibrary.appendonly",
            "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata",
            "openid",
            "profile",
          ].sort(),
        );

        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make("google_photos_library_calendar"),
          template: AuthTemplateSlug.make("googleOAuth2"),
          value: "token-xyz",
        });

        const toolNames = (yield* executor.tools.list()).map((tool) => String(tool.name));
        expect(toolNames).toContain("calendar.events.list");
        expect(toolNames).toContain("photoslibrary.mediaItems.upload");
        expect(toolNames).toContain("photoslibrary.mediaItems.search");
        expect(toolNames).not.toContain("photospicker.mediaItems.list");
        expect(toolNames).not.toContain("photoslibrary.albums.list");
      }),
    ),
  );
});

describe("Google health-check default", () => {
  it.effect("default featured bundle auto-configures OAuth2 userinfo identity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: bundlePlugins() }));
        const defaultUrls = googleOpenApiPresets
          .filter((preset: GoogleOpenApiPreset) => preset.featured)
          .flatMap((preset: GoogleOpenApiPreset) => (preset.url ? [preset.url] : []));

        expect(defaultUrls).toEqual([CALENDAR_URL, GMAIL_URL, SHEETS_URL, DRIVE_URL, DOCS_URL]);

        yield* executor.google.addBundle({
          urls: defaultUrls,
          slug: "google_default",
          description: "Google",
        });

        const stored = yield* executor.integrations.healthCheck.get(
          IntegrationSlug.make("google_default"),
        );
        expect(stored?.operation, "the default check targets OAuth2 userinfo").toBe(
          "oauth2.userinfo.get",
        );
        expect(stored?.args, "userinfo needs no args").toBeUndefined();
        expect(stored?.identityField, "the default reads the account email").toBe("email");

        const config = yield* executor.google.getConfig("google_default");
        expect(config?.googleDiscoveryUrls).toEqual([...defaultUrls, OAUTH2_URL]);
        const oauth = config?.authenticationTemplate?.find((entry) => entry.kind === "oauth2");
        expect(oauth?.kind === "oauth2" ? [...oauth.scopes].sort() : undefined).toEqual(
          [
            "email",
            "https://mail.google.com/",
            "https://www.googleapis.com/auth/calendar",
            "https://www.googleapis.com/auth/documents",
            "https://www.googleapis.com/auth/drive",
            "https://www.googleapis.com/auth/spreadsheets",
            "openid",
            "profile",
          ].sort(),
        );

        const candidates = yield* executor.integrations.healthCheck.candidates(
          IntegrationSlug.make("google_default"),
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

  it.effect("addBundle with People still prefers OAuth2 userinfo", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: bundlePlugins() }));

        yield* executor.google.addBundle({
          urls: [PEOPLE_URL, CALENDAR_URL],
          slug: "google_people",
          description: "Google",
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
