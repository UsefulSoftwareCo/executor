import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  BindingError,
  buildBridge,
  resolveIntegrationBindings,
  type ClientResolver,
} from "./bindings";

const resolver: ClientResolver = {
  listConnections: ({ integration }) =>
    Effect.succeed([{ integration, address: `tools.${integration}.org.main` }]),
  resolveConnection: ({ connection }) =>
    Effect.succeed(
      connection === "tools.dealcloud.org.main"
        ? { integration: "dealcloud", address: connection }
        : connection === "tools.github.org.main"
          ? { integration: "github", address: connection }
          : null,
    ),
  call: ({ path, args }) => Effect.succeed({ path, args }),
};

describe("integration bindings", () => {
  it.effect("resolves caller-supplied connection addresses", () =>
    Effect.gen(function* () {
      const result = yield* resolveIntegrationBindings(
        { crm: { slug: "dealcloud" } },
        { crm: "tools.dealcloud.org.main", updatedSince: "today" },
        resolver,
      );
      expect(result).toEqual({
        input: { updatedSince: "today" },
        bindings: { crm: "tools.dealcloud.org.main" },
      });
    }),
  );

  it.effect("fails unknown connection addresses as BindingError", () =>
    Effect.gen(function* () {
      const exit = yield* resolveIntegrationBindings(
        { crm: { slug: "dealcloud" } },
        { crm: "tools.dealcloud.org.missing" },
        resolver,
      ).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") expect(String(exit.cause)).toContain("BindingError");
    }),
  );

  it.effect("fails mismatched connection integrations as BindingError", () =>
    Effect.gen(function* () {
      const exit = yield* resolveIntegrationBindings(
        { crm: { slug: "dealcloud" } },
        { crm: "tools.github.org.main" },
        resolver,
      ).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") expect(String(exit.cause)).toContain('not "dealcloud"');
    }),
  );

  it("bridges method calls to the resolver", async () => {
    const bridge = buildBridge({
      declared: { crm: { slug: "dealcloud" } },
      bindings: { crm: "tools.dealcloud.org.main" },
      resolver,
    });
    await expect(bridge.call("crm.deals.list", { limit: 1 })).resolves.toEqual({
      path: ["deals", "list"],
      args: { limit: 1 },
    });
  });

  it("rejects undeclared bridge calls", async () => {
    const bridge = buildBridge({
      declared: { crm: { slug: "dealcloud" } },
      bindings: { crm: "tools.dealcloud.org.main" },
      resolver,
    });
    await expect(bridge.call("github.repos.get", {})).rejects.toBeInstanceOf(BindingError);
  });
});
