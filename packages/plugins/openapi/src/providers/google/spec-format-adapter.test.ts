import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { createExecutor, IntegrationSlug } from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";
import { openApiPlugin, parse } from "@executor-js/plugin-openapi";
import type { AuthenticationInput } from "@executor-js/plugin-openapi";

import { deriveGoogleDiscoveryIdentity, googleDiscoveryAdapter } from "./spec-format-adapter";
import { googleCatalog } from "./presets";

const TASKS_URL = "https://www.googleapis.com/discovery/v1/apis/tasks/v1/rest";
const GMAIL_URL = "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest";
const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const GMAIL_FULL_SCOPE = "https://mail.google.com/";

const tasksDiscoveryDoc = {
  name: "tasks",
  version: "v1",
  title: "Google Tasks API",
  description: "Manage your tasks and task lists.",
  rootUrl: "https://tasks.googleapis.com/",
  servicePath: "",
  auth: {
    oauth2: {
      scopes: {
        "https://www.googleapis.com/auth/tasks": {
          description: "Create, edit, organize, and delete all your tasks.",
        },
      },
    },
  },
  methods: {
    tasklistsList: {
      id: "tasks.tasklists.list",
      httpMethod: "GET",
      path: "tasks/v1/users/@me/lists",
      scopes: ["https://www.googleapis.com/auth/tasks"],
      response: { $ref: "TaskLists" },
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
};

const discoveryHttpClientLayer = Layer.succeed(HttpClient.HttpClient)(
  HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(tasksDiscoveryDoc), {
          status: request.url === TASKS_URL ? 200 : 404,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  ),
);

const gmailDiscoveryDoc = {
  name: "gmail",
  version: "v1",
  title: "Gmail API",
  rootUrl: "https://gmail.googleapis.com/",
  servicePath: "",
  auth: {
    oauth2: {
      scopes: {
        [GMAIL_MODIFY_SCOPE]: { description: "Read and modify Gmail" },
        [GMAIL_FULL_SCOPE]: { description: "Full Gmail access" },
      },
    },
  },
  resources: {
    users: {
      resources: {
        messages: {
          methods: {
            list: {
              id: "gmail.users.messages.list",
              httpMethod: "GET",
              path: "gmail/v1/users/{userId}/messages",
              scopes: [GMAIL_MODIFY_SCOPE, GMAIL_FULL_SCOPE],
              parameters: {
                userId: { location: "path", required: true, type: "string" },
              },
            },
            delete: {
              id: "gmail.users.messages.delete",
              httpMethod: "DELETE",
              path: "gmail/v1/users/{userId}/messages/{id}",
              scopes: [GMAIL_FULL_SCOPE],
              parameters: {
                userId: { location: "path", required: true, type: "string" },
                id: { location: "path", required: true, type: "string" },
              },
            },
          },
        },
      },
    },
  },
  schemas: {},
};

const gmailDiscoveryHttpClientLayer = Layer.succeed(HttpClient.HttpClient)(
  HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(gmailDiscoveryDoc), {
          status: request.url === GMAIL_URL ? 200 : 404,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  ),
);

it.effect("fetches and converts a Google Discovery document", () =>
  Effect.gen(function* () {
    const converted = yield* googleDiscoveryAdapter.fetch({
      urls: [TASKS_URL],
      httpClientLayer: discoveryHttpClientLayer,
    });
    const parsed = yield* parse(converted.specText);

    expect(parsed.info.title).toBe("Google");
    expect(Object.keys(parsed.paths ?? {})).toContain("/tasks/v1/users/@me/lists");
    expect(converted.authenticationTemplate?.[0]?.kind).toBe("oauth2");
  }),
);

it("derives Google Discovery identity from the raw document", () => {
  expect(deriveGoogleDiscoveryIdentity(tasksDiscoveryDoc)).toEqual({
    slug: "google_tasks",
    name: "Google Tasks API",
    description: "Manage your tasks and task lists.",
  });
});

it.effect("adds a Google Discovery URL through the OpenAPI plugin with derived identity", () =>
  Effect.gen(function* () {
    const executor = yield* createExecutor(
      makeTestConfig({
        plugins: [
          openApiPlugin({
            httpClientLayer: discoveryHttpClientLayer,
            specFormats: [googleDiscoveryAdapter],
          }),
          memoryCredentialsPlugin(),
        ],
      }),
    );

    const added = yield* executor.openapi.addSpec({
      spec: { kind: "url", url: TASKS_URL },
      specFormat: "google-discovery",
    });
    const integration = yield* executor.openapi.getIntegration("google_tasks");

    expect(String(added.slug)).toBe("google_tasks");
    expect(integration?.slug).toEqual(IntegrationSlug.make("google_tasks"));
    expect(added.toolCount).toBe(1);
  }),
);

it.effect(
  "adds a Google catalog preset through OpenAPI with family, format, and default slug",
  () =>
    Effect.gen(function* () {
      const tasksPreset = googleCatalog.find((preset) => preset.defaultSlug === "google_tasks")!;
      const authTemplate: readonly AuthenticationInput[] = (tasksPreset.authTemplate ?? []).flatMap(
        (template) => (template.kind === "oauth2" ? [template] : []),
      );
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({
              httpClientLayer: discoveryHttpClientLayer,
              presets: [tasksPreset],
              specFormats: [googleDiscoveryAdapter],
            }),
            memoryCredentialsPlugin(),
          ],
        }),
      );

      const added = yield* executor.openapi.addSpec({
        spec: { kind: "url", url: tasksPreset.url! },
        slug: tasksPreset.defaultSlug,
        specFormat: tasksPreset.specFormat,
        family: tasksPreset.family,
        authenticationTemplate: authTemplate,
      });
      const config = yield* executor.openapi.getConfig("google_tasks");

      expect(String(added.slug)).toBe("google_tasks");
      expect(config?.family).toBe("google");
      expect(config?.specFormat).toBe("google-discovery");
      expect(config?.authenticationTemplate?.[0]?.kind).toBe("oauth2");
      const storedOAuthTemplates = (config?.authenticationTemplate ?? []).filter(
        (template) => template.kind === "oauth2",
      );
      expect(storedOAuthTemplates[0]?.scopes).toEqual(
        expect.arrayContaining([
          "openid",
          "email",
          "profile",
          "https://www.googleapis.com/auth/tasks",
        ]),
      );
    }),
);

it.effect("preserves a Google preset's consent scope boundary when refreshing", () =>
  Effect.gen(function* () {
    const gmailPreset = googleCatalog.find((preset) => preset.id === "google-gmail")!;
    const authTemplate: readonly AuthenticationInput[] = (gmailPreset.authTemplate ?? []).flatMap(
      (template) => (template.kind === "oauth2" ? [template] : []),
    );
    const executor = yield* createExecutor(
      makeTestConfig({
        plugins: [
          openApiPlugin({
            httpClientLayer: gmailDiscoveryHttpClientLayer,
            presets: [gmailPreset],
            specFormats: [googleDiscoveryAdapter],
          }),
          memoryCredentialsPlugin(),
        ],
      }),
    );

    const added = yield* executor.openapi.addSpec({
      spec: { kind: "url", url: GMAIL_URL },
      slug: gmailPreset.defaultSlug,
      specFormat: gmailPreset.specFormat,
      family: gmailPreset.family,
      authenticationTemplate: authTemplate,
    });
    expect(added.toolCount).toBe(1);

    const updated = yield* executor.openapi.updateSpec("google_gmail");

    const config = yield* executor.openapi.getConfig("google_gmail");
    const oauthTemplate = config?.authenticationTemplate?.find(
      (template) => template.kind === "oauth2",
    );
    expect(updated.toolCount).toBe(1);
    expect(updated.addedTools).not.toContain("gmail.users.messages.delete");
    expect(oauthTemplate?.kind === "oauth2" ? oauthTemplate.scopes : undefined).toContain(
      GMAIL_MODIFY_SCOPE,
    );
  }),
);
