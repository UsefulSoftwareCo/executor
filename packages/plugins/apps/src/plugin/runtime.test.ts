import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { makeSelfHostAppsRuntime } from "./self-host-runtime";
import { makeInMemoryAppsStore, makeTestResolver, dailyBriefFileSet } from "../testing";
import type { Bindings } from "./bindings";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

// A GitHub resolver returning two open issues, one stale.
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

describe("AppsRuntime end-to-end (publish -> invoke -> workflow)", () => {
  it("publishes daily-brief, invokes the tool into the scope db, runs the workflow", async () => {
    const store = makeInMemoryAppsStore();
    const resolver = makeTestResolver(githubHandlers);
    const host = makeSelfHostAppsRuntime({
      dataDir: mkdtempSync(join(tmpdir(), "apps-rt-")),
      store,
      resolver,
      inMemory: true,
    });
    const { runtime } = host;

    // --- publish ----------------------------------------------------------
    const published = await run(runtime.publish({ scope: "rhys", files: dailyBriefFileSet() }));
    expect(published.descriptor.tools.map((t) => t.name).sort()).toEqual([
      "issues-sync",
      "search-all-mail",
    ]);

    // --- invoke the tool: writes the scope `issues` table -----------------
    const syncResult = (await run(
      runtime.invokeTool({
        scope: "rhys",
        tool: "issues-sync",
        args: {},
        bindings: githubBindings,
      }),
    )) as { synced: number; repos: number };
    expect(syncResult).toEqual({ synced: 2, repos: 1 });

    // The scope db now has the two issues.
    const db = await run(host.scopeDb.forScope("rhys"));
    const rows = await run(db.exec<{ n: number }>("SELECT COUNT(*) AS n FROM issues"));
    expect(Number(rows[0].n)).toBe(2);

    // --- run the workflow: syncs again + flags the stale issue ------------
    const runView = await run(
      runtime.startWorkflow({
        scope: "rhys",
        workflow: "morning-sync",
        input: {},
        bindings: githubBindings,
        runId: "morning-1",
      }),
    );
    expect(runView.status).toBe("completed");
    expect(runView.output).toEqual({ synced: 2, stale: 1 });

    // Journal has the step.tool call and the find-stale step.
    const steps = await run(runtime.listSteps("morning-1"));
    const names = steps.map((s) => s.name);
    expect(names).toContain("tool:issues-sync");
    expect(names).toContain("find-stale");
    expect(steps.every((s) => s.status === "completed")).toBe(true);

    await host.close();
  });
});
