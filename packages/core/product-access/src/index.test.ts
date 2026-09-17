import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref } from "effect";

import {
  CurrentOrgWriteAccess,
  makeOrgWriteAccessState,
  type ToolPolicyRow,
} from "@executor-js/sdk/core";

import {
  memberAccess,
  memberAccessForRole,
  orgWriteAccessForRole,
  platformObserverAccess,
  requestBoundMemberAccess,
  singleUserAccess,
  workspaceServiceAccess,
} from "./index";
import { resolveProviderPolicyFromRules, standardToolPolicy } from "./policy";

describe("orgWriteAccessForRole", () => {
  it("trusts the single user of a deployment without a role model", () => {
    expect(orgWriteAccessForRole({ orgRoleModel: "none" })).toBe("allowed");
  });

  it("lets admins configure the workspace under a role model", () => {
    expect(orgWriteAccessForRole({ orgRoleModel: "organization", orgRole: "admin" })).toBe(
      "allowed",
    );
  });

  it("denies plain members", () => {
    expect(orgWriteAccessForRole({ orgRoleModel: "organization", orgRole: "member" })).toBe(
      "denied",
    );
  });

  it("fails closed when a role model is present but the role is missing", () => {
    expect(orgWriteAccessForRole({ orgRoleModel: "organization" })).toBe("denied");
  });
});

describe("settings-write rules", () => {
  it.effect("the role decision gates workspace targets; personal stays open", () =>
    Effect.gen(function* () {
      const member = memberAccessForRole({ orgRoleModel: "organization", orgRole: "member" });
      const admin = memberAccessForRole({ orgRoleModel: "organization", orgRole: "admin" });
      expect(yield* member.settingsWrite({ kind: "workspace" })).toBe("denied");
      expect(yield* member.settingsWrite({ kind: "owner", owner: "org" })).toBe("denied");
      expect(yield* member.settingsWrite({ kind: "owner", owner: "user" })).toBe("allowed");
      expect(yield* admin.settingsWrite({ kind: "workspace" })).toBe("allowed");
      expect(admin.owners).toEqual(["user", "org"]);
      expect(admin.capabilities).toEqual({ adminReads: false, storageWrites: "allowed" });
    }),
  );

  it.effect("requestBoundMemberAccess fails closed without a request binding", () =>
    Effect.gen(function* () {
      const access = requestBoundMemberAccess();
      expect(yield* access.settingsWrite({ kind: "workspace" })).toBe("denied");
      // Personal targets never consult the request decision.
      expect(yield* access.settingsWrite({ kind: "owner", owner: "user" })).toBe("allowed");
    }),
  );

  it.effect("requestBoundMemberAccess reads the live request binding at every ask", () =>
    Effect.gen(function* () {
      const access = requestBoundMemberAccess();
      const state = makeOrgWriteAccessState("allowed");
      const ask = access
        .settingsWrite({ kind: "owner", owner: "org" })
        .pipe(Effect.provideService(CurrentOrgWriteAccess, state));
      expect(yield* ask).toBe("allowed");
      // The engine re-stamps this Ref from the resuming principal; the SAME
      // access value must observe the new decision, not a snapshot.
      yield* Ref.set(state.current, "denied");
      expect(yield* ask).toBe("denied");
    }),
  );

  it.effect("single-user and workspace-service postures allow workspace writes", () =>
    Effect.gen(function* () {
      const single = singleUserAccess();
      const service = workspaceServiceAccess();
      expect(yield* single.settingsWrite({ kind: "workspace" })).toBe("allowed");
      expect(single.owners).toEqual(["user", "org"]);
      expect(yield* service.settingsWrite({ kind: "workspace" })).toBe("allowed");
      expect(service.owners).toEqual(["org"]);
      expect(yield* memberAccess("denied").settingsWrite({ kind: "workspace" })).toBe("denied");
    }),
  );

  it("the platform observer is a subject-less read-only view with admin reads", () => {
    const access = platformObserverAccess();
    expect(access.owners).toEqual(["org"]);
    expect(access.capabilities).toEqual({ adminReads: true, storageWrites: "denied" });
  });
});

describe("standardToolPolicy", () => {
  const row = (
    id: string,
    owner: "org" | "user",
    pattern: string,
    action: "approve" | "require_approval" | "block",
  ): ToolPolicyRow =>
    ({
      id,
      owner,
      subject: owner === "org" ? "" : "u",
      pattern,
      action,
      position: "a0",
      created_at: new Date(0),
      updated_at: new Date(0),
    }) as ToolPolicyRow;

  const evaluate = (
    rows: readonly ReturnType<typeof row>[],
    toolId: string,
    defaultRequiresApproval?: boolean,
  ) =>
    Effect.gen(function* () {
      const evaluator = yield* standardToolPolicy(["user", "org"])({
        policyRows: Effect.succeed(rows),
        provider: null,
      });
      return yield* evaluator.resolve({ toolId, defaultRequiresApproval });
    });

  it.effect("an org guardrail beats a user preference", () =>
    Effect.gen(function* () {
      const effective = yield* evaluate(
        [
          row("outer", "org", "vercel.*", "block"),
          row("inner", "user", "vercel.dns.create", "approve"),
        ],
        "vercel.dns.create",
      );
      expect(effective).toMatchObject({ action: "block", policyId: "outer" });
    }),
  );

  it.effect("no authored match falls back to the plugin default", () =>
    Effect.gen(function* () {
      expect(yield* evaluate([], "vercel.dns.create", true)).toMatchObject({
        action: "require_approval",
        source: "plugin-default",
      });
      expect(yield* evaluate([], "vercel.dns.create")).toMatchObject({
        action: "approve",
        source: "plugin-default",
      });
    }),
  );

  it.effect("a list-only provider is an allowlist: unmatched tools block", () =>
    Effect.gen(function* () {
      const evaluator = yield* standardToolPolicy(["user", "org"])({
        policyRows: Effect.succeed([]),
        provider: {
          list: () =>
            Effect.succeed([
              { id: "r1", pattern: "github.*", action: "approve" as const, position: "a0" },
            ]),
        },
      });
      expect(yield* evaluator.resolve({ toolId: "github.org.acme.repos.list" })).toMatchObject({
        action: "approve",
      });
      expect(yield* evaluator.resolve({ toolId: "vercel.org.acme.deploy" })).toMatchObject({
        action: "block",
        pattern: "*",
      });
    }),
  );

  it("resolveProviderPolicyFromRules picks the first match by position", () => {
    const rules = [
      { id: "b", pattern: "github.*", action: "block" as const, position: "a1" },
      { id: "a", pattern: "github.*", action: "approve" as const, position: "a0" },
    ];
    expect(resolveProviderPolicyFromRules("github.x", rules)).toMatchObject({ policyId: "a" });
  });
});
