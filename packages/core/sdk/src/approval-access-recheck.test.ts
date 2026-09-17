import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref, Schema } from "effect";

import { ElicitationResponse } from "./elicitation";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug, ToolAddress, ToolName } from "./ids";
import { definePlugin, tool } from "./plugin";
import { makeTestExecutor, memoryCredentialsPlugin } from "./testing";
import { testAccess } from "@executor-js/product-access/testing";

const integration = IntegrationSlug.make("approvalcheck");
const connection = ConnectionName.make("main");
const staticAddress = ToolAddress.make("approvalcheck.control.run");
const dynamicAddress = ToolAddress.make("tools.approvalcheck.org.main.run");

const setup = Effect.gen(function* () {
  const invocations = yield* Ref.make(0);
  const recordInvocation = Ref.update(invocations, (count) => count + 1).pipe(
    Effect.as("executed"),
  );
  const plugin = definePlugin(() => ({
    id: "approval-check" as const,
    storage: () => ({}),
    staticIntegrations: () => [
      {
        id: "approvalcheck.control",
        kind: "control" as const,
        name: "Approval check",
        tools: [
          tool({
            name: "run",
            description: "Record an invocation after approval.",
            annotations: { requiresApproval: true },
            inputSchema: Schema.toStandardSchemaV1(
              Schema.toStandardJSONSchemaV1(Schema.Struct({})),
            ),
            execute: () => recordInvocation,
          }),
        ],
      },
    ],
    resolveTools: () =>
      Effect.succeed({
        tools: [
          {
            name: ToolName.make("run"),
            description: "Record an invocation after approval.",
            annotations: { requiresApproval: true },
          },
        ],
      }),
    invokeTool: () => recordInvocation,
    extension: (ctx) => ({
      register: () =>
        ctx.core.integrations.register({
          slug: integration,
          description: "Approval check",
          config: {},
        }),
    }),
  }));
  const executor = yield* makeTestExecutor({
    access: testAccess.member(),
    plugins: [plugin(), memoryCredentialsPlugin()] as const,
  });
  yield* executor["approval-check"].register();
  yield* executor.connections.create({
    owner: "org",
    integration,
    name: connection,
    template: AuthTemplateSlug.make("none"),
    value: "synthetic-approval-test-key",
  });
  return { executor, invocations };
});

describe("access changes while approval is pending", () => {
  for (const address of [staticAddress, dynamicAddress]) {
    it.effect(`blocks ${address} if policy changes before acceptance`, () =>
      Effect.gen(function* () {
        const { executor, invocations } = yield* setup;
        const error = yield* Effect.flip(
          executor.execute(
            address,
            {},
            {
              onElicitation: () =>
                executor.policies
                  .create({ owner: "org", pattern: "approvalcheck.*", action: "block" })
                  .pipe(Effect.orDie, Effect.as(ElicitationResponse.make({ action: "accept" }))),
            },
          ),
        );
        expect(error).toMatchObject({ _tag: "ToolBlockedError" });
        expect(yield* Ref.get(invocations)).toBe(0);
      }),
    );
  }

  it.effect("does not invoke a connection disconnected before acceptance", () =>
    Effect.gen(function* () {
      const { executor, invocations } = yield* setup;
      const error = yield* Effect.flip(
        executor.execute(
          dynamicAddress,
          {},
          {
            onElicitation: () =>
              executor.connections
                .remove({ owner: "org", integration, name: connection })
                .pipe(Effect.orDie, Effect.as(ElicitationResponse.make({ action: "accept" }))),
          },
        ),
      );
      expect(error).toMatchObject({ _tag: "ToolNotFoundError" });
      expect(yield* Ref.get(invocations)).toBe(0);
    }),
  );

  it.effect("accepts once when access stays valid", () =>
    Effect.gen(function* () {
      const { executor, invocations } = yield* setup;
      const approvals = yield* Ref.make(0);
      const result = yield* executor.execute(
        dynamicAddress,
        {},
        {
          onElicitation: () =>
            Ref.update(approvals, (count) => count + 1).pipe(
              Effect.as(ElicitationResponse.make({ action: "accept" })),
            ),
        },
      );
      expect(result).toBe("executed");
      expect(yield* Ref.get(invocations)).toBe(1);
      expect(yield* Ref.get(approvals)).toBe(1);
    }),
  );
});
