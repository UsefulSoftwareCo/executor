import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Result } from "effect";
import { resolveProjectedPolicy, ToolAddress } from "@executor-js/sdk/core";
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
      const projection = yield* executor.toolkits.projectionForSlug("deploy-kit");
      expect(projection?.rules.find((rule) => rule.id === first.id)?.action).toBe(
        "require_approval",
      );

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

  it.effect("projects toolkit policies with implicit deny and workspace owner limits", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [toolkitsPlugin()] as const,
      });
      // The workspace has no rule for these tools, so its answer is the plugin
      // default — the same one the projection falls through to.
      const resolve = (slug: string, toolId: string, defaultRequiresApproval?: boolean) =>
        executor.toolkits
          .projectionForSlug(slug)
          .pipe(
            Effect.map((projection) =>
              resolveProjectedPolicy(
                projection ?? { visible: [], rules: [] },
                toolId,
                defaultRequiresApproval
                  ? { action: "require_approval", source: "plugin-default" }
                  : { action: "approve", source: "plugin-default" },
                defaultRequiresApproval,
              ),
            ),
          );

      const workspace = yield* executor.toolkits.create({
        owner: "org",
        name: "Workspace Kit",
      });
      yield* executor.toolkits.createConnection(workspace.id, {
        pattern: "github.org.main.*",
      });

      const workspaceTool = yield* resolve(workspace.slug, "github.org.main.repos.list");
      expect(workspaceTool.action).toBe("approve");
      expect(workspaceTool.source).toBe("plugin-default");

      const defaultApprovalTool = yield* resolve(
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
      const explicitTool = yield* resolve(workspace.slug, "github.org.main.repos.delete", true);
      expect(explicitTool.action).toBe("approve");
      expect(explicitTool.source).toBe("user");

      const personalTool = yield* resolve(workspace.slug, "github.user.main.repos.list");
      expect(personalTool.action).toBe("block");

      const missingTool = yield* resolve(workspace.slug, "slack.org.main.chat.post");
      expect(missingTool.action).toBe("block");

      const unknownToolkit = yield* resolve("no-such-kit", "github.org.main.repos.list");
      expect(unknownToolkit.action).toBe("block");

      const personal = yield* executor.toolkits.create({
        owner: "user",
        name: "Personal Kit",
      });
      yield* executor.toolkits.createConnection(personal.id, {
        pattern: "github.user.main.*",
      });
      const personalToolkitTool = yield* resolve(personal.slug, "github.user.main.repos.list");
      expect(personalToolkitTool.action).toBe("approve");
    }),
  );

  it.effect("a projected executor keeps the workspace policy underneath the toolkit", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [toolkitsPlugin()] as const,
        coreTools: { webBaseUrl: "https://executor.test" },
      });

      const toolkit = yield* executor.toolkits.create({ owner: "org", name: "Core Kit" });
      yield* executor.toolkits.createConnection(toolkit.id, {
        pattern: "executor.coreTools.*",
      });
      yield* executor.toolkits.createPolicy(toolkit.id, {
        pattern: "executor.coreTools.policies.create",
        action: "approve",
      });
      // The workspace gates the same tool. A toolkit "approve" must not undo it.
      yield* executor.policies.create({
        owner: "org",
        pattern: "executor.coreTools.policies.create",
        action: "require_approval",
      });

      const projected = yield* executor.project(toolkit.slug);
      const gated = yield* projected.policies.resolve(
        ToolAddress.make("executor.coreTools.policies.create"),
      );
      expect(gated.action).toBe("require_approval");

      // Outside the toolkit's connections the tool is blocked, even though the
      // workspace itself would allow it.
      const outside = yield* projected.policies.resolve(
        ToolAddress.make("executor.coreTools.integrations.list"),
      );
      expect(outside.action).toBe("approve");
      const hidden = yield* projected.tools.list();
      expect(hidden.every((tool) => String(tool.address).startsWith("executor.coreTools."))).toBe(
        true,
      );

      // The parent view is untouched by the projection.
      const parent = yield* executor.policies.resolve(
        ToolAddress.make("executor.coreTools.policies.create"),
      );
      expect(parent.action).toBe("require_approval");
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

      const projection = yield* executor.toolkits.projectionForSlug(toolkit.slug);
      const result = resolveProjectedPolicy(
        projection!,
        "executor.coreTools.connections.remove",
        { action: "approve", source: "plugin-default" },
        true,
      );
      expect(result.action).toBe("approve");
      expect(result.source).toBe("user");
      expect(
        projection!.rules.map((rule) => `${rule.pattern} ${rule.action}`),
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

      const projection = yield* executor.toolkits.projectionForSlug(toolkit.slug);
      const result = resolveProjectedPolicy(
        projection!,
        "google_docs.org.main.documents.update",
        { action: "approve", source: "plugin-default" },
        true,
      );
      expect(result.action).toBe("approve");
      expect(result.source).toBe("user");
      expect(
        projection!.rules.map((rule) => `${rule.pattern} ${rule.action}`),
        "policy listing agrees with toolkit enforcement",
      ).toContain("google_docs.org.* approve");
    }),
  );
});
