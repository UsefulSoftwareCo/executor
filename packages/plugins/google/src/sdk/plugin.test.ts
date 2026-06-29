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

import { googlePlugin } from "./plugin";

// --- Canned Discovery documents -------------------------------------------
// Each carries one method. Calendar and Gmail BOTH expose a generic `list`
// method id segment, so a naive merge that keyed tools on the trailing method
// name would collide. The bundle converter keys on the full method id
// (`calendar.events.list`, `gmail.users.messages.list`, …), so they don't.

const CALENDAR_URL = "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest";
const GMAIL_URL = "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest";
const DRIVE_URL = "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest";
const PHOTOS_LIBRARY_URL = "https://www.googleapis.com/discovery/v1/apis/photoslibrary/v1/rest";
const PHOTOS_PICKER_URL = "https://www.googleapis.com/discovery/v1/apis/photospicker/v1/rest";

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
  auth: {
    oauth2: {
      scopes: {
        "https://www.googleapis.com/auth/photospicker.mediaitems.readonly": {
          description: "Read selected Google Photos media",
        },
      },
    },
  },
  resources: {
    mediaItems: {
      methods: {
        list: {
          id: "photospicker.mediaItems.list",
          httpMethod: "GET",
          path: "mediaItems",
          scopes: ["https://www.googleapis.com/auth/photospicker.mediaitems.readonly"],
          parameters: {},
        },
      },
    },
  },
  schemas: {},
};

const toJson = (value: unknown): string => JSON.stringify(value);

const DISCOVERY_BODIES: Readonly<Record<string, string>> = {
  [CALENDAR_URL]: toJson(calendarDoc),
  [GMAIL_URL]: toJson(gmailDoc),
  [DRIVE_URL]: toJson(driveDoc),
  [PHOTOS_LIBRARY_URL]: toJson(photosLibraryDoc),
  [PHOTOS_PICKER_URL]: toJson(photosPickerDoc),
};

// A stub HTTP client that serves the canned Discovery document for whichever
// URL the bundle converter fetches (query params are ignored when matching).
const discoveryHttpClientLayer = Layer.succeed(HttpClient.HttpClient)(
  HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
    const url = new URL(request.url);
    const key = `${url.origin}${url.pathname}`;
    const body = DISCOVERY_BODIES[key];
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
          // scopes - the same set the picker previews and `oauth.start` requests.
          // `calendar.readonly` collapses under `calendar`, and `gmail.readonly`
          // collapses under `https://mail.google.com/`, so the requested consent
          // is clean rather than the raw per-method union.
          const config = yield* executor.google.getConfig("google");
          const oauth = config?.authenticationTemplate?.find((entry) => entry.kind === "oauth2");
          expect(oauth?.kind === "oauth2" ? [...oauth.scopes].sort() : undefined).toEqual(
            [
              "https://mail.google.com/",
              "https://www.googleapis.com/auth/calendar",
              "https://www.googleapis.com/auth/drive",
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
            "https://www.googleapis.com/auth/photoslibrary.appendonly",
            "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata",
            "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
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
            "https://www.googleapis.com/auth/calendar",
            "https://www.googleapis.com/auth/photoslibrary.appendonly",
            "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata",
            "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
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
            "https://www.googleapis.com/auth/calendar",
            "https://www.googleapis.com/auth/photoslibrary.appendonly",
            "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata",
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
