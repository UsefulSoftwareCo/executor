// Cross-target: the policy-mutation core tools gate themselves on human
// approval via their OWN `requiresApproval` annotation, with no policy in play.
//
// This is the regression guard for the approval-bypass finding: a prior rewrite
// of `coreTools` dropped the `requiresApproval` annotations from the policy
// tools, so prompt-injected sandbox code could call
// `tools.executor.coreTools.policies.create({ pattern: "*", action: "approve" })`
// and silently disable every other approval gate. Here the sandbox calls
// `policies.create` directly with NO matching policy present, so the only thing
// that can pause the execution is the tool's annotation. If the annotation is
// missing the call runs silently and the "Execution paused" assertion fails.
//
// Runs over MCP in model-managed elicitation mode (no browser): a gated call
// returns a paused result carrying an `executionId`; `resume` accepts or
// declines it. The created policy is a `block` rule on a unique, non-matching
// pattern, so even a leak cannot gate another scenario's tools; it is removed in
// an `ensuring` finalizer regardless.
import { randomUUID } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";

const coreApi = composePluginApi([] as const);

/** Sandbox code that creates a policy through the gated core tool. The pattern
 *  is unique-per-run and matches no real tool, so the rule is inert. */
const createPolicyCode = (pattern: string) => `
const result = await tools.executor.coreTools.policies.create({
  owner: "user",
  pattern: ${JSON.stringify(pattern)},
  action: "block",
});
return JSON.stringify(result);
`;

scenario(
  "Policy tools · policies.create pauses for approval from its own annotation, then runs once approved",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const apiSurface = yield* Api;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const client = yield* apiSurface.client(coreApi, identity);
    const pattern = `policy-guard-approve-${randomUUID().slice(0, 8)}.*`;

    // Best-effort removal of any policy left under `pattern` for this identity.
    const cleanup = client.policies.list().pipe(
      Effect.flatMap((list) =>
        Effect.forEach(
          list.filter((p) => p.pattern === pattern),
          (p) =>
            client.policies
              .remove({ params: { policyId: p.id }, payload: { owner: "user" } })
              .pipe(Effect.ignore),
        ),
      ),
      Effect.ignore,
    );

    yield* Effect.gen(function* () {
      const session = mcp.session(identity);

      // Warm the OAuth handshake before the gated call.
      const tools = yield* session.listTools();
      expect(tools).toContain("execute");

      // No policy exists for `policies.create` here — the only thing that can
      // pause this call is the tool's `requiresApproval` annotation.
      const paused = yield* session.call("execute", { code: createPolicyCode(pattern) });
      expect(
        paused.text,
        "policies.create paused for approval with no policy present (annotation guard)",
      ).toContain("Execution paused");
      expect(paused.text, "paused result carries the executionId").toContain("executionId:");

      // The policy must not exist until the human approves.
      const beforeApproval = yield* client.policies.list();
      expect(
        beforeApproval.some((p) => p.pattern === pattern),
        "policy is not written while the approval is still pending",
      ).toBe(false);

      const resumed = yield* session.approvePaused(paused.text);
      expect(resumed.ok, "resumed execution completed without error").toBe(true);

      const afterApproval = yield* client.policies.list();
      expect(
        afterApproval.some((p) => p.pattern === pattern),
        "policy is written only after the human approves",
      ).toBe(true);
    }).pipe(Effect.ensuring(cleanup));
  }),
);

scenario(
  "Policy tools · declining the approval blocks policies.create",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const apiSurface = yield* Api;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const client = yield* apiSurface.client(coreApi, identity);
    const pattern = `policy-guard-decline-${randomUUID().slice(0, 8)}.*`;

    const cleanup = client.policies.list().pipe(
      Effect.flatMap((list) =>
        Effect.forEach(
          list.filter((p) => p.pattern === pattern),
          (p) =>
            client.policies
              .remove({ params: { policyId: p.id }, payload: { owner: "user" } })
              .pipe(Effect.ignore),
        ),
      ),
      Effect.ignore,
    );

    yield* Effect.gen(function* () {
      const session = mcp.session(identity);
      yield* session.listTools();

      const paused = yield* session.call("execute", { code: createPolicyCode(pattern) });
      expect(paused.text, "policies.create paused for approval (annotation guard)").toContain(
        "Execution paused",
      );

      const match = /\bexecutionId:\s*(\S+)/.exec(paused.text);
      expect(match, "paused result carries an executionId to resume").not.toBeNull();
      yield* session.call("resume", { executionId: match![1], action: "decline" });

      const list = yield* client.policies.list();
      expect(
        list.some((p) => p.pattern === pattern),
        "declined policies.create never wrote the policy",
      ).toBe(false);
    }).pipe(Effect.ensuring(cleanup));
  }),
);
