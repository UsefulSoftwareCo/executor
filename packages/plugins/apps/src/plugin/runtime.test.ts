import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { makeSelfHostAppsRuntime } from "./self-host-runtime";
import { makeInMemoryAppsStore, makeTestResolver, dailyBriefFileSet } from "../testing";
import type { Bindings } from "./bindings";

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

const githubBindings: Bindings = { github: { kind: "single", connection: "rhys-github" } };

describe("AppsRuntime end-to-end (publish -> invoke)", () => {
  it("publishes daily-brief and invokes the tool into the scope db", async () => {
    const store = makeInMemoryAppsStore();
    const resolver = makeTestResolver(githubHandlers);
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
        args: {},
        bindings: githubBindings,
      }),
    )) as { synced: number; repos: number };
    expect(syncResult).toEqual({ synced: 2, repos: 1 });

    const db = await run(host.scopeDb.forScope("rhys"));
    const rows = await run(db.exec<{ n: number }>("SELECT COUNT(*) AS n FROM issues"));
    expect(Number(rows[0].n)).toBe(2);

    await host.close();
  });
});
