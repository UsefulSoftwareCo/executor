import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { AuthTemplateSlug, ConnectionName, IntegrationSlug, ToolName } from "./ids";
import { definePlugin } from "./plugin";
import { makeTestWorkspaceHarness, memoryCredentialsPlugin } from "./testing";

const INTEGRATION = IntegrationSlug.make("remote-sync-test");
const TEMPLATE = AuthTemplateSlug.make("none");

describe("stale connection tool sync", () => {
  it.effect("refreshes stale connections concurrently instead of serially", () =>
    Effect.gen(function* () {
      const starts: string[] = [];
      let firstObservation: number | null = null;
      let phase: "create" | "stale" = "create";

      const controlledPlugin = definePlugin(() => ({
        id: "remoteSyncTest" as const,
        remoteToolCatalog: true,
        storage: () => ({}),
        resolveTools: ({ connection }) =>
          Effect.gen(function* () {
            if (phase === "stale") {
              starts.push(String(connection.name));
              if (starts.length === 1) {
                yield* Effect.promise(
                  () => new Promise<void>((resolve) => setTimeout(resolve, 25)),
                );
                firstObservation = starts.length;
              }
            }
            return {
              tools: [
                {
                  name: ToolName.make(`inspect_${connection.name}`),
                  description: "inspect",
                },
              ],
            };
          }),
        extension: (ctx) => ({
          seed: () =>
            ctx.core.integrations.register({
              slug: INTEGRATION,
              description: "Remote sync test",
              config: {},
            }),
        }),
      }))();

      const { config, executor } = yield* makeTestWorkspaceHarness({
        plugins: [controlledPlugin, memoryCredentialsPlugin()] as const,
      });
      yield* executor.remoteSyncTest.seed();
      yield* executor.connections.create({
        owner: "org",
        integration: INTEGRATION,
        name: ConnectionName.make("alpha"),
        template: TEMPLATE,
        values: {},
      });
      yield* executor.connections.create({
        owner: "org",
        integration: INTEGRATION,
        name: ConnectionName.make("beta"),
        template: TEMPLATE,
        values: {},
      });

      phase = "stale";
      yield* Effect.promise(() =>
        config.db.updateMany("connection", {
          where: (b) => b("integration", "=", String(INTEGRATION)),
          set: {
            tools_synced_at: 0,
            tools_sync_failure_count: null,
            tools_sync_retry_after: null,
          },
        }),
      );

      const tools = yield* executor.tools.list({ integration: INTEGRATION, includeBlocked: true });
      expect(firstObservation).toBe(2);
      expect([...starts].sort()).toEqual(["alpha", "beta"]);
      expect(tools.map((tool) => String(tool.connection)).sort()).toEqual(["alpha", "beta"]);
    }),
  );

  it.effect("backs off incomplete syncs and resets after a successful refresh", () =>
    Effect.gen(function* () {
      const name = ConnectionName.make("main");
      let phase: "success" | "incomplete" = "success";
      let resolveCalls = 0;

      const controlledPlugin = definePlugin(() => ({
        id: "remoteSyncTest" as const,
        remoteToolCatalog: true,
        storage: () => ({}),
        resolveTools: ({ connection }) =>
          Effect.sync(() => {
            resolveCalls += 1;
            if (phase === "incomplete") {
              return { tools: [], incomplete: true };
            }
            return {
              tools: [
                {
                  name: ToolName.make(`inspect_${connection.name}`),
                  description: "inspect",
                },
              ],
            };
          }),
        extension: (ctx) => ({
          seed: () =>
            ctx.core.integrations.register({
              slug: INTEGRATION,
              description: "Remote sync test",
              config: {},
            }),
        }),
      }))();

      const { config, executor } = yield* makeTestWorkspaceHarness({
        plugins: [controlledPlugin, memoryCredentialsPlugin()] as const,
      });
      yield* executor.remoteSyncTest.seed();
      yield* executor.connections.create({
        owner: "org",
        integration: INTEGRATION,
        name,
        template: TEMPLATE,
        values: {},
      });

      resolveCalls = 0;
      phase = "incomplete";
      yield* Effect.promise(() =>
        config.db.updateMany("connection", {
          where: (b) => b("integration", "=", String(INTEGRATION)),
          set: {
            tools_synced_at: 0,
            tools_sync_failure_count: null,
            tools_sync_retry_after: null,
          },
        }),
      );

      yield* executor.tools.list({ integration: INTEGRATION, includeBlocked: true });
      expect(resolveCalls).toBe(1);

      const failedRow = yield* Effect.promise(() =>
        config.db.findFirst("connection", {
          where: (b) =>
            b.and(b("integration", "=", String(INTEGRATION)), b("name", "=", String(name))),
        }),
      );
      expect(Number(failedRow?.tools_sync_failure_count)).toBe(1);
      expect(Number(failedRow?.tools_sync_retry_after)).toBeGreaterThan(Date.now());

      phase = "success";
      yield* Effect.promise(() =>
        config.db.updateMany("connection", {
          where: (b) =>
            b.and(b("integration", "=", String(INTEGRATION)), b("name", "=", String(name))),
          set: { tools_synced_at: 0 },
        }),
      );
      yield* executor.tools.list({ integration: INTEGRATION, includeBlocked: true });
      expect(resolveCalls).toBe(1);

      yield* executor.connections.refresh({ owner: "org", integration: INTEGRATION, name });
      const refreshedRow = yield* Effect.promise(() =>
        config.db.findFirst("connection", {
          where: (b) =>
            b.and(b("integration", "=", String(INTEGRATION)), b("name", "=", String(name))),
        }),
      );
      expect(refreshedRow?.tools_sync_failure_count).toBeNull();
      expect(refreshedRow?.tools_sync_retry_after).toBeNull();
    }),
  );
});
