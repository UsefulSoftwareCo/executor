import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { makeSelfHostAppsRuntime } from "./self-host-runtime";
import { makeInMemoryAppsStore, makeTestResolver, dailyBriefFileSet } from "../testing";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const githubHandlers = {
  github: {
    "repos.listForAuthenticatedUser": () => [{ full_name: "acme/app" }],
    "issues.listForRepo": () => [
      {
        number: 1,
        title: "Fresh bug",
        labels: [{ name: "bug" }],
        assignee: { login: "rhys" },
        updated_at: new Date().toISOString(),
        html_url: "https://github.com/acme/app/issues/1",
      },
      {
        number: 2,
        title: "Old bug",
        labels: [],
        assignee: null,
        updated_at: "2020-01-01T00:00:00Z",
        html_url: "https://github.com/acme/app/issues/2",
      },
    ],
  },
};

describe("AppsRuntime end-to-end (publish -> invoke)", () => {
  it("publishes daily-brief and invokes the tool into the scope db", async () => {
    const store = makeInMemoryAppsStore();
    const resolver = makeTestResolver(githubHandlers, [
      { address: "tools.github.user.rhys-github", integration: "github", name: "rhys-github" },
    ]);
    const host = makeSelfHostAppsRuntime({
      dataDir: mkdtempSync(join(tmpdir(), "apps-rt-")),
      store,
      resolver,
      inMemory: true,
    });
    const { runtime } = host;

    const published = await run(runtime.publish({ scope: "rhys", files: dailyBriefFileSet() }));
    expect(published.descriptor.tools.map((t) => t.name).sort()).toEqual([
      "issues-sync",
      "search-all-mail",
    ]);

    const syncResult = (await run(
      runtime.invokeTool({
        scope: "rhys",
        tool: "issues-sync",
        args: { github: "tools.github.user.rhys-github" },
      }),
    )) as { synced: number; repos: number };
    expect(syncResult).toEqual({ synced: 2, repos: 1 });

    const db = await run(host.scopeDb.forScope("rhys"));
    const rows = await run(db.exec<{ n: number }>("SELECT COUNT(*) AS n FROM issues"));
    expect(Number(rows[0].n)).toBe(2);

    await host.close();
  });

  it("applies the single available connection as the default", async () => {
    const store = makeInMemoryAppsStore();
    const resolver = makeTestResolver(
      {
        dealcloud: {
          "deals.list": () => [],
        },
      },
      [{ address: "tools.dealcloud.user.crm-main", integration: "dealcloud", name: "crm-main" }],
    );
    const host = makeSelfHostAppsRuntime({
      dataDir: mkdtempSync(join(tmpdir(), "apps-default-")),
      store,
      resolver,
      inMemory: true,
    });

    await run(
      host.runtime.publish({
        scope: "s",
        files: new Map([
          [
            "tools/sync.ts",
            `import { defineTool, integration } from "executor:app";
import { z } from "zod";
export default defineTool({
  description: "sync",
  integrations: { crm: integration("dealcloud") },
  input: z.object({}),
  async handler(_input, { crm }) {
    await crm.deals.list({});
    return { ok: true };
  },
});`,
          ],
        ]),
      }),
    );

    const out = await run(host.runtime.invokeTool({ scope: "s", tool: "sync", args: {} }));

    expect(out).toEqual({ ok: true });
    expect(resolver.calls[0]).toEqual({
      integration: "dealcloud",
      connection: "tools.dealcloud.user.crm-main",
      method: "deals.list",
    });
    await host.close();
  });

  it("fails with BindingError when multiple connections exist and the role property is missing", async () => {
    const store = makeInMemoryAppsStore();
    const resolver = makeTestResolver({}, [
      { address: "tools.dealcloud.user.one", integration: "dealcloud" },
      { address: "tools.dealcloud.user.two", integration: "dealcloud" },
    ]);
    const host = makeSelfHostAppsRuntime({
      dataDir: mkdtempSync(join(tmpdir(), "apps-missing-")),
      store,
      resolver,
      inMemory: true,
    });

    await run(
      host.runtime.publish({
        scope: "s",
        files: new Map([
          [
            "tools/sync.ts",
            `import { defineTool, integration } from "executor:app";
import { z } from "zod";
export default defineTool({
  description: "sync",
  integrations: { crm: integration("dealcloud") },
  input: z.object({}),
  async handler(){ return {}; },
});`,
          ],
        ]),
      }),
    );

    const exit = await Effect.runPromiseExit(
      host.runtime.invokeTool({ scope: "s", tool: "sync", args: {} }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") throw new Error("expected missing connection failure");
    expect(JSON.stringify(exit.cause)).toContain("BindingError");
    expect(JSON.stringify(exit.cause)).toContain("crm");
    expect(JSON.stringify(exit.cause)).toContain("dealcloud");
    await host.close();
  });

  it("fails with BindingError when the named connection belongs to another integration", async () => {
    const store = makeInMemoryAppsStore();
    const resolver = makeTestResolver({}, [
      { address: "tools.github.user.main", integration: "github" },
    ]);
    const host = makeSelfHostAppsRuntime({
      dataDir: mkdtempSync(join(tmpdir(), "apps-wrong-")),
      store,
      resolver,
      inMemory: true,
    });

    await run(
      host.runtime.publish({
        scope: "s",
        files: new Map([
          [
            "tools/sync.ts",
            `import { defineTool, integration } from "executor:app";
import { z } from "zod";
export default defineTool({
  description: "sync",
  integrations: { crm: integration("dealcloud") },
  input: z.object({}),
  async handler(){ return {}; },
});`,
          ],
        ]),
      }),
    );

    const exit = await Effect.runPromiseExit(
      host.runtime.invokeTool({
        scope: "s",
        tool: "sync",
        args: { crm: "tools.github.user.main" },
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") throw new Error("expected wrong integration failure");
    expect(JSON.stringify(exit.cause)).toContain("BindingError");
    expect(JSON.stringify(exit.cause)).toContain("github");
    expect(JSON.stringify(exit.cause)).toContain("dealcloud");
    expect(JSON.stringify(exit.cause)).toContain("tools.github.user.main");
    await host.close();
  });

  it("accepts raw JSON Schema input end to end", async () => {
    const store = makeInMemoryAppsStore();
    const resolver = makeTestResolver({});
    const host = makeSelfHostAppsRuntime({
      dataDir: mkdtempSync(join(tmpdir(), "apps-raw-")),
      store,
      resolver,
      inMemory: true,
    });

    await run(
      host.runtime.publish({
        scope: "s",
        files: new Map([
          [
            "tools/raw.ts",
            `import { defineTool } from "executor:app";
export default defineTool({
  description: "raw",
  input: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  async handler(input){ return { q: input.q }; },
});`,
          ],
        ]),
      }),
    );

    const out = await run(host.runtime.invokeTool({ scope: "s", tool: "raw", args: { q: "ok" } }));

    expect(out).toEqual({ q: "ok" });
    await host.close();
  });
});
