import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { bundleEntry } from "../pipeline/bundle";
import type { AppToolExecutor } from "../executor/app-tool-executor";

const bundle = (source: string) =>
  bundleEntry({
    files: new Map([["tools/conformance.ts", source]]),
    entry: "tools/conformance.ts",
  });

export const appToolExecutorConformance = (
  name: string,
  makeExecutor: () => AppToolExecutor,
): void => {
  describe(`${name} app tool executor conformance`, () => {
    it.effect("collects descriptors deterministically", () =>
      Effect.gen(function* () {
        const bundled = yield* bundle(`
          import { z } from "zod";
          import { defineTool, integration } from "executor:app";
          export default defineTool({
            description: "Conformance",
            integrations: { crm: integration("dealcloud") },
            input: z.object({ value: z.string() }),
            output: z.object({ ok: z.boolean() }),
            handler() { return { ok: true }; },
          });
        `);
        const collected = yield* makeExecutor().collect(bundled.code, {
          fileSlug: "conformance",
          sourcePath: "tools/conformance.ts",
        });
        expect(collected.tools).toMatchObject([
          {
            toolName: "conformance",
            integrations: { crm: { slug: "dealcloud", mode: "one", all: false } },
          },
        ]);
      }),
    );

    it.effect("invokes handlers with split input and integrations", () =>
      Effect.gen(function* () {
        const bundled = yield* bundle(`
          import { z } from "zod";
          import { defineTool, integration } from "executor:app";
          export default defineTool({
            description: "Conformance invoke",
            integrations: { crm: integration("dealcloud") },
            input: z.object({ value: z.string() }),
            output: z.object({ result: z.string() }),
            async handler({ value }, { crm }) {
              const response = await crm.echo({ value });
              return { result: response.value };
            },
          });
        `);
        const output = yield* makeExecutor().invoke(
          bundled.code,
          { toolName: "conformance" },
          { crm: "tools.dealcloud.org.main", value: "ok" },
          { call: async (_path, args) => args },
          { timeoutMs: 1000 },
        );
        expect(output.output).toEqual({ result: "ok" });
      }),
    );

    it.effect("invokes all-bound handlers with fan-out integration proxies", () =>
      Effect.gen(function* () {
        const bundled = yield* bundle(`
          import { z } from "zod";
          import { defineTool, integration } from "executor:app";
          export default defineTool({
            description: "Conformance all invoke",
            integrations: { inboxes: integration("gmail").array().all() },
            input: z.object({ query: z.string() }),
            output: z.object({ count: z.number() }),
            async handler({ query }, { inboxes }) {
              const batches = await Promise.all(
                inboxes.map((inbox) => inbox.messages.list({ query })),
              );
              return { count: batches.flat().length };
            },
          });
        `);
        const calls: unknown[] = [];
        const output = yield* makeExecutor().invoke(
          bundled.code,
          { toolName: "conformance" },
          {
            query: "invoice",
            inboxes: [
              "tools.gmail.org.work",
              "tools.gmail.user.personal",
              "tools.gmail.org.shared",
            ],
          },
          {
            call: async (toolPath, args) => {
              calls.push({ toolPath, args });
              return [{ id: toolPath }];
            },
          },
          { timeoutMs: 1000 },
        );
        expect(output.output).toEqual({ count: 3 });
        expect(calls).toEqual([
          { toolPath: "inboxes#0.messages.list", args: { query: "invoice" } },
          { toolPath: "inboxes#1.messages.list", args: { query: "invoice" } },
          { toolPath: "inboxes#2.messages.list", args: { query: "invoice" } },
        ]);
      }),
    );
  });
};
