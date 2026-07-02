import { describe, expect, it } from "@effect/vitest";

import { createExecutor, ProviderItemId, ProviderKey, type CredentialProvider } from "./promise";
import { definePlugin, tool } from "./plugin";
import type { ToolDef } from "./tool";
import { IntegrationSlug, ToolName } from "./ids";
import { Effect, Schema } from "effect";

// A minimal static-tool plugin built on the Effect surface, consumed
// through the Promise façade. Exercises the proxy's ability to promisify
// nested methods (executor.execute) and plugin extensions.
//
// v2: static plugin tools are invoked by their fqid through `executor.execute`
// (the per-connection `tools.<int>.<owner>.<conn>.<tool>` catalog is separate).
const echoPlugin = definePlugin(() => ({
  id: "echo" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "echo.ctl",
      kind: "control" as const,
      name: "Echo Ctl",
      tools: [
        tool({
          name: "say",
          description: "Echo the input",
          inputSchema: Schema.toStandardSchemaV1(
            Schema.toStandardJSONSchemaV1(Schema.Struct({ message: Schema.String })),
          ),
          execute: (input) => Effect.succeed(input.message),
        }),
      ],
    },
  ],
  extension: () => ({
    greet: (name: string) => Effect.succeed(`hello, ${name}`) as Effect.Effect<string, never>,
  }),
}));

describe("promise/createExecutor", () => {
  it("returns Promise-shaped executor and invokes static tools", async () => {
    const plugins = [echoPlugin()] as const;
    const executor = await createExecutor({
      plugins,
      onElicitation: "accept-all",
    });

    const out = await executor.execute("echo.ctl.say", { message: "hi" });
    expect(out).toBe("hi");

    await executor.close();
  });

  it("promisifies plugin extension methods", async () => {
    const plugins = [echoPlugin()] as const;
    const executor = await createExecutor({
      plugins,
      onElicitation: "accept-all",
    });

    const greeting = await executor.echo.greet("world");
    expect(greeting).toBe("hello, world");

    await executor.close();
  });

  it("per-invoke onElicitation override wins over the executor-level default", async () => {
    // Build a tool that requires approval — the elicitation goes through
    // `enforceApproval` (outside wrapInvocationError), so a decline
    // surfaces as a typed `ElicitationDeclinedError` rather than a
    // wrapped invocation error.
    const approvedPlugin = definePlugin(() => ({
      id: "ap" as const,
      storage: () => ({}),
      staticSources: () => [
        {
          id: "ap.ctl",
          kind: "control" as const,
          name: "Ap Ctl",
          tools: [
            tool({
              name: "go",
              description: "Requires approval",
              annotations: { requiresApproval: true } as const,
              inputSchema: Schema.toStandardSchemaV1(
                Schema.toStandardJSONSchemaV1(Schema.Struct({})),
              ),
              execute: () => Effect.succeed("ran"),
            }),
          ],
        },
      ],
    }));

    const plugins = [approvedPlugin()] as const;
    const executor = await createExecutor({
      plugins,
      onElicitation: "accept-all", // default → auto-approve
    });

    // No override → executor-level accept-all → tool runs.
    const ran = await executor.execute("ap.ctl.go", {});
    expect(ran).toBe("ran");

    // Override with a declining handler -> rejects with ElicitationDeclinedError.
    await expect(
      executor.execute(
        "ap.ctl.go",
        {},
        {
          onElicitation: async () => ({ action: "decline" as const }),
        },
      ),
    ).rejects.toMatchObject({
      name: expect.stringMatching(/ElicitationDeclinedError/),
    });

    await executor.close();
  });

  it("threads config `providers` so inline connection values produce tools", async () => {
    // A plugin that registers an integration and produces two tools per
    // connection. The writable credential store is supplied via the Promise
    // façade's `providers` config (not the plugin) — proving createExecutor
    // threads `config.providers` into the Effect executor so the default
    // writable provider exists for `connections.create({ value })`.
    const inventoryPlugin = definePlugin(() => ({
      id: "inventory" as const,
      storage: () => ({}),
      resolveTools: () =>
        Effect.succeed({
          tools: [
            { name: ToolName.make("listItems"), description: "list" } satisfies ToolDef,
            { name: ToolName.make("getItem"), description: "get" } satisfies ToolDef,
          ],
        }),
      extension: (ctx) => ({
        seed: () =>
          ctx.core.integrations.register({
            slug: IntegrationSlug.make("inventory"),
            description: "Inventory API",
            config: {},
          }) as Effect.Effect<void, never>,
      }),
    }));

    const store = new Map<string, string>();
    const memoryProvider: CredentialProvider = {
      key: ProviderKey.make("memory"),
      writable: true,
      get: (id: ProviderItemId) => Effect.sync(() => store.get(String(id)) ?? null),
      set: (id: ProviderItemId, value: string) =>
        Effect.sync(() => {
          store.set(String(id), value);
        }),
    };

    const plugins = [inventoryPlugin()] as const;
    const executor = await createExecutor({
      plugins,
      providers: [memoryProvider],
      onElicitation: "accept-all",
    });

    await executor.inventory.seed();

    const connection = await executor.connections.create({
      owner: "org",
      name: "default",
      integration: "inventory",
      template: "apiKey",
      value: "inventory-api-key",
    });
    expect(String(connection.provider)).toBe("memory");
    // The inline value was written to the config-supplied provider.
    expect([...store.values()]).toContain("inventory-api-key");

    const tools = await executor.tools.list({ integration: "inventory" });
    expect(tools.map((t) => String(t.name)).sort()).toEqual(["getItem", "listItems"]);

    await executor.close();
  });
});
