import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";
import { joinOrg } from "./support/session";

const api = composePluginApi([] as const);

const createPolicyCode = (pattern: string): string => `
const created = await tools.executor.coreTools.policies.create({
  owner: "org",
  pattern: ${JSON.stringify(pattern)},
  action: "approve"
});
return JSON.stringify(created);
`;

scenario(
  "MCP workspace writes · a member session is denied while an admin session succeeds",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const { client: makeClient } = yield* Api;
    const admin = yield* target.newIdentity();
    const invitee = yield* target.newIdentity({ org: false });
    const member = yield* joinOrg(target, admin, invitee);
    const adminClient = yield* makeClient(api, admin);
    const pattern = `executor.mcp-role-${randomBytes(4).toString("hex")}.*`;

    const cleanup = adminClient.policies.list().pipe(
      Effect.flatMap((policies) =>
        Effect.forEach(
          policies.filter((policy) => policy.pattern === pattern),
          (policy) =>
            adminClient.policies
              .remove({ params: { policyId: policy.id }, payload: { owner: "org" } })
              .pipe(Effect.ignore({ log: false })),
          { discard: true },
        ),
      ),
      Effect.ignore({ log: false }),
    );

    yield* Effect.ensuring(
      Effect.gen(function* () {
        const memberSession = mcp.session(member);
        let denied = yield* memberSession.call("execute", { code: createPolicyCode(pattern) });
        if (denied.text.includes("Execution paused")) {
          denied = yield* memberSession.approvePaused(denied.text);
        }
        expect(
          denied.text,
          "the denial preserves the workspace-admin authorization failure",
        ).toMatch(/OrgWriteDenied|administrator|admin/i);
        expect(
          (yield* adminClient.policies.list()).some((policy) => policy.pattern === pattern),
          "the member's denied MCP call persisted no Workspace policy",
        ).toBe(false);

        const adminSession = mcp.session(admin);
        let allowed = yield* adminSession.call("execute", { code: createPolicyCode(pattern) });
        if (allowed.text.includes("Execution paused")) {
          allowed = yield* adminSession.approvePaused(allowed.text);
        }
        expect(allowed.ok, "the admin's MCP workspace-write call succeeds").toBe(true);
        expect(allowed.text, "the created policy is returned over the MCP session").toContain(
          pattern,
        );
        expect(
          (yield* adminClient.policies.list()).some((policy) => policy.pattern === pattern),
          "the admin's MCP call persisted the Workspace policy",
        ).toBe(true);
      }),
      cleanup,
    );
  }),
);
