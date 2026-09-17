import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref } from "effect";

import { ElicitationResponse } from "./elicitation";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug, ToolAddress, ToolName } from "./ids";
import { definePlugin } from "./plugin";
import { makeTestExecutor, memoryCredentialsPlugin } from "./testing";
import { testAccess } from "@executor-js/product-access/testing";

// ---------------------------------------------------------------------------
// Regression: the plugin RUNTIME bound before an approval pause must never
// invoke a REPLACEMENT tool row. If the integration is torn down and
// re-registered under a different plugin while the call waits on a human,
// the tool the user approved no longer exists in that form — the resumed
// call fails as not-found instead of handing the new row (and the new
// connection's credential) to the old plugin's handler.
// ---------------------------------------------------------------------------

const integration = IntegrationSlug.make("swapcheck");
const connection = ConnectionName.make("main");
const address = ToolAddress.make("tools.swapcheck.org.main.run");

describe("integration replaced under a different plugin during approval", () => {
  it.effect("fails as not-found; neither plugin's handler runs", () =>
    Effect.gen(function* () {
      const oldInvocations = yield* Ref.make(0);
      const newInvocations = yield* Ref.make(0);

      const makeCatalogPlugin = (id: "swap-old" | "swap-new", invocations: Ref.Ref<number>) =>
        definePlugin(() => ({
          id,
          storage: () => ({}),
          resolveTools: () =>
            Effect.succeed({
              tools: [
                {
                  name: ToolName.make("run"),
                  description: "Run after approval.",
                  annotations: { requiresApproval: true },
                },
              ],
            }),
          invokeTool: () => Ref.update(invocations, (count) => count + 1).pipe(Effect.as("ran")),
          extension: (ctx) => ({
            register: () =>
              ctx.core.integrations.register({
                slug: integration,
                description: `registered by ${id}`,
                config: {},
              }),
          }),
        }))();

      const executor = yield* makeTestExecutor({
        access: testAccess.member(),
        plugins: [
          makeCatalogPlugin("swap-old", oldInvocations),
          makeCatalogPlugin("swap-new", newInvocations),
          memoryCredentialsPlugin(),
        ] as const,
      });
      yield* executor["swap-old"].register();
      const createConnection = executor.connections.create({
        owner: "org",
        integration,
        name: connection,
        template: AuthTemplateSlug.make("none"),
        value: "synthetic-swap-test-key",
      });
      yield* createConnection;

      const swapPlugins = Effect.gen(function* () {
        // Tear the integration down (cascading its connection and tool rows)
        // and re-register the SAME slug under the other plugin, with a fresh
        // connection producing a same-named tool row owned by `swap-new`.
        yield* executor.integrations.remove(integration);
        yield* executor["swap-new"].register();
        yield* createConnection;
        return ElicitationResponse.make({ action: "accept" });
      }).pipe(Effect.orDie);

      const error = yield* Effect.flip(
        executor.execute(address, {}, { onElicitation: () => swapPlugins }),
      );
      expect(error).toMatchObject({ _tag: "ToolNotFoundError" });
      expect(yield* Ref.get(oldInvocations)).toBe(0);
      expect(yield* Ref.get(newInvocations)).toBe(0);
    }),
  );
});
