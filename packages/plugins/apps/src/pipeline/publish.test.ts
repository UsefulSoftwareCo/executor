import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { AppPublishConflictError, type AppsStore } from "../plugin/store";
import { makeInProcessAppToolExecutor } from "../executor/app-tool-executor";
import type { AppDescriptor } from "./descriptor";
import { discover } from "./discover";
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

const makeMemoryStore = (): AppsStore & {
  readonly rows: Map<string, unknown>;
  readonly blobs: Map<string, string>;
} => {
  const blobs = new Map<string, string>();
  const rows = new Map<string, unknown>();
  let descriptor: AppDescriptor | null = null;
  let descriptorKey: string | null = null;
  return {
    rows,
    blobs,
    putBlob: (body) =>
      Effect.sync(() => {
        const key = `blob:${body.length}:${blobs.size}`;
        blobs.set(key, body);
        return key;
      }),
    getBlob: (key) => Effect.sync(() => blobs.get(key) ?? null),
    getDescriptorRecord: () =>
      Effect.sync(() =>
        descriptor ? { sourceRef: descriptor.sourceRef, descriptorKey: descriptorKey ?? "" } : null,
      ),
    putPublished: (next, nextDescriptorKey, _owner, expectedSourceRef) =>
      Effect.gen(function* () {
        const actualSourceRef = descriptor?.sourceRef ?? null;
        if (actualSourceRef !== expectedSourceRef) {
          return yield* new AppPublishConflictError({
            app: next.app,
            expectedSourceRef,
            actualSourceRef,
          });
        }
        descriptor = next;
        descriptorKey = nextDescriptorKey;
        for (const key of rows.keys()) rows.delete(key);
        for (const item of next.tools) rows.set(item.name, item);
      }),
    removePublished: (app) =>
      Effect.sync(() => {
        if (descriptor?.app === app) {
          descriptor = null;
          descriptorKey = null;
        }
        for (const key of rows.keys()) rows.delete(key);
      }),
    listActiveTools: () =>
      Effect.sync(
        () => descriptor?.tools.map((tool) => ({ ...tool, app: descriptor?.app ?? "" })) ?? [],
      ),
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
    getToolForApp: (app, name) =>
      Effect.sync(() => {
        const row =
          descriptor?.app === app ? descriptor.tools.find((item) => item.name === name) : undefined;
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
    putSource: () => Effect.void,
    listSources: () => Effect.succeed([]),
    getSource: () => Effect.succeed(null),
    removeSource: () => Effect.void,
  };
};

const makeBarrierStore = () => {
  const store = makeMemoryStore();
  let reads = 0;
  let release: (() => void) | null = null;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    ...store,
    getDescriptorRecord: () =>
      Effect.promise(async () => {
        reads += 1;
        if (reads === 2) release?.();
        if (reads <= 2) await barrier;
        return null;
      }),
  } satisfies AppsStore & {
    readonly rows: Map<string, unknown>;
    readonly blobs: Map<string, string>;
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
    expect(result).toMatchObject({
      _tag: "PublishError",
      diagnostics: [{ path: "tools/readme.md" }],
    });
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
      expect(store.blobs.size).toBe(2);
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
      yield* publish(
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
      ).pipe(Effect.flip);
      expect(store.rows.size).toBe(0);
    }),
  );

  it.effect("leaves no rows or blobs when one tool fails collect", () =>
    Effect.gen(function* () {
      const store = makeMemoryStore();
      yield* publish(
        { store, executor: makeInProcessAppToolExecutor() },
        {
          app: "crm",
          sourceRef: "sha-1",
          files: [
            file("tools/ok.ts", tool("OK")),
            file(
              "tools/bad.ts",
              `
                import { z } from "zod";
                import { defineTool, integration } from "executor:app";
                export default defineTool({
                  description: "Bad",
                  integrations: { crm: { kind: "integration", slug: "dealcloud", mode: "bad" } },
                  input: z.object({}),
                  handler(input) { return input; },
                });
              `,
            ),
          ],
        },
      ).pipe(Effect.flip);
      expect(store.rows.size).toBe(0);
      expect(store.blobs.size).toBe(0);
    }),
  );

  it.effect("guards concurrent publishes for the same app", () =>
    Effect.gen(function* () {
      const store = makeBarrierStore();
      const results = yield* Effect.all(
        [
          publish(
            { store, executor: makeInProcessAppToolExecutor(), now: () => 1 },
            { app: "crm", sourceRef: "sha-a", files: [file("tools/a.ts", tool("A"))] },
          ).pipe(Effect.result),
          publish(
            { store, executor: makeInProcessAppToolExecutor(), now: () => 2 },
            { app: "crm", sourceRef: "sha-b", files: [file("tools/b.ts", tool("B"))] },
          ).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      const successes = results.filter(Result.isSuccess);
      const failures = results.filter(Result.isFailure);
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect([...store.rows.keys()]).toHaveLength(1);
    }),
  );
});
