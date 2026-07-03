import { describe, expect, test } from "bun:test";
import type { SessionAuthContext } from "eve/context";
import { withOpenAgentsRequestAttributes } from "../channels/eve";

const authenticatedSession = {
  authenticator: "test",
  principalId: "user-authenticated",
  principalType: "user",
  subject: "user-authenticated",
  attributes: {},
} satisfies SessionAuthContext;

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request("http://localhost/eve/v1/session", { headers });
}

describe("Open Agents Eve auth attributes", () => {
  test("rejects forged user headers from browser-authenticated requests", async () => {
    const auth = withOpenAgentsRequestAttributes(async () => authenticatedSession);

    const result = await auth(
      requestWithHeaders({
        "x-open-agents-user-id": "forged-user",
        "x-open-agents-session-id": "session-1",
      }),
    );

    expect(result).toBeNull();
  });

  test("binds browser actor headers only when they match the authenticated principal", async () => {
    const auth = withOpenAgentsRequestAttributes(async () => authenticatedSession);

    const result = await auth(
      requestWithHeaders({
        "x-open-agents-user-id": "user:user-authenticated",
        "x-open-agents-session-id": "session-1",
        "x-open-agents-chat-id": "chat-1",
      }),
    );

    expect(result?.subject).toBe("user:user-authenticated");
    expect(result?.attributes).toMatchObject({
      openAgentsActor: "user:user-authenticated",
      openAgentsUserId: "user:user-authenticated",
      openAgentsSessionId: "session-1",
      openAgentsChatId: "chat-1",
    });
  });

  test("trusts server-authenticated OIDC callers to provide the acting user", async () => {
    const auth = withOpenAgentsRequestAttributes(async () => authenticatedSession, {
      trustOpenAgentsUserHeader: true,
    });

    const result = await auth(
      requestWithHeaders({
        "x-open-agents-user-id": "user:server-selected-user",
      }),
    );

    expect(result?.subject).toBe("user:server-selected-user");
    expect(result?.attributes.openAgentsActor).toBe("user:server-selected-user");
    expect(result?.attributes.openAgentsUserId).toBe("user:server-selected-user");
  });

  test("trusts server-authenticated OIDC callers to provide a Slack principal", async () => {
    const auth = withOpenAgentsRequestAttributes(async () => authenticatedSession, {
      trustOpenAgentsUserHeader: true,
    });

    const result = await auth(
      requestWithHeaders({
        "x-open-agents-user-id": "slack:T123:U456",
      }),
    );

    expect(result?.subject).toBe("slack:T123:U456");
    expect(result?.attributes.openAgentsActor).toBe("slack:T123:U456");
    expect(result?.attributes.openAgentsUserId).toBe("slack:T123:U456");
  });
});
