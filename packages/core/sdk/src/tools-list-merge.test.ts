import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { AuthTemplateSlug, ConnectionName, IntegrationSlug, ToolName } from "./ids";
import { definePlugin } from "./plugin";
import { makeTestExecutor, memoryCredentialsPlugin } from "./testing";

// ---------------------------------------------------------------------------
// Cross-owner merge regression (the "Axiom shows 0 tools" bug).
//
// Verified ground truth: omitting `owner` from `tools.list` / `connections.list`
// short-circuits the executor's owner WHERE clause to `true`
// (`executor.ts:1779` connections, `:1881` tools), so org (`subject=""`) + user
// (`subject=<user>`) rows return together. These tests pin that behavior:
//   - a user-only fixture (zero org rows) lists ALL tools/connections when owner
//     is omitted (the fix);
//   - the same fixture lists ZERO under `owner: "org"` (proving the OLD default
//     hid them — the exact failure where N user tools showed 0 under owner=org).
//
// The new React atoms (`toolsAllAtom`, `integrationToolsAllAtom`,
// `connectionsAllAtom`) drive the merge purely by omitting `owner`; no executor
// or core/api change is required, which is what these tests guard.
// ---------------------------------------------------------------------------

const INTEG = IntegrationSlug.make("axiom");
const TEMPLATE = AuthTemplateSlug.make("apiKey");

// Three tools per connection — mirrors the real "N user tools showed 0" shape.
const demoPlugin = definePlugin(() => ({
  id: "demo" as const,
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({
      tools: [
        { name: ToolName.make("query"), description: "query" },
        { name: ToolName.make("ingest"), description: "ingest" },
        { name: ToolName.make("datasets"), description: "datasets" },
      ],
    }),
  // `invokeTool`/`extension` param types are supplied by `definePlugin`'s
  // generics; annotating them over-constrains the inferred shape (the canonical
  // `connections.test.ts` relies on the same inference).
  invokeTool: ({ toolRow, credential }) =>
    Effect.succeed({ ran: toolRow.name, value: credential.value }),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: INTEG,
        description: "Axiom",
        config: {},
      }),
  }),
}))();

// Default test executor binds `subject: "test-subject"`, so user-owned
// connections/tools can be created and merge with org rows.
const setup = () =>
  makeTestExecutor({ plugins: [memoryCredentialsPlugin(), demoPlugin] as const }).pipe(
    Effect.tap((executor) => executor.demo.seed()),
  );

describe("tools.list cross-owner merge", () => {
  it.effect("lists user-owned tools when owner is omitted (the fix)", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      yield* executor.connections.create({
        owner: "user",
        name: ConnectionName.make("personal"),
        integration: INTEG,
        template: TEMPLATE,
        value: "user-token",
      });

      // Omit owner → all user rows return even with zero org rows.
      const merged = yield* executor.tools.list({});
      expect(merged.map((t) => String(t.name)).sort()).toEqual(["datasets", "ingest", "query"]);
      // Each row retains its true owner — the React layer groups/badges on this.
      expect(merged.every((t) => t.owner === "user")).toBe(true);
    }),
  );

  it.effect("owner=org hides the user-only fixture (the old default bug)", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      yield* executor.connections.create({
        owner: "user",
        name: ConnectionName.make("personal"),
        integration: INTEG,
        template: TEMPLATE,
        value: "user-token",
      });

      // The OLD owner-scoped default (`owner: "org"`) returned 0 — the bug.
      const orgScoped = yield* executor.tools.list({ owner: "org" });
      expect(orgScoped).toEqual([]);

      // Explicit owner=user still works as a narrow filter.
      const userScoped = yield* executor.tools.list({ owner: "user" });
      expect(userScoped.length).toBe(3);
    }),
  );

  it.effect("merges org + user tools, each tagged with its own owner", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("workspace"),
        integration: INTEG,
        template: TEMPLATE,
        value: "org-token",
      });
      yield* executor.connections.create({
        owner: "user",
        name: ConnectionName.make("personal"),
        integration: INTEG,
        template: TEMPLATE,
        value: "user-token",
      });

      const merged = yield* executor.tools.list({});
      // 3 tools per connection × 2 connections = 6 rows.
      expect(merged.length).toBe(6);
      expect(merged.filter((t) => t.owner === "org").length).toBe(3);
      expect(merged.filter((t) => t.owner === "user").length).toBe(3);
      // The same tool name appears under each connection (NOT deduped at the
      // data layer) — the React account-grouped view relies on this.
      expect(merged.filter((t) => String(t.name) === "query").length).toBe(2);
    }),
  );

  it.effect("integration filter without owner merges both owners' tools", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("workspace"),
        integration: INTEG,
        template: TEMPLATE,
        value: "org-token",
      });
      yield* executor.connections.create({
        owner: "user",
        name: ConnectionName.make("personal"),
        integration: INTEG,
        template: TEMPLATE,
        value: "user-token",
      });

      // Mirrors `integrationToolsAllAtom(slug)`: integration filter, no owner.
      const merged = yield* executor.tools.list({ integration: INTEG });
      expect(merged.length).toBe(6);
      const owners = new Set(merged.map((t) => t.owner));
      expect(owners).toEqual(new Set(["org", "user"]));
    }),
  );
});

describe("connections.list cross-owner merge", () => {
  it.effect("lists a user-only connection when owner is omitted (the fix)", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      yield* executor.connections.create({
        owner: "user",
        name: ConnectionName.make("personal"),
        integration: INTEG,
        template: TEMPLATE,
        value: "user-token",
      });

      const merged = yield* executor.connections.list({});
      expect(merged.map((c) => String(c.name))).toEqual(["personal"]);
      expect(merged.every((c) => c.owner === "user")).toBe(true);

      // The old owner-scoped default hid it.
      const orgScoped = yield* executor.connections.list({ owner: "org" });
      expect(orgScoped).toEqual([]);
    }),
  );

  it.effect("merges org + user connections, each tagged with its own owner", () =>
    Effect.gen(function* () {
      const executor = yield* setup();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("workspace"),
        integration: INTEG,
        template: TEMPLATE,
        value: "org-token",
      });
      yield* executor.connections.create({
        owner: "user",
        name: ConnectionName.make("personal"),
        integration: INTEG,
        template: TEMPLATE,
        value: "user-token",
      });

      const merged = yield* executor.connections.list({});
      expect(merged.length).toBe(2);
      const owners = new Set(merged.map((c) => c.owner));
      expect(owners).toEqual(new Set(["org", "user"]));
    }),
  );
});
