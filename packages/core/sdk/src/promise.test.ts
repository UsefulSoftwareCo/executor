import { describe, expect, it } from "@effect/vitest";

import { createExecutor } from "./promise";
import { definePlugin, defineSchema, tool } from "./plugin";
import { Effect, Schema } from "effect";

// A minimal static-tool plugin built on the Effect surface, consumed
// through the Promise façade. Exercises the proxy's ability to promisify
// nested methods (executor.tools.*) and plugin extensions.
const echoPlugin = definePlugin(() => ({
  id: "echo" as const,
  schema: defineSchema({}),
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
    const executor = await createExecutor({
      plugins: [echoPlugin()] as const,
      onElicitation: "accept-all",
    });

    const tools = await executor.tools.list();
    expect(tools.map((t) => t.id)).toContain("echo.ctl.say");

    const out = await executor.tools.invoke("echo.ctl.say", { message: "hi" });
    expect(out).toBe("hi");

    await executor.close();
  });

  it("promisifies plugin extension methods", async () => {
    const executor = await createExecutor({
      plugins: [echoPlugin()] as const,
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
      schema: defineSchema({}),
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

    const executor = await createExecutor({
      plugins: [approvedPlugin()] as const,
      onElicitation: "accept-all", // default → auto-approve
    });

    // No override → executor-level accept-all → tool runs.
    const ran = await executor.tools.invoke("ap.ctl.go", {});
    expect(ran).toBe("ran");

    // Override with a declining handler -> rejects with ElicitationDeclinedError.
    // Effect.runPromise rejects with a FiberFailure that carries the tag in
    // the error name.
    await expect(
      executor.tools.invoke(
        "ap.ctl.go",
        {},
        {
          onElicitation: () => Effect.succeed({ action: "decline" as const }) as any,
        },
      ),
    ).rejects.toMatchObject({
      name: expect.stringMatching(/ElicitationDeclinedError/),
    });

    await executor.close();
  });
});
