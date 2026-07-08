import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { buildBridge, resolveIntegrationBindings, type ClientResolver } from "./bindings";

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

const one = (slug: string) => ({ slug, mode: "one" as const, all: false });
const many = (slug: string) => ({ slug, mode: "many" as const, all: false });

describe("integration bindings", () => {
  it.effect("resolves caller-supplied connection addresses", () =>
    Effect.gen(function* () {
      const result = yield* resolveIntegrationBindings(
        { crm: one("dealcloud") },
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
      const error = yield* resolveIntegrationBindings(
        { crm: one("dealcloud") },
        { crm: "tools.dealcloud.org.missing" },
        resolver,
      ).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "BindingError" });
    }),
  );

  it.effect("fails mismatched connection integrations as BindingError", () =>
    Effect.gen(function* () {
      const error = yield* resolveIntegrationBindings(
        { crm: one("dealcloud") },
        { crm: "tools.github.org.main" },
        resolver,
      ).pipe(Effect.flip);
      expect(error).toMatchObject({ message: expect.stringContaining('not "dealcloud"') });
    }),
  );

  it("bridges method calls to the resolver", async () => {
    const bridge = buildBridge({
      declared: { crm: one("dealcloud") },
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
      declared: { crm: one("dealcloud") },
      bindings: { crm: "tools.dealcloud.org.main" },
      resolver,
    });
    await expect(bridge.call("github.repos.get", {})).rejects.toMatchObject({
      _tag: "BindingError",
    });
  });

  it("routes fan-out bridge calls to the indexed connection", async () => {
    const calls: unknown[] = [];
    const bridge = buildBridge({
      declared: { inboxes: many("gmail") },
      bindings: { inboxes: ["tools.gmail.org.work", "tools.gmail.user.personal"] },
      resolver: {
        ...resolver,
        call: (input) =>
          Effect.sync(() => {
            calls.push(input);
            return { ok: true };
          }),
      },
    });
    await expect(bridge.call("inboxes#1.messages.list", { q: "unread" })).resolves.toEqual({
      ok: true,
    });
    expect(calls).toMatchObject([
      {
        integration: "gmail",
        connection: "tools.gmail.user.personal",
        path: ["messages", "list"],
        args: { q: "unread" },
      },
    ]);
  });

  it.effect("resolves arrays of connection addresses for fan-out", () =>
    Effect.gen(function* () {
      const result = yield* resolveIntegrationBindings(
        { inboxes: many("gmail") },
        { inboxes: ["tools.gmail.org.work", "tools.gmail.user.personal"], q: "unread" },
        {
          ...resolver,
          resolveConnection: ({ connection }) =>
            Effect.succeed(
              connection.startsWith("tools.gmail.")
                ? { integration: "gmail", address: connection }
                : null,
            ),
        },
      );
      expect(result).toEqual({
        input: { q: "unread" },
        bindings: { inboxes: ["tools.gmail.org.work", "tools.gmail.user.personal"] },
      });
    }),
  );
});
