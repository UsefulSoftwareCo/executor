import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { HandleMessageStreamEvent } from "eve/client";

let shareRecord: { id: string; chatId: string } | null = {
  id: "share-1",
  chatId: "chat-1",
};

let chatRecord: {
  id: string;
  sessionId: string;
} | null = {
  id: "chat-1",
  sessionId: "session-1",
};

let sessionRecord: {
  id: string;
  title: string;
  repoOwner: string | null;
  repoName: string | null;
  branch: string | null;
  prNumber: number | null;
  createdAt: Date;
} | null = {
  id: "session-1",
  title: "Debug flaky tests",
  repoOwner: "acme",
  repoName: "repo",
  branch: "fix/flaky-ci",
  prNumber: 123,
  createdAt: new Date("2025-01-01T12:00:00Z"),
};

let eventRows: Array<{ event: HandleMessageStreamEvent; createdAt: Date }> = [];

function eventRow(event: HandleMessageStreamEvent, createdAt: string) {
  return {
    event,
    createdAt: new Date(createdAt),
  };
}

function markdownEventRows() {
  return [
    eventRow(
      {
        type: "message.received",
        data: {
          message: "Please debug the flaky tests.",
          sequence: 1,
          turnId: "turn-1",
        },
      },
      "2025-01-01T12:00:00Z",
    ),
    eventRow(
      {
        type: "reasoning.completed",
        data: {
          reasoning: "Investigating the failure.",
          sequence: 2,
          stepIndex: 0,
          turnId: "turn-1",
        },
      },
      "2025-01-01T12:01:00Z",
    ),
    eventRow(
      {
        type: "actions.requested",
        data: {
          actions: [
            {
              kind: "tool-call",
              callId: "read-file-call",
              toolName: "read_file",
              input: { filePath: "README.md" },
            },
            {
              kind: "tool-call",
              callId: "write-file-call",
              toolName: "write_file",
              input: {
                filePath: "src/test.ts",
                content: "after",
              },
            },
          ],
          sequence: 3,
          stepIndex: 0,
          turnId: "turn-1",
        },
      },
      "2025-01-01T12:02:00Z",
    ),
    eventRow(
      {
        type: "action.result",
        data: {
          result: {
            kind: "tool-result",
            callId: "read-file-call",
            toolName: "read_file",
            output: {
              success: true,
              content: "1: hello",
              totalLines: 1,
              startLine: 1,
              endLine: 1,
            },
          },
          sequence: 4,
          stepIndex: 0,
          status: "completed",
          turnId: "turn-1",
        },
      },
      "2025-01-01T12:03:00Z",
    ),
    eventRow(
      {
        type: "action.result",
        data: {
          result: {
            kind: "tool-result",
            callId: "write-file-call",
            toolName: "write_file",
            output: { success: true },
          },
          sequence: 5,
          stepIndex: 0,
          status: "completed",
          turnId: "turn-1",
        },
      },
      "2025-01-01T12:04:00Z",
    ),
    eventRow(
      {
        type: "message.completed",
        data: {
          finishReason: "stop",
          message: "I fixed the timeout handling.",
          sequence: 6,
          stepIndex: 0,
          turnId: "turn-1",
        },
      },
      "2025-01-01T12:15:00Z",
    ),
  ];
}

mock.module("@/lib/db/sessions-cache", () => ({
  getShareByIdCached: async () => shareRecord,
  getSessionByIdCached: async () => sessionRecord,
}));

mock.module("@/lib/db/sessions", () => ({
  getChatById: async () => chatRecord,
  getEveChatEventRows: async () => eventRows,
}));

const routeModulePromise = import("./route");

function makeRequest(accept = "text/markdown") {
  return new Request("http://localhost/api/shared/share-1/markdown", {
    headers: { Accept: accept },
  });
}

function makeContext(shareId = "share-1") {
  return { params: Promise.resolve({ shareId }) };
}

describe("GET /api/shared/:shareId/markdown", () => {
  beforeEach(() => {
    shareRecord = { id: "share-1", chatId: "chat-1" };
    chatRecord = { id: "chat-1", sessionId: "session-1" };
    sessionRecord = {
      id: "session-1",
      title: "Debug flaky tests",
      repoOwner: "acme",
      repoName: "repo",
      branch: "fix/flaky-ci",
      prNumber: 123,
      createdAt: new Date("2025-01-01T12:00:00Z"),
    };
    eventRows = markdownEventRows();
  });

  test("returns 404 when share does not exist", async () => {
    shareRecord = null;
    const { GET } = await routeModulePromise;

    const response = await GET(makeRequest(), makeContext("missing"));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found\n");
  });

  test("returns markdown with frontmatter and per-turn tool activity", async () => {
    const { GET } = await routeModulePromise;

    const response = await GET(makeRequest(), makeContext());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("vary")).toBe("Accept");
    expect(body).toContain('session_name: "Debug flaky tests"');
    expect(body).toContain('repo: "acme/repo"');
    expect(body).toContain('branch: "fix/flaky-ci"');
    expect(body).toContain('pr_url: "https://github.com/acme/repo/pull/123"');
    expect(body).toContain("pr_number: 123");
    expect(body).toContain('created_at: "2025-01-01T12:00:00.000Z"');
    expect(body).toContain("## User\nPlease debug the flaky tests.");
    expect(body).toContain("<!-- tool_activity: duration=15m tool_calls=2 -->");
    expect(body).toContain("## Assistant\nI fixed the timeout handling.");
    expect(body).not.toContain("README.md");
  });

  test("returns the same payload for text/plain requests", async () => {
    const { GET } = await routeModulePromise;

    const response = await GET(makeRequest("text/plain"), makeContext());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(body).toContain("<!-- tool_activity: duration=15m tool_calls=2 -->");
  });
});
