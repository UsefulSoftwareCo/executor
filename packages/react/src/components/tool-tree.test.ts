import { describe, expect, it } from "@effect/vitest";
import type { EffectivePolicy, Owner } from "@executor-js/sdk/shared";

import { buildAccountGroups, type ToolSummary } from "./tool-tree";

// A trivial always-approve plugin default — the policy field is required on a
// ToolSummary but irrelevant to grouping.
const approve: EffectivePolicy = {
  action: "approve",
  source: "plugin-default",
  pattern: "*",
};

const tool = (input: {
  readonly id: string;
  readonly name: string;
  readonly owner?: Owner;
  readonly connection?: string;
}): ToolSummary => ({
  id: input.id,
  name: input.name,
  description: undefined,
  policy: approve,
  owner: input.owner,
  connection: input.connection,
});

describe("buildAccountGroups", () => {
  it("groups tools by (owner, connection) and badges each section by owner", () => {
    const groups = buildAccountGroups([
      tool({
        id: "u:axiom-mcp:axiom.query",
        name: "axiom.query",
        owner: "user",
        connection: "axiom-mcp",
      }),
      tool({
        id: "o:vercel-api:vercel.deploy",
        name: "vercel.deploy",
        owner: "org",
        connection: "vercel-api",
      }),
    ]);

    // Workspace (org) sorts before Personal (user).
    expect(groups.map((g) => g.label)).toEqual(["Workspace · vercel-api", "Personal · axiom-mcp"]);
    expect(groups.map((g) => g.owner)).toEqual(["org", "user"]);
    expect(groups[0]!.tools.map((t) => t.name)).toEqual(["vercel.deploy"]);
    expect(groups[1]!.tools.map((t) => t.name)).toEqual(["axiom.query"]);
  });

  it("Axiom regression: a user-owned connection's tools render in the merged, account-grouped view", () => {
    // 18 user-owned tools, zero org rows — the case that showed 0 under the old
    // owner=org default. Here they all land in one Personal section.
    const tools = Array.from({ length: 18 }, (_, i) =>
      tool({
        id: `u:axiom-mcp:axiom.t${i}`,
        name: `axiom.t${i}`,
        owner: "user",
        connection: "axiom-mcp",
      }),
    );
    const groups = buildAccountGroups(tools);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.owner).toBe("user");
    expect(groups[0]!.label).toBe("Personal · axiom-mcp");
    expect(groups[0]!.tools).toHaveLength(18);
  });

  it("does NOT dedupe the same tool name across two connections — it appears under each", () => {
    const groups = buildAccountGroups([
      tool({ id: "o:prod:vercel.deploy", name: "vercel.deploy", owner: "org", connection: "prod" }),
      tool({
        id: "u:scratch:vercel.deploy",
        name: "vercel.deploy",
        owner: "user",
        connection: "scratch",
      }),
    ]);

    expect(groups).toHaveLength(2);
    // Same tool name, once per account.
    expect(groups.flatMap((g) => g.tools).map((t) => t.name)).toEqual([
      "vercel.deploy",
      "vercel.deploy",
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Workspace · prod", "Personal · scratch"]);
  });

  it("sorts multiple connections within an owner by connection name", () => {
    const groups = buildAccountGroups([
      tool({ id: "o:zeta:i.a", name: "i.a", owner: "org", connection: "zeta" }),
      tool({ id: "o:alpha:i.b", name: "i.b", owner: "org", connection: "alpha" }),
    ]);
    expect(groups.map((g) => g.connection)).toEqual(["alpha", "zeta"]);
  });

  it("falls back to a single owner-only label when tools carry no owner/connection (flat case)", () => {
    const groups = buildAccountGroups([
      tool({ id: "vercel.deploy", name: "vercel.deploy" }),
      tool({ id: "vercel.list", name: "vercel.list" }),
    ]);
    // Default owner is org; no connection → owner-only label, single group.
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("Workspace");
    expect(groups[0]!.tools).toHaveLength(2);
  });
});
