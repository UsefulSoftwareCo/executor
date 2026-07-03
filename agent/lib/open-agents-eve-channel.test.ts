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
        "x-open-agents-user-id": "user-authenticated",
        "x-open-agents-session-id": "session-1",
        "x-open-agents-chat-id": "chat-1",
      }),
    );

    expect(result?.subject).toBe("user-authenticated");
    expect(result?.attributes).toMatchObject({
      openAgentsUserId: "user-authenticated",
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
        "x-open-agents-user-id": "server-selected-user",
      }),
    );

    expect(result?.subject).toBe("server-selected-user");
    expect(result?.attributes.openAgentsUserId).toBe("server-selected-user");
  });
});
