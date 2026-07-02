// Cross-target: the Run/Test panel's backend (`POST /executions`) auto-approves
// approval-gated tools when the operator invokes them, because clicking Run in
// the panel IS the human approval.
//
// The panel sends `autoApprove: true`. Here we drive the same HTTP endpoint the
// panel uses and prove both halves of the contract against ONE tool that gates
// itself: the `policies.create` core tool carries a `requiresApproval`
// annotation, so with no matching policy in play the annotation is the only
// thing that can pause the call.
//
//   - without `autoApprove`: the call pauses (the panel would have dead-ended
//     on "This tool requires approval"), and the policy is not written.
//   - with `autoApprove`: the call runs to completion and the policy is written.
//
// The created policy is a `block` rule on a unique, non-matching pattern, so a
// leak cannot gate another scenario's tools; it is removed in an `ensuring`
// finalizer regardless.
import { randomUUID } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const coreApi = composePluginApi([] as const);

/** Sandbox code that creates a policy through the approval-gated core tool. The
 *  pattern is unique-per-run and matches no real tool, so the rule is inert. */
const createPolicyCode = (pattern: string) => `
return await tools.executor.coreTools.policies.create({
  owner: "user",
  pattern: ${JSON.stringify(pattern)},
  action: "block",
});
`;

scenario(
  "Run panel · autoApprove runs an approval-gated tool that otherwise pauses",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const apiSurface = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* apiSurface.client(coreApi, identity);
    const pattern = `run-auto-approve-${randomUUID().slice(0, 8)}.*`;
    const code = createPolicyCode(pattern);

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
      // Baseline: without autoApprove the gated tool pauses (the panel's old
      // dead-end), and the side effect must not have happened.
      const gated = yield* client.executions.execute({ payload: { code } });
      expect(gated.status, "a gated tool pauses without autoApprove").toBe("paused");

      const beforeApproval = yield* client.policies.list();
      expect(
        beforeApproval.some((p) => p.pattern === pattern),
        "the policy is not written while the call is paused for approval",
      ).toBe(false);

      // Release the paused fiber so it does not linger waiting on a response.
      if (gated.status === "paused") {
        const executionId = (gated.structured as { readonly executionId?: string }).executionId;
        if (executionId) {
          yield* client.executions
            .resume({ params: { executionId }, payload: { action: "cancel" } })
            .pipe(Effect.ignore);
        }
      }

      // With autoApprove the operator IS the approver: the same call runs to
      // completion and the side effect lands.
      const approved = yield* client.executions.execute({
        payload: { code, autoApprove: true },
      });
      expect(approved.status, "autoApprove runs the gated tool to completion").toBe("completed");
      if (approved.status !== "completed") return; // narrowing only
      expect(approved.isError, "the auto-approved run is not an error").toBe(false);

      const afterApproval = yield* client.policies.list();
      expect(
        afterApproval.some((p) => p.pattern === pattern),
        "the policy is written once autoApprove runs the gated tool",
      ).toBe(true);
    }).pipe(Effect.ensuring(cleanup));
  }),
);
