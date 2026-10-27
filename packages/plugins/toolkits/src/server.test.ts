import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Result } from "effect";
import {
  AuthTemplateSlug,
  ConnectionName,
  definePlugin,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  ToolName,
} from "@executor-js/sdk";
import { makeTestExecutor, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { toolkitsPlugin } from "./server";

const SNAPSHOT_INTEGRATION = IntegrationSlug.make("snapshot-test");
const SNAPSHOT_CONNECTION = ConnectionName.make("main");
const SNAPSHOT_TEMPLATE = AuthTemplateSlug.make("apiKey");

const snapshotToolPlugin = definePlugin(() => ({
  id: "snapshotTool" as const,
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({
      tools: [{ name: ToolName.make("read"), description: "Read a snapshot fixture" }],
    }),
  invokeTool: () => Effect.succeed({ ok: true }),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: SNAPSHOT_INTEGRATION,
        description: "Toolkit snapshot fixture",
        config: {},
      }),
  }),
}))();

describe("toolkitsPlugin", () => {
  it.effect("creates toolkits and manages ordered policy rules", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [toolkitsPlugin()] as const,
        coreTools: {},
      });

      const toolkit = yield* executor.toolkits.create({
        owner: "org",
        name: "Deploy Kit",
      });
      expect(toolkit.slug).toBe("deploy-kit");

      const connection = yield* executor.toolkits.createConnection(toolkit.id, {
        pattern: "github.org.main.*",
      });
      const duplicateConnection = yield* executor.toolkits.createConnection(toolkit.id, {
        pattern: "github.org.main.*",
      });
      expect(duplicateConnection.id).toBe(connection.id);

      const first = yield* executor.toolkits.createPolicy(toolkit.id, {
        pattern: "github.org.main.repos.*",
        action: "approve",
      });
      const second = yield* executor.toolkits.createPolicy(toolkit.id, {
        pattern: "github.*",
        action: "block",
      });

      const policies = yield* executor.toolkits.listPolicies(toolkit.id);
      expect(policies.map((policy) => policy.id)).toEqual([second.id, first.id]);

      yield* executor.toolkits.updatePolicy(toolkit.id, first.id, {
        action: "require_approval",
      });
      const rules = yield* executor.toolkits.policyRulesForSlug("deploy-kit");
      expect(rules.find((rule) => rule.id === first.id)?.action).toBe("require_approval");

      const connections = yield* executor.toolkits.listConnections(toolkit.id);
      expect(connections.map((row) => row.pattern)).toEqual(["github.org.main.*"]);
    }),
  );

  it.effect("rejects duplicate visible slugs", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [toolkitsPlugin()] as const,
      });
      yield* executor.toolkits.create({ owner: "org", name: "Deploy Kit" });

      const duplicate = yield* Effect.result(
        executor.toolkits.create({ owner: "user", name: "Deploy Kit" }),
      );
      expect(Result.isFailure(duplicate)).toBe(true);
      if (!Result.isFailure(duplicate)) return;
      expect(Predicate.isTagged("ToolkitError")(duplicate.failure)).toBe(true);
    }),
  );

  it.effect("exports an exact membership snapshot that does not expand after edits", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [toolkitsPlugin()] as const,
        coreTools: {},
      });
      const toolkit = yield* executor.toolkits.create({ owner: "org", name: "Snapshot Kit" });
      yield* executor.toolkits.createConnection(toolkit.id, {
        pattern: "executor.coreTools.*",
      });
      yield* executor.toolkits.createPolicy(toolkit.id, {
        pattern: "executor.coreTools.*",
        action: "approve",
      });
      for (let index = 0; index < 8; index += 1) {
        yield* executor.toolkits.createConnection(toolkit.id, {
          pattern: `executor.coreTools.connection-${index}.*`,
        });
      }
      for (let index = 0; index < 32; index += 1) {
        yield* executor.toolkits.createPolicy(toolkit.id, {
          pattern: `executor.coreTools.policy-${index}.*`,
          action: index % 2 === 0 ? "approve" : "require_approval",
        });
      }

      const before = yield* executor.toolkits.snapshotForSlug(toolkit.slug);
      expect(before).not.toBeNull();
      if (!before) return;
      expect(before.actions).toEqual(["discover", "invoke"]);
      expect(before.revision).toMatch(/^[0-9a-f]{64}$/);
      expect(before.toolAddresses.length).toBeGreaterThan(0);
      const frozenTools = [...before.toolAddresses];

      yield* executor.toolkits.createPolicy(toolkit.id, {
        pattern: "executor.coreTools.*",
        action: "block",
      });
      const after = yield* executor.toolkits.snapshotForSlug(toolkit.slug);
      expect(after).not.toBeNull();
      expect(after?.revision).not.toBe(before.revision);
      expect(before.toolAddresses).toEqual(frozenTools);
    }),
  );

  it.effect("matches full tools addresses when freezing a dynamic catalog", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [toolkitsPlugin(), memoryCredentialsPlugin(), snapshotToolPlugin] as const,
        coreTools: {},
      });
      yield* executor.snapshotTool.seed();
      yield* executor.connections.create({
        owner: "org",
        name: SNAPSHOT_CONNECTION,
        integration: SNAPSHOT_INTEGRATION,
        template: SNAPSHOT_TEMPLATE,
        from: {
          provider: ProviderKey.make("memory"),
          id: ProviderItemId.make("snapshot-test-credential"),
        },
      });

      const toolkit = yield* executor.toolkits.create({
        owner: "org",
        name: "Dynamic Snapshot Kit",
      });
      yield* executor.toolkits.createConnection(toolkit.id, {
        pattern: "snapshot-test.org.main.*",
      });
      yield* executor.toolkits.createPolicy(toolkit.id, {
        pattern: "snapshot-test.org.main.read",
        action: "require_approval",
      });

      const snapshot = yield* executor.toolkits.snapshotForSlug(toolkit.slug);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.toolAddresses.map(String)).toContain("tools.snapshot-test.org.main.read");
      expect(snapshot?.connectionAddresses.map(String)).toContain("snapshot-test.org.main");
      const resolved = yield* executor.toolkits.resolvePolicyForSlug(
        toolkit.slug,
        "tools.snapshot-test.org.main.read",
      );
      expect(resolved.action).toBe("require_approval");
    }),
  );

  it.effect("resolves toolkit policies with implicit deny and workspace owner limits", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [toolkitsPlugin()] as const,
      });

      const workspace = yield* executor.toolkits.create({
        owner: "org",
        name: "Workspace Kit",
      });
      yield* executor.toolkits.createConnection(workspace.id, {
        pattern: "github.org.main.*",
      });

      const workspaceTool = yield* executor.toolkits.resolvePolicyForSlug(
        workspace.slug,
        "github.org.main.repos.list",
      );
      expect(workspaceTool.action).toBe("approve");
      expect(workspaceTool.source).toBe("plugin-default");

      const defaultApprovalTool = yield* executor.toolkits.resolvePolicyForSlug(
        workspace.slug,
        "github.org.main.repos.delete",
        true,
      );
      expect(defaultApprovalTool.action).toBe("require_approval");
      expect(defaultApprovalTool.source).toBe("plugin-default");

      yield* executor.toolkits.createPolicy(workspace.id, {
        pattern: "github.org.main.repos.delete",
        action: "approve",
      });
      const explicitTool = yield* executor.toolkits.resolvePolicyForSlug(
        workspace.slug,
        "github.org.main.repos.delete",
        true,
      );
      expect(explicitTool.action).toBe("approve");
      expect(explicitTool.source).toBe("user");

      const personalTool = yield* executor.toolkits.resolvePolicyForSlug(
        workspace.slug,
        "github.user.main.repos.list",
      );
      expect(personalTool.action).toBe("block");

      const missingTool = yield* executor.toolkits.resolvePolicyForSlug(
        workspace.slug,
        "slack.org.main.chat.post",
      );
      expect(missingTool.action).toBe("block");

      const personal = yield* executor.toolkits.create({
        owner: "user",
        name: "Personal Kit",
      });
      yield* executor.toolkits.createConnection(personal.id, {
        pattern: "github.user.main.*",
      });
      const personalToolkitTool = yield* executor.toolkits.resolvePolicyForSlug(
        personal.slug,
        "github.user.main.repos.list",
      );
      expect(personalToolkitTool.action).toBe("approve");
    }),
  );

  it.effect("prepares a dynamic scope from the toolkit's access patterns", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [toolkitsPlugin()] as const,
      });

      const orgKit = yield* executor.toolkits.create({ owner: "org", name: "Org Kit" });
      for (const pattern of [
        "github.org.main.*",
        "slack.*",
        "linear.*.*.issues.list",
        "github.user.alice.*",
        "executor.coreTools.*",
      ]) {
        yield* executor.toolkits.createConnection(orgKit.id, { pattern });
      }
      const prepared = yield* executor.toolkits.preparePolicyResolverForSlug(orgKit.slug);
      // An org toolkit never reaches personal rows: unowned prefixes pin to
      // org, user-only prefixes drop, and static-only patterns contribute none.
      const byIntegration = (
        a: { integration: string | null },
        b: { integration: string | null },
      ) => String(a.integration).localeCompare(String(b.integration));
      expect([...(prepared.dynamicScope ?? [])].sort(byIntegration)).toEqual([
        { integration: "github", owner: "org", connection: "main" },
        { integration: "linear", owner: "org", connection: null },
        { integration: "slack", owner: "org", connection: null },
      ]);
      expect(prepared.resolve({ toolId: "github.org.main.repos.list" }).action).toBe("approve");
      expect(prepared.resolve({ toolId: "github.user.alice.repos.list" }).action).toBe("block");

      const personalKit = yield* executor.toolkits.create({ owner: "user", name: "Me Kit" });
      yield* executor.toolkits.createConnection(personalKit.id, { pattern: "github.user.alice.*" });
      const personal = yield* executor.toolkits.preparePolicyResolverForSlug(personalKit.slug);
      expect(personal.dynamicScope).toEqual([
        { integration: "github", owner: "user", connection: "alice" },
      ]);

      const missing = yield* executor.toolkits.preparePolicyResolverForSlug("no-such-kit");
      expect(missing.dynamicScope).toEqual([]);
      expect(missing.resolve({ toolId: "github.org.main.repos.list" }).action).toBe("block");
    }),
  );

  it.effect("treats a persisted connection-root approve as an access policy", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [toolkitsPlugin()] as const,
      });

      const toolkit = yield* executor.toolkits.create({
        owner: "org",
        name: "Core Tools Kit",
      });
      yield* executor.toolkits.createConnection(toolkit.id, {
        pattern: "executor.coreTools.*",
      });
      yield* executor.toolkits.createPolicy(toolkit.id, {
        pattern: "executor.coreTools.*",
        action: "approve",
      });

      const result = yield* executor.toolkits.resolvePolicyForSlug(
        toolkit.slug,
        "executor.coreTools.connections.remove",
        true,
      );
      expect(result.action).toBe("approve");
      expect(result.source).toBe("user");

      const rules = yield* executor.toolkits.policyRulesForSlug(toolkit.slug);
      expect(
        rules.map((rule) => `${rule.pattern} ${rule.action}`),
        "policy listing agrees with toolkit enforcement",
      ).toContain("executor.coreTools.* approve");
    }),
  );

  it.effect("applies a broad approve policy over a narrower connection", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [toolkitsPlugin()] as const,
      });

      const toolkit = yield* executor.toolkits.create({
        owner: "org",
        name: "Docs Kit",
      });
      yield* executor.toolkits.createConnection(toolkit.id, {
        pattern: "google_docs.org.main.*",
      });
      yield* executor.toolkits.createPolicy(toolkit.id, {
        pattern: "google_docs.org.*",
        action: "approve",
      });

      const result = yield* executor.toolkits.resolvePolicyForSlug(
        toolkit.slug,
        "google_docs.org.main.documents.update",
        true,
      );
      expect(result.action).toBe("approve");
      expect(result.source).toBe("user");

      const rules = yield* executor.toolkits.policyRulesForSlug(toolkit.slug);
      expect(
        rules.map((rule) => `${rule.pattern} ${rule.action}`),
        "policy listing agrees with toolkit enforcement",
      ).toContain("google_docs.org.* approve");
    }),
  );
});
