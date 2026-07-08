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
            integrations: { crm: { slug: "dealcloud", mode: "one" } },
          },
        ]);
      }),
    );

    it.effect("collects Standard Schema input JSON schema extensions", () =>
      Effect.gen(function* () {
        const bundled = yield* bundle(`
          import { z } from "zod";
          import { defineTool } from "executor:app";
          export default defineTool({
            description: "Zod schema",
            input: z.object({ name: z.string(), count: z.number().optional() }),
            handler(input) { return input; },
          });
        `);
        const collected = yield* makeExecutor().collect(bundled.code, {
          fileSlug: "conformance",
          sourcePath: "tools/conformance.ts",
        });
        const inputSchema = collected.tools[0]?.inputSchema as {
          readonly properties?: Record<string, { readonly type?: string }>;
          readonly required?: readonly string[];
        };
        expect(inputSchema.properties?.name).toMatchObject({ type: "string" });
        expect(inputSchema.properties?.count).toBeDefined();
        expect(inputSchema.required ?? []).toContain("name");
        expect(inputSchema.required ?? []).not.toContain("count");
        expect(inputSchema).not.toHaveProperty("$schema");
      }),
    );

    it.effect("rejects integration keys that collide with Standard Schema input fields", () =>
      Effect.gen(function* () {
        const bundled = yield* bundle(`
          import { z } from "zod";
          import { defineTool, integration } from "executor:app";
          export default defineTool({
            description: "Collision",
            integrations: { crm: integration("dealcloud") },
            input: z.object({ crm: z.string() }),
            handler(input) { return input; },
          });
        `);
        const error = yield* makeExecutor()
          .collect(bundled.code, {
            fileSlug: "conformance",
            sourcePath: "tools/conformance.ts",
          })
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          kind: "collect",
          message: expect.stringContaining('integration key "crm" collides with input field'),
          diagnostics: [
            {
              path: "tools/conformance.ts",
              message: "integration key collides with input: crm",
            },
          ],
        });
      }),
    );

    it.effect("rejects Standard Schema libraries without JSON schema extensions", () =>
      Effect.gen(function* () {
        const bundled = yield* bundle(`
          import { defineTool } from "executor:app";
          const input = {
            "~standard": {
              vendor: "fake",
              version: 1,
              validate(value) { return { value }; },
            },
          };
          export default defineTool({
            description: "Missing JSON schema extension",
            input,
            handler(value) { return value; },
          });
        `);
        const error = yield* makeExecutor()
          .collect(bundled.code, {
            fileSlug: "conformance",
            sourcePath: "tools/conformance.ts",
          })
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          kind: "collect",
          message: expect.stringContaining(
            "schema library does not expose the Standard Schema jsonSchema extension",
          ),
          diagnostics: [
            {
              path: "tools/conformance.ts",
              message:
                "input schema library does not expose the Standard Schema jsonSchema extension",
            },
          ],
        });
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
  });
};
