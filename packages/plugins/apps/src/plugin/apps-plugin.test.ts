import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { projectAppsToolSchema } from "./apps-plugin";
import type { AppsStore } from "./store";

describe("apps plugin schema projection", () => {
  it.effect("narrows synthesized integration fields to connection address enums", () =>
    Effect.gen(function* () {
      const storage: AppsStore = {
        putBlob: () => Effect.succeed("bundle"),
        getBlob: () => Effect.succeed(null),
        getDescriptorRecord: () => Effect.succeed(null),
        putPublished: () => Effect.void,
        listActiveTools: () => Effect.succeed([]),
        getTool: () =>
          Effect.succeed({
            app: "crm",
            name: "sync",
            bundleKey: "bundle",
            description: "Sync",
            integrations: {
              crm: { slug: "dealcloud", mode: "one", all: false },
              inboxes: { slug: "gmail", mode: "many", all: false },
            },
          }),
      };
      const result = yield* projectAppsToolSchema(
        {
          storage,
          connections: {
            list: ({ integration }: { readonly integration?: unknown }) =>
              Effect.succeed(
                String(integration) === "dealcloud"
                  ? [{ address: "tools.dealcloud.org.main" }]
                  : [{ address: "tools.gmail.org.work" }, { address: "tools.gmail.user.personal" }],
              ),
          },
        } as never,
        "sync",
        {
          type: "object",
          properties: {
            updatedSince: { type: "string" },
            crm: { type: "string" },
            inboxes: { type: "array", items: { type: "string" } },
          },
          required: ["crm", "inboxes"],
        },
        undefined,
      );
      expect(result.inputSchema).toMatchObject({
        properties: {
          crm: { enum: ["tools.dealcloud.org.main"] },
          inboxes: {
            items: {
              enum: ["tools.gmail.org.work", "tools.gmail.user.personal"],
            },
          },
        },
        required: ["crm", "inboxes"],
      });
    }),
  );

  it.effect("omits all-bound integration fields from projected schemas", () =>
    Effect.gen(function* () {
      const storage: AppsStore = {
        putBlob: () => Effect.succeed("bundle"),
        getBlob: () => Effect.succeed(null),
        getDescriptorRecord: () => Effect.succeed(null),
        putPublished: () => Effect.void,
        listActiveTools: () => Effect.succeed([]),
        getTool: () =>
          Effect.succeed({
            app: "mail",
            name: "search_all_mail",
            bundleKey: "bundle",
            description: "Search mail",
            integrations: {
              inboxes: { slug: "gmail", mode: "many", all: true },
            },
          }),
      };
      const inputSchema = {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      };
      const result = yield* projectAppsToolSchema(
        {
          storage,
          connections: {
            list: () => Effect.succeed([{ address: "tools.gmail.org.work" }]),
          },
        } as never,
        "search_all_mail",
        inputSchema,
        undefined,
      );
      expect(result.inputSchema).toEqual(inputSchema);
    }),
  );
});
