import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { makeGitArtifactStore } from "../backing/git-artifact-store";
import { makeQuickjsToolSandbox } from "../backing/quickjs-tool-sandbox";
import { scopeAddress } from "../seams/scope-address";
import { dailyBriefFileSet } from "../testing/daily-brief";
import { FLOW_ENTRIES_KEY, GUIDE_ENTRIES_KEY } from "./descriptor";
import { publish, PUBLISH_LIMITS } from "./publish";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const makeDeps = () => ({
  artifactStore: makeGitArtifactStore({ root: mkdtempSync(join(tmpdir(), "apps-pub-")) }),
  sandbox: makeQuickjsToolSandbox(),
});

describe("publish pipeline (discover -> bundle -> collect -> project)", () => {
  it("compiles the daily-brief set into a descriptor", async () => {
    const deps = makeDeps();
    const out = await run(publish(deps, { scope: "rhys", files: dailyBriefFileSet() }));

    expect(out.snapshotId).toBeTruthy();
    const d = out.descriptor;
    expect(d.scope).toBe("rhys");
    expect(d.snapshotId).toBe(out.snapshotId);

    const toolNames = d.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual(["issues-sync", "search-all-mail"]);
    expect(d[FLOW_ENTRIES_KEY]).toEqual([]);
    expect(d.ui).toEqual([]);
    expect(d[GUIDE_ENTRIES_KEY]).toEqual([]);
    expect(out.skipped).toEqual([]);

    const sync = d.tools.find((t) => t.name === "issues-sync")!;
    expect(sync.integrations.github).toEqual(expect.objectContaining({ integration: "github" }));
    expect((sync.inputSchema as { type: string }).type).toBe("object");

    const mail = d.tools.find((t) => t.name === "search-all-mail")!;
    expect(mail.integrations.inbox).toEqual(expect.objectContaining({ integration: "gmail" }));
  });

  it("publishes tools while reporting deferred known folders under skipped", async () => {
    const deps = makeDeps();
    const flowPath = "workflows/y.ts";
    const guidePath = "skills/z/SKILL.md";
    const files = new Map<string, string>([
      [
        "tools/x.ts",
        `import { defineTool } from "executor:app";
import { z } from "zod";
export default defineTool({ description: "x", input: z.object({}), async handler(){ return { ok: true }; } });`,
      ],
      [flowPath, "export default {};"],
      [guidePath, "# z"],
    ]);

    const out = await run(publish(deps, { scope: "s", files }));

    expect(out.descriptor.tools.map((t) => t.name)).toEqual(["x"]);
    expect(out.descriptor[FLOW_ENTRIES_KEY]).toEqual([]);
    expect(out.descriptor.ui).toEqual([]);
    expect(out.descriptor[GUIDE_ENTRIES_KEY]).toEqual([]);
    expect(out.skipped).toEqual([
      { path: flowPath, reason: "not supported yet" },
      { path: guidePath, reason: "not supported yet" },
    ]);
  });

  it("rejects an authored input field that collides with an integration role", async () => {
    const deps = makeDeps();
    const files = new Map<string, string>([
      [
        "tools/sync.ts",
        `import { defineTool, integration } from "executor:app";
import { z } from "zod";
export default defineTool({
  description: "sync",
  integrations: { crm: integration("dealcloud") },
  input: z.object({ crm: z.string() }),
  async handler(){ return {}; },
});`,
      ],
    ]);

    const exit = await Effect.runPromiseExit(publish(deps, { scope: "s", files }));

    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("collides");
    expect(JSON.stringify(exit)).toContain("crm");
  });

  it("rejects a Standard Schema vendor without JSON Schema export", async () => {
    const deps = makeDeps();
    const files = new Map<string, string>([
      [
        "tools/vendor.ts",
        `import { defineTool } from "executor:app";
const schema = {
  "~standard": {
    version: 1,
    vendor: "vendor-without-json-schema",
    validate(value) { return { value }; },
  },
};
export default defineTool({
  description: "vendor",
  input: schema,
  async handler(input){ return input; },
});`,
      ],
    ]);

    const exit = await Effect.runPromiseExit(publish(deps, { scope: "s", files }));

    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("vendor-without-json-schema");
    expect(JSON.stringify(exit)).toContain("vendor");
    expect(JSON.stringify(exit)).toContain("input");
  });

  it("accepts raw JSON Schema input", async () => {
    const deps = makeDeps();
    const files = new Map<string, string>([
      [
        "tools/raw.ts",
        `import { defineTool } from "executor:app";
export default defineTool({
  description: "raw",
  input: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  async handler(input){ return input; },
});`,
      ],
    ]);

    const out = await run(publish(deps, { scope: "s", files }));

    expect(out.descriptor.tools[0].inputSchema).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    });
  });

  it("rejects a bare npm import (npm deps out of scope)", async () => {
    const deps = makeDeps();
    const files = new Map([
      [
        "tools/bad.ts",
        `import { defineTool } from "executor:app";\nimport { chunk } from "lodash";\nimport { z } from "zod";\nexport default defineTool({ description: "b", input: z.object({}), async handler(){ return chunk([1,2,3], 2); } });`,
      ],
    ]);
    const exit = await Effect.runPromiseExit(publish(deps, { scope: "s", files }));
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("bundle");
    }
  });

  it("rejects an oversized publish set (too many files) and persists nothing", async () => {
    const deps = makeDeps();
    const files = new Map<string, string>();
    for (let i = 0; i < PUBLISH_LIMITS.maxFiles + 5; i++) {
      files.set(`tools/t${i}.ts`, "// noop");
    }
    const exit = await Effect.runPromiseExit(publish(deps, { scope: "s", files }));
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("exceeding the limit");
    const latest = await run(
      Effect.flatMap(deps.artifactStore.forScope(scopeAddress("org", "s")), (s) => s.latest()),
    );
    expect(latest).toBeNull();
  });

  it("rejects a single file over the per-file byte limit", async () => {
    const deps = makeDeps();
    const big = "x".repeat(PUBLISH_LIMITS.maxFileBytes + 1);
    const files = new Map([["tools/big.ts", big]]);
    const exit = await Effect.runPromiseExit(publish(deps, { scope: "s", files }));
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("per-file limit");
  });

  it("rejects a set over the total byte limit", async () => {
    const deps = makeDeps();
    const half = "y".repeat(Math.floor(PUBLISH_LIMITS.maxFileBytes));
    const files = new Map<string, string>();
    const count = Math.ceil(PUBLISH_LIMITS.maxTotalBytes / PUBLISH_LIMITS.maxFileBytes) + 1;
    for (let i = 0; i < count; i++) files.set(`tools/t${i}.ts`, half);
    const exit = await Effect.runPromiseExit(publish(deps, { scope: "s", files }));
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("total limit");
  });
});
