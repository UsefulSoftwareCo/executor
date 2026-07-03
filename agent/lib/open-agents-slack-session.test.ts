import { beforeEach, describe, expect, mock, test } from "bun:test";

const slackLinks = new Map<string, string>();
const existingThreadSession = {
  chatId: "chat-1",
  linkPostedAt: new Date("2026-07-02T00:00:00.000Z"),
  sessionId: "session-1",
  userId: "creator-user",
};
const sentHeaders: Array<Record<string, string>> = [];

function linkKey(teamId: string, userId: string) {
  return `${teamId}:${userId}`;
}

function sqlTag(strings: TemplateStringsArray, ...values: unknown[]) {
  const query = strings.join("$");

  if (query.includes("from slack_user_links")) {
    const teamId = String(values[0]);
    const slackUserId = String(values[1]);
    const userId = slackLinks.get(linkKey(teamId, slackUserId));
    return Promise.resolve(userId ? [{ userId }] : []);
  }

  if (query.includes("from slack_thread_sessions")) {
    return Promise.resolve([existingThreadSession]);
  }

  if (query.includes("from eve_chat_events")) {
    return Promise.resolve([]);
  }

  if (query.includes("from eve_chat_session_states")) {
    return Promise.resolve([]);
  }

  return Promise.resolve([]);
}

sqlTag.begin = async (callback: (tx: typeof sqlTag) => Promise<void>) => callback(sqlTag);
sqlTag.json = (value: unknown) => value;

mock.module("postgres", () => ({
  default: () => sqlTag,
}));

mock.module("@open-agents/sandbox", () => ({
  connectSandbox: async () => ({ getState: () => ({ type: "vercel" }) }),
}));

mock.module("@open-agents/sandbox/session-clis.js", () => ({
  installConfiguredSessionClis: async () => {},
}));

mock.module("@vercel/oidc", () => ({
  getVercelOidcToken: async () => "oidc-token",
}));

mock.module("eve/client", () => ({
  Client: class MockClient {
    session(state: Record<string, unknown>) {
      return {
        state,
        send: async (input: { headers: Record<string, string> }) => {
          sentHeaders.push(input.headers);
          return {
            continuationToken: "continue-1",
            sessionId: "eve-session-1",
            async *[Symbol.asyncIterator]() {},
          };
        },
      };
    }
  },
  isCurrentTurnBoundaryEvent: () => true,
}));

const slackSessionModulePromise = import("./open-agents-slack-session");

function slackMessage(slackUserId: string) {
  return {
    attachments: [],
    author: { userId: slackUserId },
    channelId: "C123",
    markdown: "do the thing",
    teamId: "T123",
    text: "do the thing",
    threadTs: "1710000000.000000",
  };
}

describe("Open Agents Slack actor attribution", () => {
  beforeEach(() => {
    slackLinks.clear();
    sentHeaders.length = 0;
    slackLinks.set(linkKey("T123", "UCREATOR"), "creator-user");
    slackLinks.set(linkKey("T123", "UOTHER"), "other-user");
  });

  test("existing thread from the creator acts as the creator", async () => {
    const { getOrCreateOpenAgentsSlackSession, runOpenAgentsSlackTurn } =
      await slackSessionModulePromise;

    const session = await getOrCreateOpenAgentsSlackSession({
      slackChannelId: "C123",
      slackTeamId: "T123",
      slackThreadTs: "1710000000.000000",
      slackUserId: "UCREATOR",
      text: "do the thing",
    });
    expect(session?.turnActorId).toBe("creator-user");

    await runOpenAgentsSlackTurn({ message: slackMessage("UCREATOR"), session: session! });

    expect(sentHeaders[0]?.["x-open-agents-user-id"]).toBe("creator-user");
  });

  test("existing thread from another linked user acts as that user, not the creator", async () => {
    const { getOrCreateOpenAgentsSlackSession, runOpenAgentsSlackTurn } =
      await slackSessionModulePromise;

    const session = await getOrCreateOpenAgentsSlackSession({
      slackChannelId: "C123",
      slackTeamId: "T123",
      slackThreadTs: "1710000000.000000",
      slackUserId: "UOTHER",
      text: "do the thing",
    });
    expect(session?.userId).toBe("creator-user");
    expect(session?.turnActorId).toBe("other-user");

    await runOpenAgentsSlackTurn({ message: slackMessage("UOTHER"), session: session! });

    expect(sentHeaders[0]?.["x-open-agents-user-id"]).toBe("other-user");
    expect(sentHeaders[0]?.["x-open-agents-user-id"]).not.toBe("creator-user");
  });

  test("existing thread from an unlinked user acts as a Slack principal, not the creator", async () => {
    const { getOrCreateOpenAgentsSlackSession, runOpenAgentsSlackTurn } =
      await slackSessionModulePromise;

    const session = await getOrCreateOpenAgentsSlackSession({
      slackChannelId: "C123",
      slackTeamId: "T123",
      slackThreadTs: "1710000000.000000",
      slackUserId: "UUNLINKED",
      text: "do the thing",
    });
    expect(session?.userId).toBe("creator-user");
    expect(session?.turnActorId).toBe("slack:T123:UUNLINKED");

    await runOpenAgentsSlackTurn({ message: slackMessage("UUNLINKED"), session: session! });

    expect(sentHeaders[0]?.["x-open-agents-user-id"]).toBe("slack:T123:UUNLINKED");
    expect(sentHeaders[0]?.["x-open-agents-user-id"]).not.toBe("creator-user");
  });
});
