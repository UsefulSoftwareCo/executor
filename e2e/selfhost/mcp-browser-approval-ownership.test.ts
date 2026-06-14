// Selfhost-only: the browser-approval HTTP endpoints are session-scoped. A
// signed-in user who does not own the MCP session must not be able to read the
// paused execution or record the human decision for it.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";
import { parseBrowserApproval } from "../src/surfaces/mcp";
import type { Identity } from "../src/target";
import { signInSession } from "../targets/selfhost";

const coreApi = composePluginApi([] as const);

const APPROVAL_TARGET_TOOL = "executor.coreTools.policies.list";
const EXECUTE_CODE = `
const result = await tools.executor.coreTools.policies.list({});
return JSON.stringify(result);
`;

const createInvitedIdentity = async (baseUrl: string, admin: Identity): Promise<Identity> => {
  const cookie = admin.headers?.cookie;
  expect(typeof cookie, "bootstrap admin has a Better Auth session cookie").toBe("string");

  const invite = await fetch(new URL("/api/admin/invites", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: cookie!,
      origin: new URL(baseUrl).origin,
    },
    body: JSON.stringify({ role: "member" }),
  });
  expect(invite.status, `admin invite create response: ${await invite.clone().text()}`).toBe(200);
  const inviteBody = (await invite.json()) as { readonly code?: string };
  expect(typeof inviteBody.code, "invite response includes a redeemable code").toBe("string");

  const email = `approval-cross-user-${randomBytes(5).toString("hex")}@e2e.test`;
  const password = "approval-cross-user-password-123";
  const signup = await fetch(new URL("/api/auth/sign-up/email", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(baseUrl).origin },
    body: JSON.stringify({
      email,
      password,
      name: email,
      inviteCode: inviteBody.code,
    }),
  });
  expect(signup.status, `invited signup response: ${await signup.clone().text()}`).toBe(200);

  const session = await signInSession(baseUrl, { email, password });
  return {
    label: email,
    credentials: { email, password },
    headers: { cookie: session.cookieHeader },
    cookies: session.cookies,
  };
};

const approvalEndpoint = (baseUrl: string, sessionId: string, executionId: string): URL =>
  new URL(
    `/api/mcp-sessions/${encodeURIComponent(sessionId)}/executions/${encodeURIComponent(
      executionId,
    )}`,
    baseUrl,
  );

scenario(
  "MCP browser approval · another self-host user cannot act on someone else's paused session",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const api = yield* Api;
    const mcp = yield* Mcp;
    const owner = yield* target.newIdentity();
    const other = yield* Effect.promise(() => createInvitedIdentity(target.baseUrl, owner));
    const client = yield* api.client(coreApi, owner);

    const policy = yield* client.policies.create({
      payload: { owner: "org", pattern: APPROVAL_TARGET_TOOL, action: "require_approval" },
    });

    yield* Effect.gen(function* () {
      const session = mcp.session(owner, { elicitationMode: "browser" });
      yield* session.listTools();

      const paused = yield* session.call("execute", { code: EXECUTE_CODE });
      const approval = parseBrowserApproval(paused);
      const approvalUrl = new URL(approval.approvalUrl);
      const mcpSessionId = approvalUrl.searchParams.get("mcp_session_id");
      expect(typeof mcpSessionId, "approval URL is tied to the MCP session").toBe("string");

      const otherHeaders = {
        cookie: other.headers!.cookie,
        origin: new URL(target.baseUrl).origin,
      };
      const detail = yield* Effect.promise(() =>
        fetch(approvalEndpoint(target.baseUrl, mcpSessionId!, approval.executionId), {
          headers: otherHeaders,
        }),
      );
      expect([403, 404], "a different signed-in user cannot read the paused execution").toContain(
        detail.status,
      );

      const decision = yield* Effect.promise(() =>
        fetch(
          new URL(
            `${approvalEndpoint(target.baseUrl, mcpSessionId!, approval.executionId).pathname}/resume`,
            target.baseUrl,
          ),
          {
            method: "POST",
            headers: {
              ...otherHeaders,
              "content-type": "application/json",
            },
            body: JSON.stringify({ action: "accept" }),
          },
        ),
      );
      expect(
        [403, 404],
        "a different signed-in user cannot approve the paused execution",
      ).toContain(decision.status);
    }).pipe(
      Effect.ensuring(
        client.policies
          .remove({ params: { policyId: policy.id }, payload: { owner: "org" } })
          .pipe(Effect.ignore),
      ),
    );
  }),
);
