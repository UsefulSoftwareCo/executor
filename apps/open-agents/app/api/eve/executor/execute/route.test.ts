import { beforeEach, describe, expect, mock, test } from "bun:test";

type RuntimeOptions = {
  userId: string;
  sessionId?: string;
  executorToolPatterns?: string[];
};

type RuntimeCall = RuntimeOptions;

type ExecuteCall = {
  code: string;
};

const runtimeCalls: RuntimeCall[] = [];
const executeCalls: ExecuteCall[] = [];

const executeMock = mock(async (code: string) => {
  executeCalls.push({ code });
  return {
    text: "executed",
    artifacts: [{ type: "text", text: "hello" }],
  };
});

const createOpenAgentsExecutorRuntimeMock = mock(
  async (options: RuntimeOptions) => {
    runtimeCalls.push(options);
    return { execute: executeMock };
  },
);

mock.module("@/lib/executor/runtime", () => ({
  createOpenAgentsExecutorRuntime: createOpenAgentsExecutorRuntimeMock,
}));

const routeModulePromise = import("./route");

function createPostRequest(body: object, headers: HeadersInit = {}): Request {
  return new Request("http://localhost/api/eve/executor/execute", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("/api/eve/executor/execute", () => {
  beforeEach(() => {
    runtimeCalls.length = 0;
    executeCalls.length = 0;
    executeMock.mockClear();
    createOpenAgentsExecutorRuntimeMock.mockClear();
  });

  test("returns 401 when the user header is missing", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(
      createPostRequest({ code: "return 'hello';" }),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({ error: "Missing OpenAgents user id" });
    expect(runtimeCalls).toHaveLength(0);
    expect(executeCalls).toHaveLength(0);
  });

  test("returns 400 when the request body is invalid", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(
      createPostRequest(
        { executorToolPatterns: ["github.*"] },
        { "x-open-agents-user-id": "user-1" },
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "Invalid executor request" });
    expect(runtimeCalls).toHaveLength(0);
    expect(executeCalls).toHaveLength(0);
  });

  test("executes valid code with the mocked runtime", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(
      createPostRequest(
        {
          code: "return 'hello';",
          executorToolPatterns: ["github.*", "linear.createIssue"],
        },
        {
          "x-open-agents-user-id": " user-1 ",
          "x-open-agents-session-id": " session-1 ",
        },
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      text: "executed",
      artifacts: [{ type: "text", text: "hello" }],
    });
    expect(runtimeCalls).toEqual([
      {
        userId: "user-1",
        sessionId: "session-1",
        executorToolPatterns: ["github.*", "linear.createIssue"],
      },
    ]);
    expect(executeCalls).toEqual([{ code: "return 'hello';" }]);
  });
});
