// Selfhost-only: browser approval must authorize with the actor's current
// organization membership, not Better Auth's global user role. A user invited
// as an admin keeps `user.role = "admin"` after membership demotion, so this
// scenario pauses while privileged, demotes the membership, and proves the
// resumed workspace mutation is denied at the sink.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";
import { parseBrowserApproval } from "../src/surfaces/mcp";
import { createInvitedIdentity } from "../targets/selfhost";

const coreApi = composePluginApi([] as const);
const GATE_TOOL = "executor.coreTools.policies.create";
const CREATED_PATTERN = "selfhost-live-role-regression.*";
const EXECUTE_CODE = `
const result = await tools.executor.coreTools.policies.create({
  owner: "org",
  pattern: ${JSON.stringify(CREATED_PATTERN)},
  action: "block",
});
return JSON.stringify(result);
`;

interface MemberRow {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly role: string;
}

const accountRequest = (
  baseUrl: string,
  cookie: string,
  path: string,
  init?: RequestInit,
): Promise<Response> =>
  fetch(new URL(path, baseUrl), {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init?.headers)),
      cookie,
      origin: new URL(baseUrl).origin,
    },
  });

scenario(
  "MCP browser approval · a demoted self-host admin cannot approve a workspace mutation",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const api = yield* Api;
    const mcp = yield* Mcp;
    const controller = yield* target.newIdentity();
    const actor = yield* Effect.promise(() =>
      createInvitedIdentity(target.baseUrl, controller, {
        role: "admin",
        emailPrefix: "approval-role-actor",
      }),
    );
    const controllerCookie = controller.headers?.cookie;
    const actorCookie = actor.headers?.cookie;
    if (typeof controllerCookie !== "string" || typeof actorCookie !== "string") {
      return yield* Effect.die("self-host identities did not carry session cookies");
    }
    const actorClient = yield* api.client(coreApi, actor);
    const gate = yield* actorClient.policies.create({
      payload: { owner: "org", pattern: GATE_TOOL, action: "require_approval" },
    });

    const membersResponse = yield* Effect.promise(() =>
      accountRequest(target.baseUrl, controllerCookie, "/api/account/members"),
    );
    expect(membersResponse.status, "the controller can list memberships").toBe(200);
    const membersBody = yield* Effect.promise(
      () =>
        membersResponse.json() as Promise<{
          readonly members: readonly MemberRow[];
        }>,
    );
    const actorMember = membersBody.members.find((member) => member.email === actor.label);
    expect(
      actorMember?.role === "admin",
      "the actor begins with privileged organization membership",
    ).toBe(true);
    if (!actorMember) return yield* Effect.die("the actor membership was not listed");

    const setGlobalRole = (role: "admin" | "user"): Effect.Effect<Response> =>
      Effect.promise(() =>
        accountRequest(target.baseUrl, controllerCookie, "/api/auth/admin/set-role", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId: actorMember.userId, role }),
        }),
      );
    const promoted = yield* setGlobalRole("admin");
    expect(promoted.status, "the actor has a stale global admin role to distrust").toBe(200);

    const setRole = (roleSlug: "admin" | "member"): Effect.Effect<Response> =>
      Effect.promise(() =>
        accountRequest(
          target.baseUrl,
          controllerCookie,
          `/api/account/members/${encodeURIComponent(actorMember.id)}/role`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ roleSlug }),
          },
        ),
      );

    yield* Effect.gen(function* () {
      const session = mcp.session(actor, { elicitationMode: "browser" });
      yield* session.listTools();
      const paused = yield* session.call("execute", { code: EXECUTE_CODE });
      const approval = parseBrowserApproval(paused);
      const approvalUrl = new URL(approval.approvalUrl);
      const sessionId = approvalUrl.searchParams.get("mcp_session_id");
      if (sessionId === null) return yield* Effect.die("approval URL carried no MCP session id");

      const demoted = yield* setRole("member");
      expect(demoted.status, "the membership demotion commits before approval").toBe(200);

      const [resumed, decision] = yield* Effect.all(
        [
          session.awaitResume(approval.executionId),
          Effect.promise(() =>
            accountRequest(
              target.baseUrl,
              actorCookie,
              `/api/mcp-sessions/${encodeURIComponent(sessionId)}/executions/${encodeURIComponent(
                approval.executionId,
              )}/resume`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "accept", content: {} }),
              },
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      expect(decision.status, "the browser decision reaches the paused execution").toBe(200);
      expect(resumed.ok, "the resumed sandbox reports the tool result normally").toBe(true);
      expect(
        resumed.text,
        "the resumed workspace mutation preserves the workspace-admin denial",
      ).toMatch(/OrgWriteDenied|administrator|admin/i);
      const policies = yield* actorClient.policies.list();
      expect(
        policies.some((policy) => policy.pattern === CREATED_PATTERN),
        "the demoted actor did not create the workspace policy",
      ).toBe(false);
    }).pipe(
      Effect.ensuring(
        setRole("admin").pipe(
          Effect.andThen(
            actorClient.policies.remove({
              params: { policyId: gate.id },
              payload: { owner: "org" },
            }),
          ),
          Effect.andThen(setGlobalRole("user")),
          Effect.ignore,
        ),
      ),
    );
  }),
);
