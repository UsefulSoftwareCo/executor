import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { bundleEntry } from "../pipeline/bundle";
import { makeInProcessAppToolExecutor } from "./app-tool-executor";

const bytes = (value: string): string => value;

const bundle = (source: string) =>
  bundleEntry({
    files: new Map([["tools/sync-deals.ts", bytes(source)]]),
    entry: "tools/sync-deals.ts",
  });

describe("in-process app tool executor", () => {
  it.effect("detects top-level integration fields", () =>
    Effect.gen(function* () {
      const bundled = yield* bundle(`
        import { z } from "zod";
        import { defineTool, integration } from "executor:app";
        export default defineTool({
          description: "Refresh deals",
          input: z.object({ crm: integration("dealcloud"), updatedSince: z.string().optional() }),
          output: z.object({ synced: z.number() }),
          async handler(input) {
            return { synced: 1 };
          },
        });
      `);
      const collected = yield* makeInProcessAppToolExecutor().collect(bundled.code, {
        fileSlug: "sync-deals",
        sourcePath: "tools/sync-deals.ts",
      });
      expect(collected.tools[0]?.integrations).toEqual({ crm: { slug: "dealcloud" } });
      expect(collected.tools[0]?.inputSchema).toMatchObject({
        properties: { crm: { type: "string" } },
      });
    }),
  );

  it.effect("rejects nested integration fields with a named diagnostic", () =>
    Effect.gen(function* () {
      const bundled = yield* bundle(`
        import { z } from "zod";
        import { defineTool, integration } from "executor:app";
        export default defineTool({
          description: "Bad nesting",
          input: z.object({ nested: z.object({ crm: integration("dealcloud") }) }),
          async handler(input) {
            return input;
          },
        });
      `);
      const exit = yield* makeInProcessAppToolExecutor()
        .collect(bundled.code, {
          fileSlug: "sync-deals",
          sourcePath: "tools/sync-deals.ts",
        })
        .pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain("nested.crm");
      }
    }),
  );

  it.effect("collects record and factory exports with file-prefixed names", () =>
    Effect.gen(function* () {
      const bundled = yield* bundle(`
        import { z } from "zod";
        import { defineTool } from "executor:app";
        export default async () => ({
          first: defineTool({
            description: "First",
            input: z.object({ value: z.string() }),
            handler(input) { return input; },
          }),
          second: defineTool({
            description: "Second",
            input: z.object({ value: z.string() }),
            handler(input) { return input; },
          }),
        });
      `);
      const collected = yield* makeInProcessAppToolExecutor().collect(bundled.code, {
        fileSlug: "sync-deals",
        sourcePath: "tools/sync-deals.ts",
      });
      expect(collected.tools.map((tool) => tool.toolName)).toEqual([
        "sync-deals__first",
        "sync-deals__second",
      ]);
    }),
  );

  it.effect("rejects record keys that collide with the single export slug", () =>
    Effect.gen(function* () {
      const bundled = yield* bundle(`
        import { z } from "zod";
        import { defineTool } from "executor:app";
        export default {
          "sync-deals": defineTool({
            description: "Collides",
            input: z.object({ value: z.string() }),
            handler(input) { return input; },
          }),
        };
      `);
      const exit = yield* makeInProcessAppToolExecutor()
        .collect(bundled.code, {
          fileSlug: "sync-deals",
          sourcePath: "tools/sync-deals.ts",
        })
        .pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") expect(String(exit.cause)).toContain("collides");
    }),
  );

  it.effect("routes integration method calls through the bridge", () =>
    Effect.gen(function* () {
      const bundled = yield* bundle(`
        import { z } from "zod";
        import { defineTool, integration } from "executor:app";
        export default defineTool({
          description: "Refresh deals",
          input: z.object({ crm: integration("dealcloud") }),
          output: z.object({ synced: z.number() }),
          async handler(input) {
            const deals = await input.crm.deals.list({ limit: 2 });
            return { synced: deals.length };
          },
        });
      `);
      const calls: unknown[] = [];
      const result = yield* makeInProcessAppToolExecutor().invoke(
        bundled.code,
        { toolName: "sync-deals" },
        { crm: "tools.dealcloud.org.main" },
        {
          call: async (toolPath, args) => {
            calls.push({ toolPath, args });
            return [{ id: 1 }, { id: 2 }];
          },
        },
        { timeoutMs: 1000 },
      );
      expect(result.output).toEqual({ synced: 2 });
      expect(calls).toEqual([{ toolPath: "crm.deals.list", args: { limit: 2 } }]);
    }),
  );

  it.effect("classifies input validation failure", () =>
    Effect.gen(function* () {
      const bundled = yield* bundle(`
        import { z } from "zod";
        import { defineTool } from "executor:app";
        export default defineTool({
          description: "Validate",
          input: z.object({ value: z.string() }),
          handler(input) { return input; },
        });
      `);
      const exit = yield* makeInProcessAppToolExecutor()
        .invoke(
          bundled.code,
          { toolName: "sync-deals" },
          { value: 1 },
          { call: async () => null },
          {
            timeoutMs: 1000,
          },
        )
        .pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") expect(String(exit.cause)).toContain("validation failed");
    }),
  );

  it.effect("enforces timeout", () =>
    Effect.gen(function* () {
      const bundled = yield* bundle(`
        import { z } from "zod";
        import { defineTool } from "executor:app";
        export default defineTool({
          description: "Slow",
          input: z.object({}),
          async handler() {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return {};
          },
        });
      `);
      const exit = yield* makeInProcessAppToolExecutor()
        .invoke(
          bundled.code,
          { toolName: "sync-deals" },
          {},
          { call: async () => null },
          {
            timeoutMs: 1,
          },
        )
        .pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") expect(String(exit.cause)).toContain("timed out");
    }),
  );
});
