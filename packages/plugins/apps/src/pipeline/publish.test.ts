import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { AppsStore } from "../plugin/store";
import { makeInProcessAppToolExecutor } from "../executor/app-tool-executor";
import type { AppDescriptor } from "./descriptor";
import { discover, PublishError } from "./discover";
import { publish } from "./publish";

const encoder = new TextEncoder();

const file = (path: string, body: string) => ({ path, bytes: encoder.encode(body) });

const tool = (description = "Tool") => `
  import { z } from "zod";
  import { defineTool } from "executor:app";
  export default defineTool({
    description: ${JSON.stringify(description)},
    input: z.object({ value: z.string() }),
    handler(input) { return input; },
  });
`;

const makeMemoryStore = (): AppsStore & { readonly rows: Map<string, unknown> } => {
  const blobs = new Map<string, string>();
  const rows = new Map<string, unknown>();
  let descriptor: AppDescriptor | null = null;
  return {
    rows,
    putBlob: (body) =>
      Effect.sync(() => {
        const key = `blob:${body.length}:${blobs.size}`;
        blobs.set(key, body);
        return key;
      }),
    getBlob: (key) => Effect.sync(() => blobs.get(key) ?? null),
    getDescriptorRecord: () =>
      Effect.sync(() =>
        descriptor
          ? { sourceRef: descriptor.sourceRef, descriptorKey: descriptor.descriptorKey }
          : null,
      ),
    putPublished: (next) =>
      Effect.sync(() => {
        descriptor = next;
        for (const item of next.tools) rows.set(item.name, item);
      }),
    listActiveTools: () => Effect.sync(() => descriptor?.tools ?? []),
    getTool: (name) =>
      Effect.sync(() => {
        const row = descriptor?.tools.find((item) => item.name === name);
        return row
          ? {
              app: descriptor!.app,
              name: row.name,
              bundleKey: row.bundleKey,
              description: row.description,
              inputSchema: row.inputSchema,
              outputSchema: row.outputSchema,
              integrations: row.integrations,
              annotations: row.annotations,
            }
          : null;
      }),
  };
};

describe("discover", () => {
  it("reports non-tool files under tools and reserved folders", () => {
    const result = discover(
      new Map([
        ["tools/readme.md", ""],
        ["workflows/a.ts", ""],
        ["ui/panel.tsx", ""],
        ["skills/guide.md", ""],
      ]),
    );
    expect(result).toBeInstanceOf(PublishError);
    if (!(result instanceof PublishError)) return;
    expect(result.diagnostics[0]?.path).toBe("tools/readme.md");
  });
});

describe("publish", () => {
  it.effect("publishes tools from an in-memory file set", () =>
    Effect.gen(function* () {
      const store = makeMemoryStore();
      const result = yield* publish(
        { store, executor: makeInProcessAppToolExecutor(), now: () => 10 },
        {
          app: "crm",
          sourceRef: "sha-1",
          files: [file("tools/sync.ts", tool()), file("workflows/later.ts", "")],
        },
      );
      expect(result.publishedTools).toEqual(["sync"]);
      expect(result.skipped).toEqual([{ path: "workflows/later.ts", reason: "not supported yet" }]);
      expect(result.descriptor.toolchain.executor.name).toBe("in-process-data-url");
    }),
  );

  it.effect("treats identical sourceRef as a no-op", () =>
    Effect.gen(function* () {
      const store = makeMemoryStore();
      const input = {
        app: "crm",
        sourceRef: "sha-1",
        files: [file("tools/sync.ts", tool())],
      };
      yield* publish({ store, executor: makeInProcessAppToolExecutor() }, input);
      const second = yield* publish({ store, executor: makeInProcessAppToolExecutor() }, input);
      expect(second.noop).toBe(true);
      expect(second.publishedTools).toEqual([]);
    }),
  );

  it.effect("rejects nondeterministic factories", () =>
    Effect.gen(function* () {
      const store = makeMemoryStore();
      const exit = yield* publish(
        { store, executor: makeInProcessAppToolExecutor() },
        {
          app: "crm",
          sourceRef: "sha-1",
          files: [
            file(
              "tools/sync.ts",
              `
                import { z } from "zod";
                import { defineTool } from "executor:app";
                export default () => ({
                  [String(Math.random()).slice(2)]: defineTool({
                    description: "Random",
                    input: z.object({}),
                    handler() { return {}; },
                  }),
                });
              `,
            ),
          ],
        },
      ).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      expect(store.rows.size).toBe(0);
    }),
  );
});
