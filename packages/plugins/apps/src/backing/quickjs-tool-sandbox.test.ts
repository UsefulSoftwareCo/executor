import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { bundleEntry } from "../pipeline/bundle";
import { makeQuickjsToolSandbox } from "./quickjs-tool-sandbox";
import { ISSUES_SYNC_TS, SEARCH_ALL_MAIL_TS } from "../testing/daily-brief";
import type { HandleBridge } from "../seams/tool-sandbox";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

describe("QuickJS ToolSandbox", () => {
  const sandbox = makeQuickjsToolSandbox();

  it("bundles + collects a tool descriptor (deterministic)", async () => {
    const files = new Map([["tools/issues-sync.ts", ISSUES_SYNC_TS]]);
    const { code } = await run(bundleEntry({ files, entry: "tools/issues-sync.ts" }));
    const result = await run(sandbox.collect(code));
    const descriptor = result.artifacts.default.descriptor as {
      kind: string;
      connections: Record<string, { decl: string; integration: string }>;
      inputJsonSchema: { type: string; properties: Record<string, unknown> };
      hasHandler: boolean;
    };
    expect(descriptor.kind).toBe("tool");
    expect(descriptor.connections.github).toEqual(
      expect.objectContaining({ decl: "single", integration: "github" }),
    );
    expect(descriptor.hasHandler).toBe(true);
    expect(descriptor.inputJsonSchema.type).toBe("object");
    expect(descriptor.inputJsonSchema.properties).toHaveProperty("repos");
    expect(descriptor.inputJsonSchema.properties).toHaveProperty("since");
  });

  it("collects a fan-out (connections) declaration", async () => {
    const files = new Map([["tools/search-all-mail.ts", SEARCH_ALL_MAIL_TS]]);
    const { code } = await run(bundleEntry({ files, entry: "tools/search-all-mail.ts" }));
    const result = await run(sandbox.collect(code));
    const descriptor = result.artifacts.default.descriptor as {
      connections: Record<string, { decl: string; integration: string }>;
    };
    expect(descriptor.connections.inboxes).toEqual(
      expect.objectContaining({ decl: "array", integration: "gmail" }),
    );
  });

  it("invokes a tool, routing injected-client + db calls through the bridge", async () => {
    const files = new Map([["tools/issues-sync.ts", ISSUES_SYNC_TS]]);
    const { code } = await run(bundleEntry({ files, entry: "tools/issues-sync.ts" }));

    const calls: { root: string; path: readonly string[]; args: readonly unknown[] }[] = [];
    const bridge: HandleBridge = {
      call: ({ root, path, args }) =>
        Effect.sync(() => {
          calls.push({ root, path, args });
          const key = `${root}.${path.join(".")}`;
          if (key === "github.repos.listForAuthenticatedUser") {
            return [{ full_name: "acme/app" }];
          }
          if (key === "github.issues.listForRepo") {
            return [
              {
                number: 1,
                title: "Bug",
                labels: [{ name: "bug" }],
                assignee: { login: "rhys" },
                updated_at: "2026-01-01T00:00:00Z",
                html_url: "https://github.com/acme/app/issues/1",
              },
            ];
          }
          // db.sql calls return empty rows
          return [];
        }),
    };

    const result = await run(
      sandbox.invoke(
        code,
        {
          artifact: "issues-sync",
          kind: "tool",
          input: {},
          roots: { github: { kind: "single" }, db: { kind: "single" } },
        },
        bridge,
      ),
    );

    expect(result.output).toEqual({ synced: 1, repos: 1 });
    // The db write went through the bridge (root "db").
    expect(calls.some((c) => c.root === "db")).toBe(true);
    expect(calls.some((c) => c.root === "github")).toBe(true);
  });

  it("rejects a non-deterministic descriptor (Math.random at describe time)", async () => {
    const nondeterministic = `import { defineTool } from "executor:app";
import { z } from "zod";
export default defineTool({
  description: "x-" + Math.random(),
  input: z.object({}),
  async handler() { return {}; },
});`;
    const files = new Map([["tools/rng.ts", nondeterministic]]);
    const { code } = await run(bundleEntry({ files, entry: "tools/rng.ts" }));
    const exit = await Effect.runPromiseExit(sandbox.collect(code));
    expect(exit._tag).toBe("Failure");
  });

  it("denies network (fetch throws in the sandbox)", async () => {
    const usesFetch = `import { defineTool } from "executor:app";
import { z } from "zod";
export default defineTool({
  description: "fetches",
  input: z.object({}),
  async handler() { await fetch("https://example.com"); return {}; },
});`;
    const files = new Map([["tools/net.ts", usesFetch]]);
    const { code } = await run(bundleEntry({ files, entry: "tools/net.ts" }));
    const bridge: HandleBridge = { call: () => Effect.succeed(null) };
    const exit = await Effect.runPromiseExit(
      sandbox.invoke(code, { artifact: "net", kind: "tool", input: {}, roots: {} }, bridge),
    );
    expect(exit._tag).toBe("Failure");
  });
});
