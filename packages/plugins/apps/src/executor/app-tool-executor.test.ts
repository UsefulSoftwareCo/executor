import { describe, expect, it } from "@effect/vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { buildSync } from "esbuild";
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
  it("releases the invocation timeout after a successful call", () => {
    const fixture = join(import.meta.dirname, "app-tool-executor-process.fixture.ts");
    const script = buildSync({
      entryPoints: [fixture],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      write: false,
    })
      .outputFiles.map((output) => output.text)
      .join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module"], {
      encoding: "utf8",
      input: script,
      timeout: 5_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("invocation complete");
  });

  it.effect("detects integration declarations and merges projected input fields", () =>
    Effect.gen(function* () {
      const bundled = yield* bundle(`
        import { z } from "zod";
        import { defineTool, integration } from "executor:app";
        export default defineTool({
          description: "Refresh deals",
          integrations: { crm: integration("dealcloud").describe("CRM account") },
          input: z.object({ updatedSince: z.string().optional() }),
          output: z.object({ synced: z.number() }),
          async handler(input, { crm }) {
            return { synced: 1 };
          },
        });
      `);
      const collected = yield* makeInProcessAppToolExecutor().collect(bundled.code, {
        fileSlug: "sync-deals",
        sourcePath: "tools/sync-deals.ts",
      });
      expect(collected.tools[0]?.integrations).toEqual({
        crm: { slug: "dealcloud", mode: "one", description: "CRM account" },
      });
      expect(collected.tools[0]?.inputSchema).toMatchObject({
        properties: { crm: { type: "string", description: "CRM account" } },
        required: ["crm"],
      });
    }),
  );

  it.effect("rejects integration keys that collide with input fields", () =>
    Effect.gen(function* () {
      const bundled = yield* bundle(`
        import { z } from "zod";
        import { defineTool, integration } from "executor:app";
        export default defineTool({
          description: "Bad collision",
          integrations: { crm: integration("dealcloud") },
          input: z.object({ crm: z.string() }),
          async handler(input) {
            return input;
          },
        });
      `);
      const error = yield* makeInProcessAppToolExecutor()
        .collect(bundled.code, {
          fileSlug: "sync-deals",
          sourcePath: "tools/sync-deals.ts",
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ message: expect.stringContaining("collides") });
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
      const error = yield* makeInProcessAppToolExecutor()
        .collect(bundled.code, {
          fileSlug: "sync-deals",
          sourcePath: "tools/sync-deals.ts",
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ message: expect.stringContaining("collides") });
    }),
  );

  it.effect("routes integration method calls through the bridge", () =>
    Effect.gen(function* () {
      const bundled = yield* bundle(`
        import { z } from "zod";
        import { defineTool, integration } from "executor:app";
        export default defineTool({
          description: "Refresh deals",
          integrations: { crm: integration("dealcloud") },
          input: z.object({ updatedSince: z.string().optional() }),
          output: z.object({ synced: z.number() }),
          async handler({ updatedSince }, { crm }) {
            const deals = await crm.deals.list({ limit: 2, updatedSince });
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
      expect(calls).toEqual([
        { toolPath: "crm.deals.list", args: { limit: 2, updatedSince: undefined } },
      ]);
    }),
  );

  it.effect("passes fan-out integrations as arrays of proxies", () =>
    Effect.gen(function* () {
      const bundled = yield* bundle(`
        import { z } from "zod";
        import { defineTool, integration } from "executor:app";
        export default defineTool({
          description: "Fan out",
          integrations: { inboxes: integration("gmail").array() },
          input: z.object({ q: z.string() }),
          output: z.object({ seen: z.number() }),
          async handler({ q }, { inboxes }) {
            const batches = await Promise.all(inboxes.map((inbox) => inbox.messages.list({ q })));
            return { seen: batches.flat().length };
          },
        });
      `);
      const calls: unknown[] = [];
      const result = yield* makeInProcessAppToolExecutor().invoke(
        bundled.code,
        { toolName: "sync-deals" },
        {
          q: "unread",
          inboxes: ["tools.gmail.org.work", "tools.gmail.user.personal"],
        },
        {
          call: async (toolPath, args) => {
            calls.push({ toolPath, args });
            return toolPath.startsWith("inboxes#0.") ? [{ id: 1 }] : [{ id: 2 }, { id: 3 }];
          },
        },
        { timeoutMs: 1000 },
      );
      expect(result.output).toEqual({ seen: 3 });
      expect(calls).toEqual([
        { toolPath: "inboxes#0.messages.list", args: { q: "unread" } },
        { toolPath: "inboxes#1.messages.list", args: { q: "unread" } },
      ]);
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
      const error = yield* makeInProcessAppToolExecutor()
        .invoke(
          bundled.code,
          { toolName: "sync-deals" },
          { value: 1 },
          { call: async () => null },
          {
            timeoutMs: 1000,
          },
        )
        .pipe(Effect.flip);
      expect(error).toMatchObject({ message: expect.stringContaining("validation failed") });
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
      const error = yield* makeInProcessAppToolExecutor()
        .invoke(
          bundled.code,
          { toolName: "sync-deals" },
          {},
          { call: async () => null },
          {
            timeoutMs: 1,
          },
        )
        .pipe(Effect.flip);
      expect(error).toMatchObject({ message: expect.stringContaining("timed out") });
    }),
  );
});
