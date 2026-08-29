import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Result } from "effect";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  ToolName,
  definePlugin,
  type CredentialProvider,
} from "@executor-js/sdk";
import { makeTestExecutor, makeTestWorkspaceHarness } from "@executor-js/sdk/testing";

import { toolkitsPlugin } from "./server";

// Fixture: a minimal integration plugin so tests can create the REAL org
// connections their toolkit patterns name — `listConnections` drops a literal
// `<integration>.org.<connection>` pattern that doesn't resolve for the
// caller (access-group visibility; a hidden connection ≡ a nonexistent one).
const memoryProvider = (): CredentialProvider => {
  const store = new Map<string, string>();
  return {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
  };
};

const GITHUB = IntegrationSlug.make("github");
const MAIN = ConnectionName.make("main");

const githubFixturePlugin = definePlugin(() => ({
  id: "ghfixture" as const,
  storage: () => ({}),
  credentialProviders: [memoryProvider()],
  resolveTools: () =>
    Effect.succeed({ tools: [{ name: ToolName.make("list"), description: "list repos" }] }),
  invokeTool: ({ toolRow }) => Effect.succeed({ ran: `${toolRow.integration}.${toolRow.name}` }),
  extension: (ctx) => ({
    seed: () => ctx.core.integrations.register({ slug: GITHUB, description: "GitHub", config: {} }),
  }),
}));

const seedGithubConnection = (executor: {
  readonly ghfixture: { readonly seed: () => Effect.Effect<unknown, unknown> };
  readonly connections: {
    readonly create: (input: {
      readonly owner: "org";
      readonly name: ConnectionName;
      readonly integration: IntegrationSlug;
      readonly template: AuthTemplateSlug;
      readonly from: { readonly provider: ProviderKey; readonly id: ProviderItemId };
    }) => Effect.Effect<unknown, unknown>;
  };
}) =>
  Effect.gen(function* () {
    yield* executor.ghfixture.seed();
    yield* executor.connections.create({
      owner: "org",
      name: MAIN,
      integration: GITHUB,
      template: AuthTemplateSlug.make("apiKey"),
      from: { provider: ProviderKey.make("memory"), id: ProviderItemId.make("g") },
    });
  });

describe("toolkitsPlugin", () => {
  it.effect("creates toolkits and manages ordered policy rules", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [toolkitsPlugin(), githubFixturePlugin()] as const,
      });
      yield* seedGithubConnection(executor);

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

  it.effect("hides a restricted connection's pattern from non-members", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dataDir = mkdtempSync(join(tmpdir(), "toolkit-groups-"));
        const tenant = "shared-tenant";
        const plugins = [toolkitsPlugin(), githubFixturePlugin()] as const;

        const admin = yield* makeTestWorkspaceHarness({
          plugins,
          tenant,
          subject: "admin",
          dataDir,
        });
        yield* seedGithubConnection(admin.executor);
        const toolkit = yield* admin.executor.toolkits.create({ owner: "org", name: "Deploy Kit" });
        yield* admin.executor.toolkits.createConnection(toolkit.id, {
          pattern: "github.org.main.*",
        });

        const group = yield* admin.executor.accessGroups.create({ name: "finance" });
        yield* admin.executor.accessGroups.addMember({ id: group.id, subject: "member-a" });
        yield* admin.executor.accessGroups.restrictConnection({
          integration: GITHUB,
          name: MAIN,
          group: group.id,
        });

        const member = yield* makeTestWorkspaceHarness({
          plugins,
          tenant,
          subject: "member-a",
          dataDir,
        });
        const outsider = yield* makeTestWorkspaceHarness({
          plugins,
          tenant,
          subject: "member-b",
          dataDir,
        });

        const memberPatterns = yield* member.executor.toolkits.listConnections(toolkit.id);
        expect(memberPatterns.map((row) => row.pattern)).toEqual(["github.org.main.*"]);
        // For a non-member the connection does not exist, so neither does the
        // pattern naming it — the pattern text itself would be an oracle.
        const outsiderPatterns = yield* outsider.executor.toolkits.listConnections(toolkit.id);
        expect(outsiderPatterns).toEqual([]);
      }),
    ),
  );

  it.effect("a toolkit granted to a group exists only for its members", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dataDir = mkdtempSync(join(tmpdir(), "toolkit-grant-"));
        const tenant = "shared-tenant";
        const plugins = [toolkitsPlugin(), githubFixturePlugin()] as const;

        const admin = yield* makeTestWorkspaceHarness({
          plugins,
          tenant,
          subject: "admin",
          dataDir,
        });
        yield* seedGithubConnection(admin.executor);
        const toolkit = yield* admin.executor.toolkits.create({ owner: "org", name: "Deploy Kit" });
        yield* admin.executor.toolkits.createConnection(toolkit.id, {
          pattern: "github.org.main.*",
        });
        const group = yield* admin.executor.accessGroups.create({ name: "finance" });
        yield* admin.executor.accessGroups.addMember({ id: group.id, subject: "member-a" });
        yield* admin.executor.toolkits.setAccessGroup(toolkit.id, group.id);

        const member = yield* makeTestWorkspaceHarness({
          plugins,
          tenant,
          subject: "member-a",
          dataDir,
        });
        const outsider = yield* makeTestWorkspaceHarness({
          plugins,
          tenant,
          subject: "member-b",
          dataDir,
        });

        // The member's view is unchanged; the toolkit does not exist for the
        // outsider — not in the list, and its id answers not-found.
        expect((yield* member.executor.toolkits.list()).map((item) => item.slug)).toEqual([
          "deploy-kit",
        ]);
        expect(yield* outsider.executor.toolkits.list()).toEqual([]);
        const hidden = yield* Effect.flip(outsider.executor.toolkits.listPolicies(toolkit.id));
        expect(Predicate.isTagged("ToolkitError")(hidden)).toBe(true);

        // The slug resolves to nothing for the outsider, so a toolkit MCP
        // session on it blocks everything — identical to an unknown slug.
        expect(yield* outsider.executor.toolkits.policyRulesForSlug("deploy-kit")).toEqual([]);
        const resolved = yield* outsider.executor.toolkits.resolvePolicyForSlug(
          "deploy-kit",
          "github.org.main.list",
        );
        expect(resolved.action).toBe("block");
        const memberResolved = yield* member.executor.toolkits.resolvePolicyForSlug(
          "deploy-kit",
          "github.org.main.list",
        );
        expect(memberResolved.action).not.toBe("block");

        // The management surface stays unfiltered: the admin (not a member)
        // still sees and can clear the grant; membership edits apply live.
        expect(yield* admin.executor.toolkits.listRestrictedToolkits()).toEqual([
          { toolkitId: toolkit.id, slug: "deploy-kit", group: group.id },
        ]);
        expect(yield* admin.executor.toolkits.list()).toEqual([]);
        yield* admin.executor.toolkits.setAccessGroup(toolkit.id, null);
        expect((yield* outsider.executor.toolkits.list()).map((item) => item.slug)).toEqual([
          "deploy-kit",
        ]);
      }),
    ),
  );

  it.effect("rejects granting a personal toolkit or an unknown toolkit", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [toolkitsPlugin(), githubFixturePlugin()] as const,
      });
      const personal = yield* executor.toolkits.create({ owner: "user", name: "Mine" });
      const personalError = yield* Effect.flip(
        executor.toolkits.setAccessGroup(personal.id, "grp_x"),
      );
      expect(Predicate.isTagged("ToolkitError")(personalError)).toBe(true);
      const unknownError = yield* Effect.flip(
        executor.toolkits.setAccessGroup("tk_missing", "grp_x"),
      );
      expect(Predicate.isTagged("ToolkitError")(unknownError)).toBe(true);
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
