import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Result } from "effect";
import { generateKeyBetween } from "fractional-indexing";

import type { ToolPolicyRow } from "./core-schema";
import { PolicyId, ScopeId } from "./ids";
import { Scope } from "./scope";
import { createExecutor } from "./executor";
import { ElicitationResponse, type ElicitationHandler } from "./elicitation";
import {
  effectivePolicyFromSorted,
  isValidPattern,
  matchPattern,
  resolveToolPolicy,
} from "./policies";
import { definePlugin, defineSchema } from "./plugin";
import { makeTestConfig } from "./testing";

// ---------------------------------------------------------------------------
// Pure unit tests — pattern matcher + resolution. No executor required.
// ---------------------------------------------------------------------------

describe("matchPattern", () => {
  it("matches exact tool ids", () => {
    expect(matchPattern("vercel.dns.create", "vercel.dns.create")).toBe(true);
    expect(matchPattern("vercel.dns.create", "vercel.dns.delete")).toBe(false);
  });

  it("matches subtree wildcards", () => {
    expect(matchPattern("vercel.dns.*", "vercel.dns.create")).toBe(true);
    expect(matchPattern("vercel.dns.*", "vercel.dns.delete")).toBe(true);
    expect(matchPattern("vercel.dns.*", "vercel.dns.zones.list")).toBe(true);
    expect(matchPattern("vercel.dns.*", "vercel.dnstool")).toBe(false);
    expect(matchPattern("vercel.dns.*", "vercel.deploy")).toBe(false);
  });

  it("matches plugin-wide wildcards", () => {
    expect(matchPattern("vercel.*", "vercel.dns.create")).toBe(true);
    expect(matchPattern("vercel.*", "vercel.deploy")).toBe(true);
    expect(matchPattern("vercel.*", "vercelapp.deploy")).toBe(false);
  });

  it("does not collapse the dot boundary", () => {
    // The tool id must continue with a dot after the wildcard prefix —
    // otherwise `vercel.dns.*` would silently capture `vercel.dnstool`.
    expect(matchPattern("vercel.dns.*", "vercel.dnstool")).toBe(false);
  });

  it("matches every tool id when the pattern is bare *", () => {
    expect(matchPattern("*", "vercel.dns.create")).toBe(true);
    expect(matchPattern("*", "github.repos.list")).toBe(true);
    expect(matchPattern("*", "x")).toBe(true);
  });
});

describe("isValidPattern", () => {
  it("accepts exact ids and trailing wildcards", () => {
    expect(isValidPattern("a")).toBe(true);
    expect(isValidPattern("a.b")).toBe(true);
    expect(isValidPattern("a.b.c")).toBe(true);
    expect(isValidPattern("a.*")).toBe(true);
    expect(isValidPattern("a.b.*")).toBe(true);
  });

  it("accepts the universal pattern", () => {
    expect(isValidPattern("*")).toBe(true);
  });

  it("rejects malformed shapes", () => {
    expect(isValidPattern("")).toBe(false);
    expect(isValidPattern(".a")).toBe(false);
    expect(isValidPattern("a.")).toBe(false);
    expect(isValidPattern("a..b")).toBe(false);
    expect(isValidPattern("*.a")).toBe(false);
    expect(isValidPattern("a.*.b")).toBe(false);
    expect(isValidPattern("a*")).toBe(false);
    expect(isValidPattern("a.b*")).toBe(false);
  });
});

describe("resolveToolPolicy", () => {
  const ROW = (
    id: string,
    pattern: string,
    action: "approve" | "require_approval" | "block",
    position: string,
    scope_id = "test-scope",
  ): ToolPolicyRow =>
    ({
      id,
      scope_id,
      pattern,
      action,
      position,
      created_at: new Date(0),
      updated_at: new Date(0),
    }) as ToolPolicyRow;

  const flatRank = () => 0; // single-scope tests

  it("returns undefined when no policies match", () => {
    const result = resolveToolPolicy(
      "vercel.dns.create",
      [ROW("a", "github.*", "block", "a0")],
      flatRank,
    );
    expect(result).toBeUndefined();
  });

  it("returns the first matching rule by position", () => {
    // Lowest position = highest precedence. Specific exception listed
    // above the broad rule wins for the specific tool id.
    const result = resolveToolPolicy(
      "vercel.dns.create",
      [
        ROW("a", "vercel.dns.create", "approve", "a0"),
        ROW("b", "vercel.dns.*", "require_approval", "a1"),
      ],
      flatRank,
    );
    expect(result?.action).toBe("approve");
    expect(result?.pattern).toBe("vercel.dns.create");
    expect(result?.policyId).toBe("a");
  });

  it("falls through to the broader rule when the specific rule is below it", () => {
    // First-match-wins is purely positional — if the user puts the
    // broad rule above the specific exception, the broad rule wins.
    // The system trusts the user's ordering.
    const result = resolveToolPolicy(
      "vercel.dns.create",
      [
        ROW("b", "vercel.dns.*", "require_approval", "a0"),
        ROW("a", "vercel.dns.create", "approve", "a1"),
      ],
      flatRank,
    );
    expect(result?.action).toBe("require_approval");
    expect(result?.pattern).toBe("vercel.dns.*");
  });

  it("does not allow an inner approve to weaken an outer block", () => {
    // Scope rank comes from the executor's scope stack: 0 = innermost,
    // 1 = next, etc. Each scope contributes its first local match, then
    // the most restrictive action wins across scopes.
    const policies = [
      ROW("outer", "vercel.*", "block", "a0", "org"),
      ROW("inner", "vercel.dns.create", "approve", "a0", "user"),
    ];
    const rank = (row: Pick<ToolPolicyRow, "scope_id">) => (row.scope_id === "user" ? 0 : 1);
    const result = resolveToolPolicy("vercel.dns.create", policies, rank);
    expect(result?.action).toBe("block");
    expect(result?.policyId).toBe("outer");
  });

  it("allows an inner scope to strengthen an outer approve", () => {
    const policies = [
      ROW("outer", "vercel.*", "approve", "a0", "org"),
      ROW("inner", "vercel.dns.create", "require_approval", "a0", "user"),
    ];
    const rank = (row: Pick<ToolPolicyRow, "scope_id">) => (row.scope_id === "user" ? 0 : 1);
    const result = resolveToolPolicy("vercel.dns.create", policies, rank);
    expect(result?.action).toBe("require_approval");
    expect(result?.policyId).toBe("inner");
  });

  it("tiebreaks identical positions by id so order is deterministic", () => {
    // Two rows with the same `position` (racing inserts that picked the
    // same fractional-indexing key from independent clients) must sort
    // deterministically — otherwise the rendered order flips on every
    // refetch and reorder math sees colliding neighbor keys.
    const a = resolveToolPolicy(
      "vercel.dns.create",
      [ROW("z", "vercel.dns.*", "block", "a0"), ROW("a", "vercel.dns.*", "approve", "a0")],
      flatRank,
    );
    const b = resolveToolPolicy(
      "vercel.dns.create",
      [ROW("a", "vercel.dns.*", "approve", "a0"), ROW("z", "vercel.dns.*", "block", "a0")],
      flatRank,
    );
    // Same input rows in different order, same winner — id "a" sorts
    // before "z" so it wins regardless of array order.
    expect(a?.policyId).toBe("a");
    expect(b?.policyId).toBe("a");
  });
});

describe("effectivePolicyFromSorted", () => {
  const POL = (id: string, pattern: string, action: "approve" | "require_approval" | "block") => ({
    id: PolicyId.make(id),
    pattern,
    action,
  });

  it("returns user policy when one matches", () => {
    const result = effectivePolicyFromSorted(
      "vercel.dns.create",
      [POL("a", "vercel.dns.*", "block")],
      true,
    );
    expect(result).toEqual({
      action: "block",
      source: "user",
      pattern: "vercel.dns.*",
      policyId: PolicyId.make("a"),
    });
  });

  it("falls back to plugin default require_approval", () => {
    const result = effectivePolicyFromSorted("vercel.dns.create", [], true);
    expect(result).toEqual({
      action: "require_approval",
      source: "plugin-default",
    });
  });

  it("falls back to plugin default approve when annotation is false/undefined", () => {
    expect(effectivePolicyFromSorted("vercel.dns.create", [], false)).toEqual({
      action: "approve",
      source: "plugin-default",
    });
    expect(effectivePolicyFromSorted("vercel.dns.create", [])).toEqual({
      action: "approve",
      source: "plugin-default",
    });
  });

  it("user policy wins over plugin default", () => {
    // Plugin default would be require_approval; user explicitly approves.
    const result = effectivePolicyFromSorted(
      "vercel.dns.create",
      [POL("a", "vercel.dns.create", "approve")],
      true,
    );
    expect(result.action).toBe("approve");
    expect(result.source).toBe("user");
  });

  it("chooses the most restrictive first match across scopes", () => {
    const result = effectivePolicyFromSorted(
      "vercel.dns.create",
      [
        { ...POL("inner", "vercel.dns.create", "approve"), scopeId: ScopeId.make("user") },
        { ...POL("outer", "vercel.*", "block"), scopeId: ScopeId.make("org") },
      ],
      false,
    );
    expect(result.action).toBe("block");
    expect(result.policyId).toBe(PolicyId.make("outer"));
  });
});

// ---------------------------------------------------------------------------
// Executor integration — exercises invoke + list + CRUD with a real
// in-memory adapter and a tiny test plugin. Mirrors the design choices:
//   - block  → invisible to list; ToolBlockedError at invoke
//   - approve → invoke skips approval prompt
//   - require_approval → invoke fires elicitation, declined => fails
//   - undefined → falls through to plugin annotation
// ---------------------------------------------------------------------------

const recordingHandler = (calls: { count: number }): ElicitationHandler =>
  (() => {
    calls.count++;
    return Effect.succeed(new ElicitationResponse({ action: "accept" }));
  }) as ElicitationHandler;

const decliningHandler: ElicitationHandler = () =>
  Effect.succeed(new ElicitationResponse({ action: "decline" }));

const policyTestSchema = defineSchema({
  ptest_marker: {
    fields: {
      id: { type: "string", required: true },
    },
  },
});

const policyTestPlugin = definePlugin(() => ({
  id: "ptest" as const,
  schema: policyTestSchema,
  storage: () => ({}),
  resolveAnnotations: ({ toolRows }) => {
    const out: Record<string, { requiresApproval?: boolean }> = {};
    for (const row of toolRows) {
      // Make tools whose name contains "delete" require approval by
      // default — mirrors openapi's HTTP-method heuristic in spirit.
      out[row.id] = {
        requiresApproval: row.name.toLowerCase().includes("delete"),
      };
    }
    return Effect.succeed(out);
  },
  extension: (ctx) => ({
    seed: (scope = "test-scope") =>
      ctx.transaction(
        Effect.gen(function* () {
          yield* ctx.core.sources.register({
            id: "vercel",
            scope,
            kind: "test",
            name: "Vercel",
            tools: [
              { name: "deploy", description: "deploy" },
              { name: "delete", description: "delete a deployment" },
            ],
          });
          yield* ctx.core.sources.register({
            id: "github",
            scope,
            kind: "test",
            name: "GitHub",
            tools: [{ name: "list", description: "list repos" }],
          });
        }),
      ),
  }),
  invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.id }),
}));

const setupExecutor = () =>
  Effect.gen(function* () {
    const config = makeTestConfig({ plugins: [policyTestPlugin()] as const });
    const executor = yield* createExecutor(config);
    yield* executor.ptest.seed();
    return executor;
  });

describe("executor.policies", () => {
  it.effect("list is empty when no rules exist", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      const rules = yield* executor.policies.list();
      expect(rules).toEqual([]);
    }),
  );

  it.effect("create defaults new rules to the top of the list", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      const first = yield* executor.policies.create({
        targetScope: "test-scope",
        pattern: "vercel.*",
        action: "require_approval",
      });
      const second = yield* executor.policies.create({
        targetScope: "test-scope",
        pattern: "vercel.delete",
        action: "block",
      });
      // second was created later but should sit above first (lower lex
      // order on the fractional-indexing key).
      expect(second.position < first.position).toBe(true);

      const rules = yield* executor.policies.list();
      expect(rules.map((r) => r.pattern)).toEqual(["vercel.delete", "vercel.*"]);
    }),
  );

  it.effect("create stores rules at the requested target scope in a stacked context", () =>
    Effect.gen(function* () {
      const userScope = ScopeId.make("policy-user");
      const orgScope = ScopeId.make("policy-org");
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: [
            new Scope({ id: userScope, name: "user", createdAt: new Date() }),
            new Scope({ id: orgScope, name: "org", createdAt: new Date() }),
          ],
          plugins: [policyTestPlugin()] as const,
        }),
      );

      yield* executor.policies.create({
        targetScope: String(orgScope),
        pattern: "vercel.*",
        action: "require_approval",
      });
      yield* executor.policies.create({
        targetScope: String(userScope),
        pattern: "github.*",
        action: "approve",
      });

      const rules = yield* executor.policies.list();
      expect(rules.map((rule) => [rule.scopeId, rule.pattern])).toEqual([
        [userScope, "github.*"],
        [orgScope, "vercel.*"],
      ]);
    }),
  );

  it.effect("rejects target scopes outside the context stack", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      const result = yield* Effect.result(
        executor.policies.create({
          targetScope: "other-scope",
          pattern: "vercel.*",
          action: "block",
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
    }),
  );

  it.effect("rejects malformed patterns", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      const result = yield* Effect.result(
        executor.policies.create({
          targetScope: "test-scope",
          pattern: "vercel..bad",
          action: "block",
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
    }),
  );

  it.effect("update mutates the row in place", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      const created = yield* executor.policies.create({
        targetScope: "test-scope",
        pattern: "vercel.*",
        action: "require_approval",
      });
      yield* executor.policies.update({
        id: created.id,
        targetScope: "test-scope",
        action: "block",
      });
      const rules = yield* executor.policies.list();
      expect(rules[0]?.action).toBe("block");
    }),
  );

  it.effect("update without position preserves the existing position", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      const created = yield* executor.policies.create({
        targetScope: "test-scope",
        pattern: "vercel.*",
        action: "require_approval",
      });
      yield* executor.policies.update({
        id: created.id,
        targetScope: "test-scope",
        action: "block",
      });
      const rules = yield* executor.policies.list();
      expect(rules[0]?.position).toBe(created.position);
    }),
  );

  it.effect("update with a new position reorders the list", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      const a = yield* executor.policies.create({
        targetScope: "test-scope",
        pattern: "a.*",
        action: "approve",
      });
      const b = yield* executor.policies.create({
        targetScope: "test-scope",
        pattern: "b.*",
        action: "approve",
      });
      // After two creates: b above a (newer = higher precedence).
      const before = yield* executor.policies.list();
      expect(before.map((r) => r.pattern)).toEqual(["b.*", "a.*"]);

      // Move `a` above `b` by setting a position lex-less-than b's.
      // generateKeyBetween(null, b.position) is what the UI would do.
      yield* executor.policies.update({
        id: a.id,
        targetScope: "test-scope",
        position: generateKeyBetween(null, b.position),
      });
      const after = yield* executor.policies.list();
      expect(after.map((r) => r.pattern)).toEqual(["a.*", "b.*"]);
    }),
  );

  it.effect("consecutive creates produce strictly increasing-precedence keys", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      const created: string[] = [];
      for (const pattern of ["a.*", "b.*", "c.*", "d.*"]) {
        const row = yield* executor.policies.create({
          targetScope: "test-scope",
          pattern,
          action: "approve",
        });
        created.push(row.position);
      }
      // Each new key sorts strictly above the previous (lower lex
      // order = higher precedence). No collisions.
      for (let i = 1; i < created.length; i++) {
        expect(created[i]! < created[i - 1]!).toBe(true);
      }
      // List order matches insertion-reverse.
      const rules = yield* executor.policies.list();
      expect(rules.map((r) => r.pattern)).toEqual(["d.*", "c.*", "b.*", "a.*"]);
    }),
  );

  it.effect("remove deletes the row", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      const created = yield* executor.policies.create({
        targetScope: "test-scope",
        pattern: "vercel.*",
        action: "block",
      });
      yield* executor.policies.remove({ id: created.id, targetScope: "test-scope" });
      const rules = yield* executor.policies.list();
      expect(rules).toEqual([]);
    }),
  );

  it.effect("resolve returns the matching rule with provenance", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* executor.policies.create({
        targetScope: "test-scope",
        pattern: "vercel.*",
        action: "block",
      });
      const result = yield* executor.policies.resolve("vercel.deploy");
      expect(result?.action).toBe("block");
      expect(result?.pattern).toBe("vercel.*");
    }),
  );
});

describe("blocked tools", () => {
  it.effect("are filtered from tools.list by default", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* executor.policies.create({
        targetScope: "test-scope",
        pattern: "vercel.delete",
        action: "block",
      });
      const tools = yield* executor.tools.list();
      const ids = tools.map((t) => t.id).sort();
      expect(ids).toEqual(["github.list", "vercel.deploy"]);
    }),
  );

  it.effect("are visible when includeBlocked is true", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* executor.policies.create({
        targetScope: "test-scope",
        pattern: "vercel.delete",
        action: "block",
      });
      const tools = yield* executor.tools.list({ includeBlocked: true });
      const ids = tools.map((t) => t.id).sort();
      expect(ids).toEqual(["github.list", "vercel.delete", "vercel.deploy"]);
    }),
  );

  it.effect("invoke fails with ToolBlockedError carrying the matched pattern", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* executor.policies.create({
        targetScope: "test-scope",
        pattern: "vercel.*",
        action: "block",
      });
      const result = yield* Effect.result(executor.tools.invoke("vercel.delete", {}));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("ToolBlockedError")(result.failure)).toBe(true);
      if (!Predicate.isTagged("ToolBlockedError")(result.failure)) return;
      expect(result.failure.pattern).toBe("vercel.*");
    }),
  );

  it.effect("outer block still applies when an inner scope approves", () =>
    Effect.gen(function* () {
      const userScope = ScopeId.make("policy-user");
      const orgScope = ScopeId.make("policy-org");
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: [
            new Scope({ id: userScope, name: "user", createdAt: new Date() }),
            new Scope({ id: orgScope, name: "org", createdAt: new Date() }),
          ],
          plugins: [policyTestPlugin()] as const,
        }),
      );
      yield* executor.ptest.seed(String(orgScope));

      yield* executor.policies.create({
        targetScope: String(orgScope),
        pattern: "vercel.deploy",
        action: "block",
      });
      yield* executor.policies.create({
        targetScope: String(userScope),
        pattern: "vercel.deploy",
        action: "approve",
      });

      const policy = yield* executor.policies.resolve("vercel.deploy");
      expect(policy?.action).toBe("block");

      const tools = yield* executor.tools.list();
      expect(tools.map((tool) => tool.id)).not.toContain("vercel.deploy");

      const result = yield* Effect.result(executor.tools.invoke("vercel.deploy", {}));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("ToolBlockedError")(result.failure)).toBe(true);
    }),
  );
});

describe("approve / require_approval interaction with annotations", () => {
  it.effect("approve skips the elicitation prompt even when plugin requires approval", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* executor.policies.create({
        targetScope: "test-scope",
        pattern: "vercel.delete",
        action: "approve",
      });
      const calls = { count: 0 };
      const result = yield* executor.tools.invoke(
        "vercel.delete",
        {},
        {
          onElicitation: recordingHandler(calls),
        },
      );
      expect(calls.count).toBe(0);
      expect(result).toEqual({ ran: "vercel.delete" });
    }),
  );

  it.effect("require_approval forces the prompt for tools the plugin would auto-approve", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* executor.policies.create({
        targetScope: "test-scope",
        pattern: "vercel.deploy",
        action: "require_approval",
      });
      const calls = { count: 0 };
      yield* executor.tools.invoke(
        "vercel.deploy",
        {},
        {
          onElicitation: recordingHandler(calls),
        },
      );
      expect(calls.count).toBe(1);
    }),
  );

  it.effect("require_approval surfaces ElicitationDeclined when user declines", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* executor.policies.create({
        targetScope: "test-scope",
        pattern: "vercel.deploy",
        action: "require_approval",
      });
      const result = yield* Effect.result(
        executor.tools.invoke(
          "vercel.deploy",
          {},
          {
            onElicitation: decliningHandler,
          },
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("ElicitationDeclinedError")(result.failure)).toBe(true);
    }),
  );

  it.effect("absence of policy falls through to plugin annotation", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      // No policy for vercel.delete — the plugin's resolveAnnotations
      // marks any tool whose name contains "delete" as requiring
      // approval, so the prompt should fire.
      const calls = { count: 0 };
      yield* executor.tools.invoke(
        "vercel.delete",
        {},
        {
          onElicitation: recordingHandler(calls),
        },
      );
      expect(calls.count).toBe(1);

      // vercel.deploy has no plugin-required approval and no policy,
      // so no prompt.
      yield* executor.tools.invoke(
        "vercel.deploy",
        {},
        {
          onElicitation: recordingHandler(calls),
        },
      );
      expect(calls.count).toBe(1);
    }),
  );
});
