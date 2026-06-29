// Selfhost-only: an execution that triggers an approval gate pauses, then
// resumes successfully after `resume` is called with action "accept".
//
// Mechanism: create a `require_approval` policy scoped to the built-in tool
// `executor.coreTools.policies.list` via the typed HTTP API, then execute code
// over MCP that calls that tool. The engine hits the `enforceApproval` path
// and returns a paused result with an `executionId`; `session.approvePaused()`
// resumes it. The policy removal is an `ensuring` finalizer — a leaked
// require_approval gate on a built-in tool would pause unrelated scenarios on
// the shared selfhost instance.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";

const coreApi = composePluginApi([] as const);

const APPROVAL_TARGET_TOOL = "executor.coreTools.policies.list";

const EXECUTE_CODE = `
const result = await tools.executor.coreTools.policies.list({});
return JSON.stringify(result);
`;

scenario(
  "MCP · a paused execution resumes after human approval",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const apiSurface = yield* Api;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const client = yield* apiSurface.client(coreApi, identity);

    const policy = yield* client.policies.create({
      payload: { owner: "org", pattern: APPROVAL_TARGET_TOOL, action: "require_approval" },
    });

    yield* Effect.gen(function* () {
      const session = mcp.session(identity);

      // Warm up the MCP session before the gated call so the OAuth handshake
      // does not race with the policy window.
      const tools = yield* session.listTools();
      expect(tools).toContain("execute");

      const paused = yield* session.call("execute", { code: EXECUTE_CODE });
      expect(paused.text, "execution paused rather than completing").toContain("Execution paused");
      expect(paused.text, "paused result carries the executionId").toContain("executionId:");

      const resumed = yield* session.approvePaused(paused.text);
      expect(resumed.ok, "resumed execution completed without error").toBe(true);
      expect(resumed.text, "the sandbox returned the gated tool's result").toContain(
        APPROVAL_TARGET_TOOL,
      );
    }).pipe(
      // Always remove the gate, even when the test fails or times out.
      Effect.ensuring(
        client.policies
          .remove({ params: { policyId: policy.id }, payload: { owner: "org" } })
          .pipe(Effect.ignore),
      ),
    );
  }),
);
