import { describe, expect, it } from "@effect/vitest";

import { type ToolPolicyRow } from "./core-schema";
import { prepareToolPolicies, resolveEffectivePolicy, resolveToolPolicy } from "./policies";

// ---------------------------------------------------------------------------
// `prepareToolPolicies` must return exactly what the per-tool resolvers return.
// The explicit cases pin precedence rules; the seeded comparison covers mixed
// owners, position ties, exact/subtree/mid-segment/universal patterns and the
// legacy shapes `isValidPattern` rejects but stored rows may still contain.
// ---------------------------------------------------------------------------

type Action = "approve" | "require_approval" | "block";

const ROW = (
  id: string,
  pattern: string,
  action: Action,
  position: string,
  owner: "org" | "user" = "org",
): ToolPolicyRow =>
  ({
    id,
    owner,
    subject: owner === "org" ? "" : "u",
    pattern,
    action,
    position,
    created_at: new Date(0),
    updated_at: new Date(0),
  }) as ToolPolicyRow;

const flatRank = () => 0;
const ownerRank = (row: Pick<ToolPolicyRow, "owner">) => (row.owner === "user" ? 0 : 1);

const expectSame = (
  toolId: string,
  rows: readonly ToolPolicyRow[],
  rank: (row: Pick<ToolPolicyRow, "owner">) => number,
) => {
  const prepared = prepareToolPolicies(rows, rank);
  expect(prepared.resolve(toolId)).toEqual(resolveToolPolicy(toolId, rows, rank));
  for (const defaultRequiresApproval of [undefined, false, true]) {
    expect(prepared.resolveEffective(toolId, defaultRequiresApproval)).toEqual(
      resolveEffectivePolicy(toolId, rows, rank, defaultRequiresApproval),
    );
  }
};

describe("prepareToolPolicies", () => {
  it("returns undefined and the plugin default when there are no rules", () => {
    const prepared = prepareToolPolicies([], ownerRank);
    expect(prepared.resolve("a.org.default.b")).toBeUndefined();
    expect(prepared.resolveEffective("a.org.default.b", true)).toEqual({
      action: "require_approval",
      source: "plugin-default",
    });
    expect(prepared.resolveEffective("a.org.default.b")).toEqual({
      action: "approve",
      source: "plugin-default",
    });
  });

  it("takes the first matching rule by position, exact or wildcard", () => {
    const exactFirst = [
      ROW("a", "vercel.org.default.create", "approve", "a0"),
      ROW("b", "vercel.*", "block", "a1"),
    ];
    const wildcardFirst = [
      ROW("b", "vercel.*", "block", "a0"),
      ROW("a", "vercel.org.default.create", "approve", "a1"),
    ];
    expect(prepareToolPolicies(exactFirst, flatRank).resolve("vercel.org.default.create")).toEqual({
      action: "approve",
      pattern: "vercel.org.default.create",
      policyId: "a",
    });
    expect(
      prepareToolPolicies(wildcardFirst, flatRank).resolve("vercel.org.default.create"),
    ).toEqual({ action: "block", pattern: "vercel.*", policyId: "b" });
    expectSame("vercel.org.default.create", exactFirst, flatRank);
    expectSame("vercel.org.default.create", wildcardFirst, flatRank);
  });

  it("lets an org block override a user approve, and a user block override an org approve", () => {
    const orgBlock = [
      ROW("user-allow", "lidarr.org.default.list", "approve", "a0", "user"),
      ROW("org-block", "lidarr.*", "block", "a0", "org"),
    ];
    const userBlock = [
      ROW("org-allow", "lidarr.org.default.list", "approve", "a0", "org"),
      ROW("user-block", "*", "block", "a5", "user"),
    ];
    expect(
      prepareToolPolicies(orgBlock, ownerRank).resolve("lidarr.org.default.list")?.policyId,
    ).toBe("org-block");
    expect(
      prepareToolPolicies(userBlock, ownerRank).resolve("lidarr.org.default.list")?.policyId,
    ).toBe("user-block");
    expectSame("lidarr.org.default.list", orgBlock, ownerRank);
    expectSame("lidarr.org.default.list", userBlock, ownerRank);
  });

  it("keeps the earlier owner's match when both owners match with the same action", () => {
    const rows = [
      ROW("org-allow", "plex.*", "approve", "a0", "org"),
      ROW("user-allow", "plex.org.default.search", "approve", "a9", "user"),
    ];
    // user ranks first, so its match is found first and kept on a tie.
    expect(prepareToolPolicies(rows, ownerRank).resolve("plex.org.default.search")?.policyId).toBe(
      "user-allow",
    );
    expectSame("plex.org.default.search", rows, ownerRank);
  });

  it("uses the earliest of duplicate exact patterns and breaks position ties by id", () => {
    const rows = [
      ROW("z", "a.org.default.t", "block", "a0"),
      ROW("m", "a.org.default.t", "approve", "a0"),
      ROW("b", "a.org.default.t", "require_approval", "a1"),
    ];
    expect(prepareToolPolicies(rows, flatRank).resolve("a.org.default.t")?.policyId).toBe("m");
    expectSame("a.org.default.t", rows, flatRank);
  });

  it("matches the default block plus specific grants used in production", () => {
    const rows = [
      ROW("g1", "google_gmail.org.default.users.messages.list", "approve", "a0"),
      ROW("g2", "cloudflare-dns.*.*.dns.getZone", "approve", "a1"),
      ROW("lid", "lidarr.*", "block", "a2"),
      ROW("all", "*", "block", "a3"),
    ];
    for (const toolId of [
      "google_gmail.org.default.users.messages.list",
      "google_gmail.org.default.users.messages.send",
      "cloudflare-dns.org.default.dns.getZone",
      "cloudflare-dns.org.default.dns.deleteZone",
      "lidarr.org.default.artist.list",
      "plex.org.default.library",
    ]) {
      expectSame(toolId, rows, ownerRank);
    }
    const prepared = prepareToolPolicies(rows, ownerRank);
    expect(prepared.resolve("cloudflare-dns.org.default.dns.getZone")?.action).toBe("approve");
    expect(prepared.resolve("lidarr.org.default.artist.list")?.action).toBe("block");
    expect(prepared.resolve("plex.org.default.library")?.policyId).toBe("all");
  });

  it("matches subtree, mid-segment, universal and legacy pattern shapes", () => {
    const patterns = [
      "*",
      "a.*",
      "a.b.*",
      "a.*.c",
      "a.*.*.d",
      "a.b",
      "a.b.c",
      "*.b",
      "*.*",
      "a.b*",
      "a",
      "",
      "a..b",
    ];
    const tools = ["a", "a.b", "a.b.c", "a.x.c", "a.x.y.d", "z.b", "a.b.c.d", "a.b*", "", "a..b"];
    patterns.forEach((pattern, i) => {
      const rows = [ROW(`p${i}`, pattern, "block", "a0")];
      for (const toolId of tools) expectSame(toolId, rows, flatRank);
    });
  });

  it("agrees with resolveToolPolicy on seeded random rule sets", () => {
    // mulberry32 — deterministic so a failure reproduces exactly.
    let seed = 0x5eed1234;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const integrations = ["gmail", "plex", "lidarr", "dns"];
    const owners = ["org", "user"];
    const connections = ["default", "justin"];
    const names = ["list", "get", "send", "delete", "users.messages.list"];
    const actions: Action[] = ["approve", "require_approval", "block"];
    const positions = ["a0", "a1", "a2", "a3", "Zz", "a0V"];

    const randomTool = () =>
      `${pick(integrations)}.${pick(owners)}.${pick(connections)}.${pick(names)}`;
    const randomPattern = (): string => {
      const segments = randomTool().split(".");
      const shapes = [
        () => "*",
        () => `${segments[0]}.*`,
        () => `${segments.slice(0, 3).join(".")}.*`,
        () => `${segments[0]}.*.*.${segments.slice(3).join(".")}`,
        () => `${segments[0]}.${segments[1]}.*.${segments.slice(3).join(".")}`,
        () => `*.${segments.slice(1).join(".")}`,
        () => segments.join("."),
        () => segments.join("."),
      ];
      return pick(shapes)();
    };

    for (let round = 0; round < 300; round++) {
      const count = Math.floor(random() * 40);
      const rows: ToolPolicyRow[] = [];
      for (let i = 0; i < count; i++) {
        rows.push(
          ROW(
            `id${Math.floor(random() * 1000)}-${i}`,
            randomPattern(),
            pick(actions),
            pick(positions),
            pick(owners) as "org" | "user",
          ),
        );
      }
      const toolIds = Array.from({ length: 25 }, randomTool);
      for (const rank of [ownerRank, flatRank]) {
        const prepared = prepareToolPolicies(rows, rank);
        for (const toolId of toolIds) {
          expect(prepared.resolve(toolId)).toEqual(resolveToolPolicy(toolId, rows, rank));
          expect(prepared.resolveEffective(toolId, round % 2 === 0)).toEqual(
            resolveEffectivePolicy(toolId, rows, rank, round % 2 === 0),
          );
        }
      }
    }
  });
});
