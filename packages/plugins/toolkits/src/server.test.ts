import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Result } from "effect";
import { makeTestExecutor } from "@executor-js/sdk/testing";

import { toolkitsPlugin } from "./server";

describe("toolkitsPlugin", () => {
  it.effect("creates toolkits and manages ordered policy rules", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [toolkitsPlugin()] as const,
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
});
