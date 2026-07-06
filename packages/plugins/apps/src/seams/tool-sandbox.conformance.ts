import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import type { HandleBridge, ToolSandbox } from "./tool-sandbox";
import { bundleEntry } from "../pipeline/bundle";

// ---------------------------------------------------------------------------
// ToolSandbox conformance suite. Runs against the interface. Covers:
//   - collect determinism catches Math.random (double-run byte-compare)
//   - network denial (fetch throws)
//   - timeout kill (an infinite loop is interrupted)
//   - handle bridge round-trip for declared integration roles
// A future Worker Loaders backing must pass this same suite.
// ---------------------------------------------------------------------------

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const bundle = (entry: string, source: string): Promise<string> =>
  run(bundleEntry({ files: new Map([[entry, source]]), entry })).then((b) => b.code);

export const toolSandboxConformance = (name: string, makeSandbox: () => ToolSandbox): void => {
  describe(`ToolSandbox conformance: ${name}`, () => {
    it("collects deterministically and rejects Math.random at describe time", async () => {
      const sandbox = makeSandbox();
      const stable = `import { defineTool } from "executor:app";
import { z } from "zod";
export default defineTool({ description: "stable", input: z.object({ a: z.string() }), async handler(){ return {}; } });`;
      const stableBundle = await bundle("tools/s.ts", stable);
      const res = await run(sandbox.collect(stableBundle));
      expect(res.artifacts.default.descriptor).toBeTruthy();

      const rng = `import { defineTool } from "executor:app";
import { z } from "zod";
export default defineTool({ description: "x" + Math.random(), input: z.object({}), async handler(){ return {}; } });`;
      const rngBundle = await bundle("tools/rng.ts", rng);
      const exit = await Effect.runPromiseExit(sandbox.collect(rngBundle));
      expect(exit._tag).toBe("Failure");
    });

    it("denies network access", async () => {
      const sandbox = makeSandbox();
      const src = `import { defineTool } from "executor:app";
import { z } from "zod";
export default defineTool({ description: "net", input: z.object({}), async handler(){ await fetch("https://x.test"); return {}; } });`;
      const b = await bundle("tools/net.ts", src);
      const bridge: HandleBridge = { call: () => Effect.succeed(null) };
      const exit = await Effect.runPromiseExit(
        sandbox.invoke(b, { artifact: "net", kind: "tool", input: {}, roots: {} }, bridge),
      );
      expect(exit._tag).toBe("Failure");
    });

    it("kills a runaway handler on timeout", async () => {
      const sandbox = makeSandbox();
      const src = `import { defineTool } from "executor:app";
import { z } from "zod";
export default defineTool({ description: "loop", input: z.object({}), async handler(){ while (true) {} } });`;
      const b = await bundle("tools/loop.ts", src);
      const bridge: HandleBridge = { call: () => Effect.succeed(null) };
      const exit = await Effect.runPromiseExit(
        sandbox.invoke(b, { artifact: "loop", kind: "tool", input: {}, roots: {} }, bridge),
      );
      expect(exit._tag).toBe("Failure");
    });

    it("round-trips the handle bridge for a declared integration role", async () => {
      const sandbox = makeSandbox();
      const src = `import { defineTool, integration } from "executor:app";
import { z } from "zod";
export default defineTool({
  description: "search",
  integrations: { inbox: integration("gmail") },
  input: z.object({ q: z.string() }),
  async handler({ q }, { inbox }) {
    const r = await inbox.messages.search({ q });
    return { total: r.count };
  },
});`;
      const b = await bundle("tools/search.ts", src);

      const seen: { root: string; path: readonly string[]; args: readonly unknown[] }[] = [];
      const bridge: HandleBridge = {
        call: ({ root, path, args }) =>
          Effect.sync(() => {
            seen.push({ root, path, args });
            return { count: 3 };
          }),
      };

      const result = await run(
        sandbox.invoke(
          b,
          {
            artifact: "search",
            kind: "tool",
            input: { q: "invoice" },
            roots: { inbox: { kind: "single" } },
          },
          bridge,
        ),
      );
      expect(result.output).toEqual({ total: 3 });
      const roots = new Set(seen.map((s) => s.root));
      expect(roots.has("inbox")).toBe(true);
      // The method path and JSON args crossed the boundary intact.
      expect(seen[0].path).toEqual(["messages", "search"]);
      expect(seen[0].args[0]).toMatchObject({ q: "invoice" });
    });

    // --- richer assertions grafted from build A ---------------------------

    it("round-trips a db.sql write with its parameters intact", async () => {
      const sandbox = makeSandbox();
      // A tool with a github client AND a db.sql write, asserting BOTH the
      // connection call and the parameterized db statement cross the bridge with
      // their args intact (the db.sql param round-trip A's suite covers).
      const src = `import { defineTool, integration } from "executor:app";
import { z } from "zod";
export default defineTool({
  description: "bridge",
  integrations: { gh: integration("github") },
  input: z.object({}),
  async handler(_i, { gh, db }) {
    const repos = await gh.repos.listForAuthenticatedUser({ per_page: 5 });
    await db.sql\`INSERT INTO log (n) VALUES (\${repos.length})\`;
    return { count: repos.length };
  },
});`;
      const b = await bundle("tools/bridge.ts", src);
      const calls: { root: string; path: readonly string[]; args: readonly unknown[] }[] = [];
      const bridge: HandleBridge = {
        call: ({ root, path, args }) =>
          Effect.sync(() => {
            calls.push({ root, path, args });
            if (root === "gh" && path.join(".") === "repos.listForAuthenticatedUser") {
              return [{ full_name: "a/b" }, { full_name: "c/d" }];
            }
            return [];
          }),
      };
      const result = await run(
        sandbox.invoke(
          b,
          {
            artifact: "bridge",
            kind: "tool",
            input: {},
            roots: { gh: { kind: "single" }, db: { kind: "single" } },
          },
          bridge,
        ),
      );
      expect(result.output).toEqual({ count: 2 });
      // The github call crossed the bridge.
      expect(calls.some((c) => c.root === "gh")).toBe(true);
      // The db.sql write crossed as ["sql"] with the template strings + the
      // interpolated parameter (2) intact.
      const dbCall = calls.find((c) => c.root === "db");
      expect(dbCall?.path).toEqual(["sql"]);
      const [strings, ...params] = dbCall!.args as [readonly string[], ...unknown[]];
      expect(strings.join("?")).toContain("INSERT INTO log");
      expect(params).toEqual([2]);
    });
  });
};
