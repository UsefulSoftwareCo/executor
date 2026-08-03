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
