import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { IntegrationSlug } from "@executor-js/sdk";
import { makeTestExecutor } from "@executor-js/sdk/testing";

import { appsPlugin } from "./apps-plugin";
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
  it.effect("detects GitHub repo URLs for console auto-detect", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({ plugins: [appsPlugin()] as const });

      const repo = yield* executor.integrations.detect(
        "https://github.com/RhysSullivan/executor-custom-tools-demo",
      );
      const tree = yield* executor.integrations.detect(
        "https://github.com/RhysSullivan/executor-custom-tools-demo/tree/feature/custom-tools",
      );
      const commit = yield* executor.integrations.detect(
        "https://github.com/RhysSullivan/executor-custom-tools-demo/commit/abc1234",
      );

      expect(repo).toEqual([
        {
          kind: "apps",
          confidence: "high",
          endpoint: "https://github.com/RhysSullivan/executor-custom-tools-demo",
          name: "Add custom tools from RhysSullivan/executor-custom-tools-demo",
          slug: "executor-custom-tools-demo",
        },
      ]);
      expect(tree[0]?.endpoint).toBe(
        "https://github.com/RhysSullivan/executor-custom-tools-demo/tree/feature/custom-tools",
      );
      expect(commit[0]?.endpoint).toBe(
        "https://github.com/RhysSullivan/executor-custom-tools-demo/commit/abc1234",
      );
    }),
  );

  it.effect("leaves non-repo GitHub URLs unclaimed by custom tools detection", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({ plugins: [appsPlugin()] as const });

      const gist = yield* executor.integrations.detect(
        "https://gist.github.com/RhysSullivan/abc1234",
      );
      const file = yield* executor.integrations.detect(
        "https://github.com/RhysSullivan/executor-custom-tools-demo/blob/main/openapi.json",
      );

      expect(gist).toEqual([]);
      expect(file).toEqual([]);
    }),
  );

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
    const plugin = appsPlugin({ backings: host.backings });
    const appIntegration = IntegrationSlug.make("rhys-tools");
    const appConfig = {
      kind: "github",
      repoUrl: "https://github.com/rhys/tools",
      repo: "rhys/tools",
      scope: "rhys",
    };
    const ctx = {
      owner: { tenant: "org" },
      core: {
        integrations: {
          get: (slug: IntegrationSlug) =>
            Effect.succeed(
              String(slug) === String(appIntegration)
                ? {
                    slug: appIntegration,
                    name: "Rhys tools",
                    description: "Rhys tools",
                    kind: "apps",
                    canRemove: true,
                    canRefresh: false,
                    authMethods: [],
                    config: appConfig,
                  }
                : null,
            ),
        },
      },
    };

    await run(runtime.publish({ scope: "rhys", files: prototypeFileSet() }));

    const resolved = await run(
      plugin.resolveTools!({
        ctx,
        config: appConfig,
        connection: { name: "main" },
      } as never),
    );
    const syncTool = resolved.tools.find((tool) => String(tool.name) === "deal-pipeline-sync");
    expect(syncTool).toBeTruthy();
    const persistedInputSchema = syncTool!.inputSchema as {
      properties: Record<string, unknown>;
    };
    expect(persistedInputSchema.properties.crm).toBeUndefined();

    const projected = await run(
      plugin.projectToolSchema!({
        ctx,
        toolRow: {
          name: "deal-pipeline-sync",
          integration: appIntegration,
          connection: "main",
        },
        inputSchema: syncTool!.inputSchema,
        outputSchema: syncTool!.outputSchema,
      } as never),
    );
    const inputSchema = projected.inputSchema as {
      properties: Record<string, { enum?: string[]; default?: string; description?: string }>;
      required?: string[];
    };
    expect(inputSchema.properties.crm.enum).toEqual(["tools.dealcloud.user.crm-main"]);
    expect(inputSchema.properties.crm.default).toBe("tools.dealcloud.user.crm-main");
    expect(inputSchema.properties.crm.description).toBe("Connection to use for crm (dealcloud)");
    expect(inputSchema.required ?? []).not.toContain("crm");

    const output = await run(
      plugin.invokeTool!({
        ctx,
        toolRow: {
          name: "deal-pipeline-sync",
          integration: appIntegration,
          connection: "main",
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
