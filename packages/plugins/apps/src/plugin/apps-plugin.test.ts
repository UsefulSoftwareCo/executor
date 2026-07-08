import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ToolResult } from "@executor-js/sdk";

import { bundleEntry } from "../pipeline/bundle";
import { makeInProcessAppToolExecutor } from "../executor/app-tool-executor";
import type { AppDescriptor } from "../pipeline/descriptor";
import { makeAppsPlugin, projectAppsToolSchema } from "./apps-plugin";
import type { AppsStore } from "./store";

const bundle = (source: string) =>
  bundleEntry({
    files: new Map([["tools/sync.ts", source]]),
    entry: "tools/sync.ts",
  });

const makeInvokeStore = (input: {
  readonly bundle: string;
  readonly integrations: AppDescriptor["tools"][number]["integrations"];
}): AppsStore => ({
  putBlob: () => Effect.succeed("bundle"),
  getBlob: () => Effect.succeed(input.bundle),
  getDescriptorRecord: () => Effect.succeed(null),
  putPublished: () => Effect.void,
  listActiveTools: () => Effect.succeed([]),
  getTool: () =>
    Effect.succeed({
      app: "crm",
      name: "sync",
      bundleKey: "bundle",
      description: "Sync",
      integrations: input.integrations,
    }),
});

const invokeCtx = (input: {
  readonly bundle: string;
  readonly execute: (address: string, args: unknown) => Effect.Effect<unknown, unknown>;
}) =>
  ({
    storage: makeInvokeStore({
      bundle: input.bundle,
      integrations: { crm: { slug: "dealcloud", mode: "one" } },
    }),
    connections: {
      list: () => Effect.succeed([]),
      get: () =>
        Effect.succeed({
          address: "tools.dealcloud.org.main",
          integration: "dealcloud",
          owner: "org",
          name: "main",
        }),
    },
    execute: (address: string, args: unknown) => input.execute(String(address), args),
  }) as never;

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
              crm: { slug: "dealcloud", mode: "one" },
              inboxes: { slug: "gmail", mode: "many" },
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
});

describe("apps plugin invocation", () => {
  it.effect("surfaces uncaught inner tool failures without binding_error", () =>
    Effect.gen(function* () {
      const bundled = yield* bundle(`
        import { z } from "zod";
        import { defineTool, integration } from "executor:app";
        export default defineTool({
          description: "Sync",
          integrations: { crm: integration("dealcloud") },
          input: z.object({}),
          async handler(_input, { crm }) {
            await crm.deals.list({});
            return { ok: true };
          },
        });
      `);
      const plugin = makeAppsPlugin({ executor: makeInProcessAppToolExecutor() });
      const result = yield* plugin.invokeTool!({
        ctx: invokeCtx({
          bundle: bundled.code,
          execute: () =>
            Effect.succeed(
              ToolResult.fail({ code: "upstream_failed", message: "CRM unavailable" }),
            ),
        }),
        toolRow: { name: "sync" },
        args: { crm: "tools.dealcloud.org.main" },
      } as never);
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "upstream_failed",
          message: expect.stringContaining("tools.dealcloud.org.main.deals.list"),
        },
      });
      expect(result).toMatchObject({
        error: { message: expect.stringContaining('"CRM unavailable"') },
      });
      expect((result as { readonly error: { readonly code: string } }).error.code).not.toBe(
        "binding_error",
      );
    }),
  );

  it.effect("lets handlers catch inner tool failures and return a fallback", () =>
    Effect.gen(function* () {
      const bundled = yield* bundle(`
        import { z } from "zod";
        import { defineTool, integration } from "executor:app";
        export default defineTool({
          description: "Sync",
          integrations: { crm: integration("dealcloud") },
          input: z.object({}),
          async handler(_input, { crm }) {
            try {
              await crm.deals.list({});
              return { fallback: false };
            } catch {
              return { fallback: true };
            }
          },
        });
      `);
      const plugin = makeAppsPlugin({ executor: makeInProcessAppToolExecutor() });
      const result = yield* plugin.invokeTool!({
        ctx: invokeCtx({
          bundle: bundled.code,
          execute: () =>
            Effect.succeed(
              ToolResult.fail({ code: "upstream_failed", message: "CRM unavailable" }),
            ),
        }),
        toolRow: { name: "sync" },
        args: { crm: "tools.dealcloud.org.main" },
      } as never);
      expect(result).toEqual({ fallback: true });
    }),
  );
});
