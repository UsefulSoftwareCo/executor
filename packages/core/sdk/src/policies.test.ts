import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Result, Schema } from "effect";

import { type ToolPolicyRow } from "./core-schema";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  PolicyId,
  ProviderItemId,
  ProviderKey,
  ToolAddress,
  ToolName,
} from "./ids";
import { ElicitationResponse, type ElicitationHandler } from "./elicitation";
import { createExecutor } from "./executor";
import type { FumaDb } from "./fuma-runtime";
import {
  effectivePolicyFromSorted,
  isValidPattern,
  matchPattern,
  resolveToolPolicy,
} from "./policies";
import { definePlugin, tool } from "./plugin";
import type { CredentialProvider } from "./provider";
import { makeTestConfig, makeTestExecutor } from "./testing";

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
    expect(matchPattern("vercel.dns.*", "vercel.dnstool")).toBe(false);
  });

  it("matches every tool id when the pattern is bare *", () => {
    expect(matchPattern("*", "vercel.dns.create")).toBe(true);
    expect(matchPattern("*", "github.repos.list")).toBe(true);
    expect(matchPattern("*", "x")).toBe(true);
  });

  it("matches mid-segment wildcards as exactly one segment each", () => {
    // Wildcard the owner/connection segments of a full address.
    expect(matchPattern("github.*.*.repos.list", "github.org.acme.repos.list")).toBe(true);
    expect(matchPattern("github.*.*.repos.list", "github.user.alice.repos.list")).toBe(true);
    // The literal tail must still match exactly.
    expect(matchPattern("github.*.*.repos.list", "github.org.acme.repos.delete")).toBe(false);
    // A mid `*` consumes exactly one segment — not zero, not many.
    expect(matchPattern("github.*.*.repos.list", "github.acme.repos.list")).toBe(false);
    // Mid wildcards combine with a trailing subtree wildcard.
    expect(matchPattern("github.*.*.repos.*", "github.org.acme.repos.list")).toBe(true);
    expect(matchPattern("github.*.*.repos.*", "github.org.acme.repos")).toBe(true);
    expect(matchPattern("github.*.*.repos.*", "github.org.acme.deploy")).toBe(false);
    // A connection-specific pattern targets one connection only.
    expect(matchPattern("github.user.alice.repos.*", "github.user.alice.repos.list")).toBe(true);
    expect(matchPattern("github.user.alice.repos.*", "github.user.bob.repos.list")).toBe(false);
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

  it("accepts mid-segment wildcards", () => {
    expect(isValidPattern("a.*.b")).toBe(true);
    expect(isValidPattern("github.*.*.repos.list")).toBe(true);
    expect(isValidPattern("github.*.*.repos.*")).toBe(true);
    expect(isValidPattern("github.user.alice.repos.*")).toBe(true);
  });

  it("accepts the universal pattern", () => {
    expect(isValidPattern("*")).toBe(true);
  });

  it("rejects malformed shapes", () => {
    expect(isValidPattern("")).toBe(false);
    expect(isValidPattern(".a")).toBe(false);
    expect(isValidPattern("a.")).toBe(false);
    expect(isValidPattern("a..b")).toBe(false);
    expect(isValidPattern("*.a")).toBe(false); // leading * still rejected
    expect(isValidPattern("a*")).toBe(false); // partial wildcard
    expect(isValidPattern("a.b*")).toBe(false); // partial wildcard
  });
});

describe("resolveToolPolicy", () => {
  // v2: policy rows carry `owner` (org|user) instead of a scope id.
  const ROW = (
    id: string,
    pattern: string,
    action: "approve" | "require_approval" | "block",
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

  const flatRank = () => 0; // single-owner tests
  // user = 0 (inner), org = 1 (outer).
  const ownerRank = (row: Pick<ToolPolicyRow, "owner">) => (row.owner === "user" ? 0 : 1);

  it("returns undefined when no policies match", () => {
    const result = resolveToolPolicy(
      "vercel.dns.create",
      [ROW("a", "github.*", "block", "a0")],
      flatRank,
    );
    expect(result).toBeUndefined();
  });

  it("returns the first matching rule by position", () => {
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
    const policies = [
      ROW("outer", "vercel.*", "block", "a0", "org"),
      ROW("inner", "vercel.dns.create", "approve", "a0", "user"),
    ];
    const result = resolveToolPolicy("vercel.dns.create", policies, ownerRank);
    expect(result?.action).toBe("block");
    expect(result?.policyId).toBe("outer");
  });

  it("allows an inner owner to strengthen an outer approve", () => {
    const policies = [
      ROW("outer", "vercel.*", "approve", "a0", "org"),
      ROW("inner", "vercel.dns.create", "require_approval", "a0", "user"),
    ];
    const result = resolveToolPolicy("vercel.dns.create", policies, ownerRank);
    expect(result?.action).toBe("require_approval");
    expect(result?.policyId).toBe("inner");
  });

  it("tiebreaks identical positions by id so order is deterministic", () => {
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
    expect(result.action).toBe("block");
    expect(result.source).toBe("user");
  });

  it("user policy wins over plugin default", () => {
    const result = effectivePolicyFromSorted(
      "vercel.dns.create",
      [POL("a", "vercel.dns.create", "approve")],
      true,
    );
    expect(result.action).toBe("approve");
    expect(result.source).toBe("user");
  });

  it("chooses the most restrictive first match across owners", () => {
    const result = effectivePolicyFromSorted(
      "vercel.dns.create",
      [
        {
          ...POL("inner", "vercel.dns.create", "approve"),
          owner: "user" as const,
        },
        { ...POL("outer", "vercel.*", "block"), owner: "org" as const },
      ],
      false,
    );
    expect(result.action).toBe("block");
    expect(result.policyId).toBe(PolicyId.make("outer"));
  });
});

// ---------------------------------------------------------------------------
// Executor integration — v2 surface. A test plugin produces per-connection
// tools via `resolveTools`; policies are owner-scoped; tools are addressed by
// `tools.<integration>.<owner>.<connection>.<tool>`.
//   - block  → invisible to list; ToolBlockedError at execute
//   - approve → execute skips approval prompt
//   - require_approval → execute fires elicitation, declined => fails
//   - undefined → falls through to plugin annotation
// ---------------------------------------------------------------------------

const recordingHandler = (calls: { count: number }): ElicitationHandler =>
  (() => {
    calls.count++;
    return Effect.succeed(ElicitationResponse.make({ action: "accept" }));
  }) as ElicitationHandler;

const decliningHandler: ElicitationHandler = () =>
  Effect.succeed(ElicitationResponse.make({ action: "decline" }));

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
const GITHUB = IntegrationSlug.make("github");
const TEMPLATE = AuthTemplateSlug.make("apiKey");

const policyTestPlugin = definePlugin(() => ({
  id: "ptest" as const,
  storage: () => ({}),
  credentialProviders: [memoryProvider()],
  resolveTools: ({ integration }) => {
    const tools =
      String(integration.slug) === "vercel"
        ? [
            { name: ToolName.make("deploy"), description: "deploy" },
            {
              name: ToolName.make("delete"),
              description: "delete a deployment",
              annotations: { requiresApproval: true },
            },
          ]
        : [{ name: ToolName.make("list"), description: "list repos" }];
    return Effect.succeed({ tools });
  },
  resolveAnnotations: ({ toolRows }) => {
    const out: Record<string, { requiresApproval?: boolean }> = {};
    for (const row of toolRows) {
      out[row.name] = {
        requiresApproval: row.name.toLowerCase().includes("delete"),
      };
    }
    return Effect.succeed(out);
  },
  invokeTool: ({ toolRow }) => Effect.succeed({ ran: `${toolRow.integration}.${toolRow.name}` }),
  extension: (ctx) => ({
    seed: () =>
      Effect.gen(function* () {
        yield* ctx.core.integrations.register({
          slug: VERCEL,
          description: "Vercel",
          config: {},
        });
        yield* ctx.core.integrations.register({
          slug: GITHUB,
          description: "GitHub",
          config: {},
        });
      }),
  }),
}));

const CONN = ConnectionName.make("main");

const addr = (integration: IntegrationSlug, tool: string): ToolAddress =>
  ToolAddress.make(`tools.${integration}.org.${CONN}.${tool}`);

const setupExecutor = () =>
  makeTestExecutor({ plugins: [policyTestPlugin()] as const }).pipe(
    Effect.tap((executor) =>
      Effect.gen(function* () {
        yield* executor.ptest.seed();
        yield* executor.connections.create({
          owner: "org",
          name: CONN,
          integration: VERCEL,
          template: TEMPLATE,
          from: {
            provider: ProviderKey.make("memory"),
            id: ProviderItemId.make("v"),
          },
        });
        yield* executor.connections.create({
          owner: "org",
          name: CONN,
          integration: GITHUB,
          template: TEMPLATE,
          from: {
            provider: ProviderKey.make("memory"),
            id: ProviderItemId.make("g"),
          },
        });
      }),
    ),
  );

/** Model a concurrent remover that wins immediately after policy update. */
const removePolicyAfterUpdate = (db: FumaDb, armed: () => boolean): FumaDb => {
  const wrap = (inner: FumaDb): FumaDb =>
    new Proxy(inner, {
      get(target, property) {
        if (property === "withContext") {
          return (context: unknown) =>
            wrap((target.withContext as (value: unknown) => FumaDb)(context));
        }
        if (property === "transaction") {
          return (run: (transactionDb: FumaDb) => Promise<unknown>) =>
            target.transaction((transactionDb) => run(wrap(transactionDb as FumaDb)));
        }
        if (property === "updateMany") {
          return async (...args: Parameters<FumaDb["updateMany"]>) => {
            const [table, input] = args;
            const result = await target.updateMany(...args);
            if (armed() && table === "tool_policy") {
              await target.deleteMany(table, { where: input.where });
            }
            return result;
          };
        }
        return Reflect.get(target, property);
      },
    });
  return wrap(db);
};

describe("executor.policies", () => {
  it.effect("list is empty when no rules exist", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      const rules = yield* executor.policies.list();
      expect(rules).toEqual([]);
    }),
  );

  it.effect("create defaults new rules above equally-or-less-specific ones", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      const first = yield* executor.policies.create({
        owner: "org",
        pattern: "vercel.*",
        action: "require_approval",
      });
      const second = yield* executor.policies.create({
        owner: "org",
        pattern: "vercel.delete",
        action: "block",
      });
      expect(second.position < first.position).toBe(true);

      const rules = yield* executor.policies.list();
      expect(rules.map((r) => r.pattern)).toEqual(["vercel.delete", "vercel.*"]);
    }),
  );

  it.effect("create places a broad rule below an existing narrower one", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      // Narrow leaf rule first, then a broad category rule WITHOUT an explicit
      // position — the category rule must not shadow the leaf rule.
      yield* executor.policies.create({
        owner: "org",
        pattern: "vercel.*.*.records.create",
        action: "block",
      });
      yield* executor.policies.create({
        owner: "org",
        pattern: "vercel.*.*.records.*",
        action: "require_approval",
      });

      const rules = yield* executor.policies.list();
      expect(rules.map((r) => r.pattern)).toEqual([
        "vercel.*.*.records.create",
        "vercel.*.*.records.*",
      ]);

      const rows = rules.map(
        (r) =>
          ({
            id: String(r.id),
            owner: r.owner,
            subject: "",
            pattern: r.pattern,
            action: r.action,
            position: r.position,
            created_at: r.createdAt,
            updated_at: r.updatedAt,
          }) as ToolPolicyRow,
      );
      const match = resolveToolPolicy("vercel.org.acct.records.create", rows, () => 0);
      expect(match?.action).toBe("block");
      expect(match?.pattern).toBe("vercel.*.*.records.create");
    }),
  );

  it.live("concurrent creates of equally specific rules get distinct positions", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* Effect.all(
        [
          executor.policies.create({ owner: "org", pattern: "vercel.dns.create", action: "block" }),
          executor.policies.create({ owner: "org", pattern: "vercel.dns.delete", action: "block" }),
        ],
        { concurrency: "unbounded" },
      );

      const rules = yield* executor.policies.list();
      expect(rules).toHaveLength(2);
      expect(new Set(rules.map((r) => r.position)).size).toBe(2);
    }),
  );

  it.effect("create stores rules at the requested owner", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* executor.policies.create({
        owner: "org",
        pattern: "vercel.*",
        action: "require_approval",
      });
      yield* executor.policies.create({
        owner: "user",
        pattern: "github.*",
        action: "approve",
      });

      const rules = yield* executor.policies.list();
      expect(rules.map((rule) => [rule.owner, rule.pattern])).toEqual([
        ["user", "github.*"],
        ["org", "vercel.*"],
      ]);
    }),
  );

  it.effect("rejects malformed patterns", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      const result = yield* Effect.result(
        executor.policies.create({
          owner: "org",
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
        owner: "org",
        pattern: "vercel.*",
        action: "require_approval",
      });
      yield* executor.policies.update({
        id: String(created.id),
        owner: "org",
        action: "block",
      });
      const rules = yield* executor.policies.list();
      expect(rules[0]?.action).toBe("block");
    }),
  );

  it.effect("fails when the policy vanishes during update", () =>
    Effect.gen(function* () {
      let armed = false;
      const config = makeTestConfig({ plugins: [policyTestPlugin()] as const });
      const executor = yield* createExecutor({
        ...config,
        db: removePolicyAfterUpdate(config.db, () => armed),
      });
      yield* Effect.addFinalizer(() =>
        executor
          .close()
          .pipe(Effect.andThen(Effect.promise(() => config.testDb.close())), Effect.ignore),
      );
      const created = yield* executor.policies.create({
        owner: "org",
        pattern: "vercel.*",
        action: "require_approval",
      });
      armed = true;

      const result = yield* executor.policies
        .update({ id: String(created.id), owner: "org", action: "block" })
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(
        Result.match(result, {
          onFailure: (failure) => String(failure),
          onSuccess: () => "",
        }),
      ).toContain(`Tool policy disappeared while it was being updated: ${created.id}`);
      expect(yield* executor.policies.list()).toEqual([created]);
    }).pipe(Effect.scoped),
  );

  it.effect("remove deletes the rule", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      const created = yield* executor.policies.create({
        owner: "org",
        pattern: "vercel.*",
        action: "block",
      });
      yield* executor.policies.remove({ id: String(created.id), owner: "org" });
      const rules = yield* executor.policies.list();
      expect(rules).toEqual([]);
    }),
  );

  it.effect("resolve returns the effective policy for an address", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* executor.policies.create({
        owner: "org",
        pattern: "vercel.*",
        action: "block",
      });
      const result = yield* executor.policies.resolve(addr(VERCEL, "deploy"));
      expect(result.action).toBe("block");
    }),
  );
});

describe("blocked tools", () => {
  it.effect("a blocked tool is omitted from tools.list", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* executor.policies.create({
        owner: "org",
        pattern: "vercel.*",
        action: "block",
      });
      const tools = yield* executor.tools.list();
      expect(tools.some((t) => t.integration === VERCEL)).toBe(false);
    }),
  );

  it.effect("includeBlocked surfaces blocked tools", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* executor.policies.create({
        owner: "org",
        pattern: "vercel.*",
        action: "block",
      });
      const tools = yield* executor.tools.list({ includeBlocked: true });
      expect(tools.some((t) => t.integration === VERCEL)).toBe(true);
    }),
  );

  it.effect("execute on a blocked tool fails with ToolBlockedError", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* executor.policies.create({
        owner: "org",
        pattern: "vercel.*",
        action: "block",
      });
      const result = yield* Effect.result(executor.execute(addr(VERCEL, "delete"), {}));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("ToolBlockedError")(result.failure)).toBe(true);
    }),
  );
});

describe("tools.schemas", () => {
  /** Count core reads per table, so a batch proves how many policy, tool and
   *  definition reads it spends. */
  const countingDb = (db: FumaDb, reads: Record<string, number>): FumaDb => {
    const wrap = (inner: FumaDb): FumaDb =>
      new Proxy(inner, {
        get(target, property) {
          if (property === "withContext") {
            return (context: unknown) =>
              wrap((target.withContext as (value: unknown) => FumaDb)(context));
          }
          if (property === "findMany" || property === "findFirst") {
            return (...args: Parameters<FumaDb["findMany"]>) => {
              const [table] = args;
              reads[table] = (reads[table] ?? 0) + 1;
              return (target[property] as (...inner: typeof args) => unknown)(...args);
            };
          }
          return Reflect.get(target, property);
        },
      });
    return wrap(db);
  };

  const setupCounting = () =>
    Effect.gen(function* () {
      const reads: Record<string, number> = {};
      const config = makeTestConfig({ plugins: [policyTestPlugin()] as const });
      const executor = yield* createExecutor({ ...config, db: countingDb(config.db, reads) });
      yield* Effect.addFinalizer(() =>
        executor
          .close()
          .pipe(Effect.andThen(Effect.promise(() => config.testDb.close())), Effect.ignore),
      );
      yield* executor.ptest.seed();
      for (const integration of [VERCEL, GITHUB]) {
        yield* executor.connections.create({
          owner: "org",
          name: CONN,
          integration,
          template: TEMPLATE,
          from: { provider: ProviderKey.make("memory"), id: ProviderItemId.make("v") },
        });
      }
      const reset = () => {
        for (const key of Object.keys(reads)) delete reads[key];
      };
      return { executor, reads, reset };
    });

  it.effect("answers per address exactly as schema does, in input order", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* executor.policies.create({
        owner: "org",
        pattern: "vercel.*.*.delete",
        action: "block",
      });
      yield* executor.policies.create({ owner: "org", pattern: "github.*", action: "approve" });
      const addresses = [
        addr(VERCEL, "deploy"),
        addr(VERCEL, "delete"),
        addr(GITHUB, "list"),
        addr(VERCEL, "missing"),
        ToolAddress.make("not-a-tool-address"),
        addr(VERCEL, "deploy"),
      ];
      const batched = yield* executor.tools.schemas(addresses);
      const single = yield* Effect.forEach(addresses, (address) => executor.tools.schema(address));
      expect(batched).toEqual(single);
      expect(batched.map((view) => view?.name ?? null)).toEqual([
        "deploy",
        null,
        "list",
        null,
        null,
        "deploy",
      ]);
      expect(batched[0]?.annotations).toEqual(single[0]?.annotations);
      expect(batched[2]?.inputTypeScript).toEqual(single[2]?.inputTypeScript);

      const compact = yield* executor.tools.schemas(addresses, { typeScript: false });
      expect(compact).toEqual(
        yield* Effect.forEach(addresses, (address) =>
          executor.tools.schema(address, { typeScript: false }),
        ),
      );
      expect(compact[0]?.inputTypeScript).toBeUndefined();
      expect(yield* executor.tools.schemas([])).toEqual([]);
    }),
  );

  it.effect("sees a policy change between calls", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      const addresses = [addr(VERCEL, "deploy"), addr(VERCEL, "delete")];
      const before = yield* executor.tools.schemas(addresses);
      expect(before.map((view) => view?.name)).toEqual(["deploy", "delete"]);

      const rule = yield* executor.policies.create({
        owner: "org",
        pattern: "vercel.*",
        action: "block",
      });
      const blocked = yield* executor.tools.schemas(addresses);
      expect(blocked).toEqual([null, null]);
      expect(blocked).toEqual(
        yield* Effect.forEach(addresses, (address) => executor.tools.schema(address)),
      );

      yield* executor.policies.remove({ id: String(rule.id), owner: "org" });
      const restored = yield* executor.tools.schemas(addresses);
      expect(restored.map((view) => view?.name)).toEqual(["deploy", "delete"]);
    }),
  );

  it.effect("keeps a user block over an org approve for the same tool", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* executor.policies.create({ owner: "org", pattern: "vercel.*", action: "approve" });
      yield* executor.policies.create({
        owner: "user",
        pattern: "vercel.*.*.deploy",
        action: "block",
      });
      const addresses = [addr(VERCEL, "deploy"), addr(VERCEL, "delete")];
      const batched = yield* executor.tools.schemas(addresses);
      expect(batched.map((view) => view?.name ?? null)).toEqual([null, "delete"]);
      expect(batched).toEqual(
        yield* Effect.forEach(addresses, (address) => executor.tools.schema(address)),
      );
    }),
  );

  it.effect("reads policy once per batch, and tools and definitions once per connection", () =>
    Effect.gen(function* () {
      const { executor, reads, reset } = yield* setupCounting();
      const addresses = [
        addr(VERCEL, "deploy"),
        addr(VERCEL, "delete"),
        addr(GITHUB, "list"),
        addr(VERCEL, "missing"),
      ];

      reset();
      yield* Effect.forEach(addresses, (address) =>
        executor.tools.schema(address, { typeScript: false }),
      );
      expect(reads.tool_policy).toBe(4);
      expect(reads.tool).toBe(4);
      expect(reads.definition).toBe(3);

      reset();
      yield* executor.tools.schemas(addresses, { typeScript: false });
      expect(reads.tool_policy).toBe(1);
      expect(reads.tool).toBe(2);
      expect(reads.definition).toBe(2);
    }).pipe(Effect.scoped),
  );
});

describe("active tool-policy provider", () => {
  const staticPlugin = definePlugin(() => ({
    id: "toolkit-fixture" as const,
    storage: () => ({}),
    staticIntegrations: () => [
      {
        id: "toolkit-fixture.ctl",
        kind: "control" as const,
        name: "Toolkit Fixture",
        tools: [
          tool({
            name: "allowed",
            description: "allowed",
            inputSchema: Schema.toStandardSchemaV1(
              Schema.toStandardJSONSchemaV1(Schema.Struct({})),
            ),
            execute: () => Effect.succeed("allowed"),
          }),
          tool({
            name: "hidden",
            description: "hidden",
            inputSchema: Schema.toStandardSchemaV1(
              Schema.toStandardJSONSchemaV1(Schema.Struct({})),
            ),
            execute: () => Effect.succeed("hidden"),
          }),
        ],
      },
    ],
  }))();

  const policyProviderPlugin = definePlugin(() => ({
    id: "toolkit-policy-provider" as const,
    storage: () => ({}),
    toolPolicyProvider: () => ({
      list: () =>
        Effect.succeed([
          {
            id: "allow-static",
            pattern: "toolkit-fixture.ctl.allowed",
            action: "approve" as const,
            position: "a0",
          },
        ]),
    }),
  }))();

  it.effect("uses provider rules as an allowlist for list, schema, and execute", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [staticPlugin, policyProviderPlugin] as const,
      });

      const tools = yield* executor.tools.list();
      expect(tools.map((t) => String(t.address)).sort()).toEqual(["toolkit-fixture.ctl.allowed"]);

      const allowedSchema = yield* executor.tools.schema(
        ToolAddress.make("toolkit-fixture.ctl.allowed"),
      );
      expect(allowedSchema?.name).toBe("allowed");

      const hiddenSchema = yield* executor.tools.schema(
        ToolAddress.make("toolkit-fixture.ctl.hidden"),
      );
      expect(hiddenSchema).toBeNull();
      const batched = yield* executor.tools.schemas([
        ToolAddress.make("toolkit-fixture.ctl.hidden"),
        ToolAddress.make("toolkit-fixture.ctl.allowed"),
      ]);
      expect(batched).toEqual([null, allowedSchema]);

      const allowed = yield* executor.execute(ToolAddress.make("toolkit-fixture.ctl.allowed"), {});
      expect(allowed).toBe("allowed");

      const blocked = yield* Effect.result(
        executor.execute(ToolAddress.make("toolkit-fixture.ctl.hidden"), {}),
      );
      expect(Result.isFailure(blocked)).toBe(true);
      if (!Result.isFailure(blocked)) return;
      expect(Predicate.isTagged("ToolBlockedError")(blocked.failure)).toBe(true);
    }),
  );
});

describe("approve / require_approval interaction with annotations", () => {
  it.effect("approve skips the elicitation prompt even when plugin requires approval", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* executor.policies.create({
        owner: "org",
        pattern: "vercel.*.*.delete",
        action: "approve",
      });
      const calls = { count: 0 };
      const result = yield* executor.execute(
        addr(VERCEL, "delete"),
        {},
        { onElicitation: recordingHandler(calls) },
      );
      expect(calls.count).toBe(0);
      expect(result).toEqual({ ran: "vercel.delete" });
    }),
  );

  it.effect("require_approval forces the prompt for tools the plugin would auto-approve", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* executor.policies.create({
        owner: "org",
        pattern: "vercel.*.*.deploy",
        action: "require_approval",
      });
      const calls = { count: 0 };
      yield* executor.execute(
        addr(VERCEL, "deploy"),
        {},
        { onElicitation: recordingHandler(calls) },
      );
      expect(calls.count).toBe(1);
    }),
  );

  it.effect("require_approval surfaces ElicitationDeclined when user declines", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      yield* executor.policies.create({
        owner: "org",
        pattern: "vercel.*.*.deploy",
        action: "require_approval",
      });
      const result = yield* Effect.result(
        executor.execute(addr(VERCEL, "deploy"), {}, { onElicitation: decliningHandler }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(Predicate.isTagged("ElicitationDeclinedError")(result.failure)).toBe(true);
    }),
  );

  it.effect("absence of policy falls through to plugin annotation", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      const calls = { count: 0 };
      // delete is marked requiresApproval by the plugin → prompt fires.
      yield* executor.execute(
        addr(VERCEL, "delete"),
        {},
        { onElicitation: recordingHandler(calls) },
      );
      expect(calls.count).toBe(1);
      // deploy has no plugin-required approval and no policy → no prompt.
      yield* executor.execute(
        addr(VERCEL, "deploy"),
        {},
        { onElicitation: recordingHandler(calls) },
      );
      expect(calls.count).toBe(1);
    }),
  );
});

describe("tools.schema policy read", () => {
  it.effect("narrowed rule reads keep list and schema visibility identical", () =>
    Effect.gen(function* () {
      const executor = yield* setupExecutor();
      // Exact rules for other tools never match; wildcard and exact rules for
      // the tool itself decide. Mix both owners' worth of shapes.
      yield* executor.policies.create({ owner: "org", pattern: "*", action: "block" });
      yield* executor.policies.create({
        owner: "org",
        pattern: `vercel.org.${CONN}.deploy`,
        action: "approve",
      });
      yield* executor.policies.create({ owner: "org", pattern: "github.*", action: "approve" });
      yield* executor.policies.create({
        owner: "org",
        pattern: `github.org.${CONN}.list`,
        action: "block",
      });
      for (const name of ["a", "b", "c"]) {
        yield* executor.policies.create({
          owner: "org",
          pattern: `vercel.org.${CONN}.${name}`,
          action: "approve",
        });
      }

      const visible = new Set((yield* executor.tools.list()).map((tool) => String(tool.address)));
      for (const address of [addr(VERCEL, "delete"), addr(GITHUB, "list")]) {
        expect(yield* executor.tools.schema(address)).toBeNull();
        expect(yield* executor.tools.schema(address, { typeScript: false })).toBeNull();
      }
      for (const address of [addr(VERCEL, "deploy")]) {
        const full = yield* executor.tools.schema(address);
        const lean = yield* executor.tools.schema(address, { typeScript: false });
        expect(full !== null).toBe(visible.has(String(address)));
        expect(lean !== null).toBe(visible.has(String(address)));
        expect(full).not.toBeNull();
        expect(lean).not.toBeNull();
        {
          expect(lean!.inputTypeScript).toBeUndefined();
          expect(lean!.outputTypeScript).toBeUndefined();
          expect(lean!.typeScriptDefinitions).toBeUndefined();
          const {
            inputTypeScript: _i,
            outputTypeScript: _o,
            typeScriptDefinitions: _d,
            ...rest
          } = full!;
          expect({ ...lean }).toEqual(rest);
        }
      }
      expect([...visible].sort()).toEqual([String(addr(VERCEL, "deploy"))]);
    }),
  );
});
