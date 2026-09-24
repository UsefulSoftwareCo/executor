import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Result } from "effect";
import { makeTestExecutor } from "@executor-js/sdk/testing";

import { toolkitsPlugin } from "./server";

describe("toolkitsPlugin", () => {
  it.effect("filters managed skill discovery through the active toolkit", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [toolkitsPlugin({ activeToolkitSlug: "focused" })] as const,
      });
      const toolkit = yield* executor.toolkits.create({ owner: "user", name: "Focused" });
      const included = yield* executor.skills.create({
        owner: "user",
        package: {
          files: [
            {
              path: "SKILL.md",
              bytes: new TextEncoder().encode(
                "---\nname: included\ndescription: Included skill.\n---\nBody",
              ),
            },
          ],
        },
      });
      yield* executor.skills.create({
        owner: "org",
        package: {
          files: [
            {
              path: "SKILL.md",
              bytes: new TextEncoder().encode(
                "---\nname: excluded\ndescription: Excluded skill.\n---\nBody",
              ),
            },
          ],
        },
      });

      expect(yield* executor.skills.list()).toEqual([]);
      const memberships = yield* executor.toolkits.setSkills(toolkit.id, {
        expectedUpdatedAt: toolkit.updatedAt,
        skillIds: [included.id],
      });
      expect(memberships.map((membership) => membership.skillId)).toEqual([included.id]);
      expect((yield* executor.skills.list()).map((skill) => skill.id)).toEqual([included.id]);
    }),
  );

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
