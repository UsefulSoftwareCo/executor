import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  ToolName,
} from "./ids";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { makeTestExecutor } from "./testing";

// ---------------------------------------------------------------------------
// executor.accessGroups — the management engine. CRUD, idempotent membership,
// and the service-layer referential-integrity rules (no restricting to a
// missing group, no deleting a referenced group; this schema has no FKs).
// Enforcement semantics live in access-group-enforcement.test.ts.
// ---------------------------------------------------------------------------

const memoryProvider = (): CredentialProvider => {
  const store = new Map<string, string>();
  return {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
  };
};

const VERCEL = IntegrationSlug.make("vercel");
const TEMPLATE = AuthTemplateSlug.make("apiKey");
const CONN = ConnectionName.make("main");

const groupsTestPlugin = definePlugin(() => ({
  id: "gtest" as const,
  storage: () => ({}),
  credentialProviders: [memoryProvider()],
  resolveTools: () =>
    Effect.succeed({ tools: [{ name: ToolName.make("deploy"), description: "deploy" }] }),
  invokeTool: ({ toolRow }) => Effect.succeed({ ran: `${toolRow.integration}.${toolRow.name}` }),
  extension: (ctx) => ({
    seed: () => ctx.core.integrations.register({ slug: VERCEL, description: "Vercel", config: {} }),
  }),
}));

const setupExecutor = () =>
  makeTestExecutor({ plugins: [groupsTestPlugin()] as const }).pipe(
    Effect.tap((executor) =>
      Effect.gen(function* () {
        yield* executor.gtest.seed();
        yield* executor.connections.create({
          owner: "org",
          name: CONN,
          integration: VERCEL,
          template: TEMPLATE,
          from: { provider: ProviderKey.make("memory"), id: ProviderItemId.make("v") },
        });
      }),
    ),
  );

describe("executor.accessGroups", () => {
  it.effect("creates, lists, and renames groups", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      expect(yield* executor.accessGroups.list()).toEqual([]);

      const finance = yield* executor.accessGroups.create({ name: "finance-leads" });
      const ops = yield* executor.accessGroups.create({ name: "ops" });
      expect(finance.name).toBe("finance-leads");
      expect(finance.id).toMatch(/^grp_/);

      const listed = yield* executor.accessGroups.list();
      expect(listed.map((group) => group.name)).toEqual(["finance-leads", "ops"]);

      const renamed = yield* executor.accessGroups.update({ id: ops.id, name: "ops-leads" });
      expect(renamed.name).toBe("ops-leads");
      expect((yield* executor.accessGroups.list()).map((group) => group.name)).toEqual([
        "finance-leads",
        "ops-leads",
      ]);
    }),
  );

  it.effect("rejects empty group names on create and rename", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      const createError = yield* Effect.flip(executor.accessGroups.create({ name: "   " }));
      expect(Predicate.isTagged("StorageError")(createError)).toBe(true);

      const group = yield* executor.accessGroups.create({ name: "finance" });
      const renameError = yield* Effect.flip(
        executor.accessGroups.update({ id: group.id, name: "" }),
      );
      expect(Predicate.isTagged("StorageError")(renameError)).toBe(true);
    }),
  );

  it.effect("fails renaming or reading members of a missing group", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      const updateError = yield* Effect.flip(
        executor.accessGroups.update({ id: "grp_missing", name: "x" }),
      );
      expect(Predicate.isTagged("StorageError")(updateError)).toBe(true);
      const membersError = yield* Effect.flip(executor.accessGroups.members("grp_missing"));
      expect(Predicate.isTagged("StorageError")(membersError)).toBe(true);
    }),
  );

  it.effect("membership add is idempotent; remove of an absent member is a no-op", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      const group = yield* executor.accessGroups.create({ name: "finance" });

      const first = yield* executor.accessGroups.addMember({ id: group.id, subject: "user_a" });
      const again = yield* executor.accessGroups.addMember({ id: group.id, subject: "user_a" });
      expect(first.subject).toBe("user_a");
      expect(again.createdAt.getTime()).toBe(first.createdAt.getTime());
      yield* executor.accessGroups.addMember({ id: group.id, subject: "user_b" });

      const members = yield* executor.accessGroups.members(group.id);
      expect(members.map((member) => member.subject)).toEqual(["user_a", "user_b"]);

      // Absent-member removal is a no-op, so an offboarding sweep can
      // best-effort delete without existence checks.
      yield* executor.accessGroups.removeMember({ id: group.id, subject: "user_gone" });
      yield* executor.accessGroups.removeMember({ id: group.id, subject: "user_b" });
      expect(
        (yield* executor.accessGroups.members(group.id)).map((member) => member.subject),
      ).toEqual(["user_a"]);
    }),
  );

  it.effect("rejects blank member subjects", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      const group = yield* executor.accessGroups.create({ name: "finance" });
      const error = yield* Effect.flip(
        executor.accessGroups.addMember({ id: group.id, subject: "  " }),
      );
      expect(Predicate.isTagged("StorageError")(error)).toBe(true);
    }),
  );

  it.effect("restricts and unrestricts an org connection", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      const group = yield* executor.accessGroups.create({ name: "finance" });

      expect(yield* executor.accessGroups.restrictions()).toEqual([]);
      yield* executor.accessGroups.restrictConnection({
        integration: VERCEL,
        name: CONN,
        group: group.id,
      });
      const restrictions = yield* executor.accessGroups.restrictions();
      expect(restrictions).toEqual([{ integration: VERCEL, name: CONN, group: group.id }]);

      yield* executor.accessGroups.unrestrictConnection({ integration: VERCEL, name: CONN });
      expect(yield* executor.accessGroups.restrictions()).toEqual([]);
    }),
  );

  it.effect("rejects restricting to an unknown group and restricting a missing connection", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      const unknownGroup = yield* Effect.flip(
        executor.accessGroups.restrictConnection({
          integration: VERCEL,
          name: CONN,
          group: "grp_missing",
        }),
      );
      expect(Predicate.isTagged("StorageError")(unknownGroup)).toBe(true);

      const group = yield* executor.accessGroups.create({ name: "finance" });
      const missingConnection = yield* Effect.flip(
        executor.accessGroups.restrictConnection({
          integration: VERCEL,
          name: ConnectionName.make("missing"),
          group: group.id,
        }),
      );
      expect(Predicate.isTagged("ConnectionNotFoundError")(missingConnection)).toBe(true);
      const unrestrictMissing = yield* Effect.flip(
        executor.accessGroups.unrestrictConnection({
          integration: VERCEL,
          name: ConnectionName.make("missing"),
        }),
      );
      expect(Predicate.isTagged("ConnectionNotFoundError")(unrestrictMissing)).toBe(true);
    }),
  );

  it.effect("refuses deleting a group while a connection references it, then deletes cleanly", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      const group = yield* executor.accessGroups.create({ name: "finance" });
      yield* executor.accessGroups.addMember({ id: group.id, subject: "user_a" });
      yield* executor.accessGroups.restrictConnection({
        integration: VERCEL,
        name: CONN,
        group: group.id,
      });

      // A dangling group reference would silently hide the connection from
      // everyone — deletion is refused while referenced.
      const blocked = yield* Effect.flip(executor.accessGroups.remove({ id: group.id }));
      expect(Predicate.isTagged("StorageError")(blocked)).toBe(true);
      expect(yield* executor.accessGroups.restrictions()).toHaveLength(1);

      yield* executor.accessGroups.unrestrictConnection({ integration: VERCEL, name: CONN });
      yield* executor.accessGroups.remove({ id: group.id });
      expect(yield* executor.accessGroups.list()).toEqual([]);
      // Member rows are gone with the group.
      const membersError = yield* Effect.flip(executor.accessGroups.members(group.id));
      expect(Predicate.isTagged("StorageError")(membersError)).toBe(true);
    }),
  );
});
