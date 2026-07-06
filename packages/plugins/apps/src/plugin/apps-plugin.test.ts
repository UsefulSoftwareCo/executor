import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { appsPlugin, connectionNameForScope } from "./apps-plugin";
import { makeSelfHostAppsRuntime } from "./self-host-runtime";
import { makeInMemoryAppsStore, makeTestResolver } from "../testing";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const PROTOTYPE_ROOT = "/Users/rhyssullivan/agent-workspace/prototypes/custom-tools";

const prototypeFileSet = (): Map<string, string> =>
  new Map<string, string>([
    ["executor.json", readFileSync(join(PROTOTYPE_ROOT, "executor.json"), "utf8")],
    [
      "tools/deal-pipeline-sync.ts",
      readFileSync(join(PROTOTYPE_ROOT, "tools/deal-pipeline-sync.ts"), "utf8"),
    ],
    [
      "tools/find-deal-docs.ts",
      readFileSync(join(PROTOTYPE_ROOT, "tools/find-deal-docs.ts"), "utf8"),
    ],
  ]);

describe("appsPlugin custom-tools contract", () => {
  it("round-trips prototype files through publish, resolveTools, and invokeTool", async () => {
    let dealListArgs: unknown;
    const resolver = makeTestResolver(
      {
        dealcloud: {
          "deals.list": (args) => {
            dealListArgs = args[0];
            return [];
          },
        },
        "microsoft-sharepoint": {
          "search.query": () => [],
        },
      },
      [
        {
          address: "tools.dealcloud.user.crm-main",
          integration: "dealcloud",
          name: "crm-main",
        },
        {
          address: "tools.microsoft-sharepoint.user.sharepoint-main",
          integration: "microsoft-sharepoint",
          name: "sharepoint-main",
        },
      ],
    );
    const host = makeSelfHostAppsRuntime({
      dataDir: mkdtempSync(join(tmpdir(), "apps-plugin-")),
      store: makeInMemoryAppsStore(),
      resolver,
      inMemory: true,
    });
    const runtime = host.runtime;
    const plugin = appsPlugin({ runtime });
    const appConnection = connectionNameForScope("rhys");

    await run(runtime.publish({ scope: "rhys", files: prototypeFileSet() }));

    const resolved = await run(
      plugin.resolveTools!({
        connection: { name: appConnection },
      } as never),
    );
    const syncTool = resolved.tools.find((tool) => String(tool.name) === "deal-pipeline-sync");
    expect(syncTool).toBeTruthy();
    const inputSchema = syncTool!.inputSchema as {
      properties: Record<string, { enum?: string[]; default?: string; description?: string }>;
      required?: string[];
    };
    expect(inputSchema.properties.crm.enum).toEqual(["tools.dealcloud.user.crm-main"]);
    expect(inputSchema.properties.crm.default).toBe("tools.dealcloud.user.crm-main");
    expect(inputSchema.properties.crm.description).toBe("Connection to use for crm (dealcloud)");
    expect(inputSchema.required ?? []).not.toContain("crm");

    const output = await run(
      plugin.invokeTool!({
        ctx: {},
        toolRow: {
          name: "deal-pipeline-sync",
          connection: appConnection,
        },
        args: {
          crm: "tools.dealcloud.user.crm-main",
          updatedSince: "2026-01-01T00:00:00Z",
        },
      } as never),
    );

    expect(output).toEqual({ synced: 0 });
    expect(dealListArgs).toEqual({
      status: "active",
      updatedSince: "2026-01-01T00:00:00Z",
      pageSize: 200,
    });
    await host.close();
  });
});
