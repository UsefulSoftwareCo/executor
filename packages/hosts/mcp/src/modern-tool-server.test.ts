import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { FormElicitation, ToolAddress } from "@executor-js/sdk";
import type { ExecutionEngine, ExecutionResult } from "@executor-js/execution";

import { defaultMcpResource, type Principal } from "./seams";
import { makeModernMcpDispatcher } from "./modern-tool-server";

type DispatcherRequest = Parameters<ReturnType<typeof makeModernMcpDispatcher>["dispatch"]>[0];

const cloneDispatcherRequest = (request: DispatcherRequest): DispatcherRequest =>
  // oxlint-disable-next-line executor/no-double-cast -- test adapter boundary: Bun and the v2 client's undici types disagree about Headers extensions on the same runtime Request.
  request.clone() as unknown as DispatcherRequest;

const principal: Principal = {
  accountId: "account-1",
  organizationId: "org-1",
  organizationName: "Test Org",
  email: "test@example.com",
  name: "Test",
  avatarUrl: null,
  roles: [],
};

const completed = (value: unknown): ExecutionResult => ({
  status: "completed",
  result: { result: value },
});

const stubEngine = (
  overrides: {
    readonly executeWithPause?: ExecutionEngine["executeWithPause"];
    readonly resume?: ExecutionEngine["resume"];
    readonly getPausedExecution?: ExecutionEngine["getPausedExecution"];
  } = {},
): ExecutionEngine => ({
  execute: () => Effect.succeed({ result: "unused" }),
  executeWithPause: overrides.executeWithPause ?? (() => Effect.succeed(completed("ok"))),
  resume: overrides.resume ?? (() => Effect.succeed(null)),
  getPausedExecution: overrides.getPausedExecution ?? (() => Effect.succeed(null)),
  pausedExecutionCount: () => Effect.succeed(0),
  hasPausedExecutions: () => Effect.succeed(false),
  getDescription: Effect.succeed("Live integrations:\n- test"),
});

const withClient = async (
  dispatcher: ReturnType<typeof makeModernMcpDispatcher>,
  use: (client: Client) => Promise<void>,
  onRequest?: (request: DispatcherRequest) => void,
): Promise<void> => {
  const transport = new StreamableHTTPClientTransport(new URL("https://executor.test/mcp"), {
    fetch: (url, init) => {
      // oxlint-disable-next-line executor/no-double-cast -- test adapter boundary: v2 client bundles undici fetch types, while the runtime objects implement the same web Request contract.
      const request = (url instanceof Request
        ? new Request(url, init)
        : new Request(url.toString(), init)) as unknown as DispatcherRequest;
      onRequest?.(cloneDispatcherRequest(request));
      return Effect.runPromise(dispatcher.dispatch(request, principal, defaultMcpResource));
    },
  });
  const client = new Client(
    { name: "modern-test", version: "1" },
    {
      capabilities: { elicitation: { form: {}, url: {} } },
      versionNegotiation: { mode: "auto" },
    },
  );
  await client.connect(transport);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- test cleanup boundary: both client and dispatcher must close when an assertion fails.
  try {
    await use(client);
  } finally {
    await client.close();
    await dispatcher.close();
  }
};

describe("modern MCP dispatcher", () => {
  it("answers discover and tools/list without building an execution engine", async () => {
    let builds = 0;
    const dispatcher = makeModernMcpDispatcher(() => {
      builds += 1;
      return Effect.succeed({ engine: stubEngine(), description: "test" });
    });

    await withClient(dispatcher, async (client) => {
      expect(client.getProtocolEra()).toBe("modern");
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["execute", "skills"]);
      expect(builds).toBe(0);
    });
  });

  it("executes a complete call and reuses the principal-scoped workspace", async () => {
    let builds = 0;
    const engine = stubEngine({
      executeWithPause: (code) => Effect.succeed(completed(`ran:${code}`)),
    });
    const dispatcher = makeModernMcpDispatcher(() => {
      builds += 1;
      return Effect.succeed({ engine, description: "test" });
    });

    await withClient(dispatcher, async (client) => {
      const first = await client.callTool({ name: "execute", arguments: { code: "return 1" } });
      const second = await client.callTool({ name: "execute", arguments: { code: "return 2" } });
      expect(first.structuredContent).toMatchObject({ result: "ran:return 1" });
      expect(second.structuredContent).toMatchObject({ result: "ran:return 2" });
      expect(builds).toBe(1);
    });
  });

  it("round-trips elicitation through signed requestState and resumes once", async () => {
    const request = FormElicitation.make({
      message: "Approve the action?",
      requestedSchema: {
        type: "object",
        properties: { approved: { type: "boolean" } },
        required: ["approved"],
      },
    });
    const paused: Extract<ExecutionResult, { status: "paused" }> = {
      status: "paused",
      execution: {
        id: "exec-modern-1",
        elicitationContext: {
          address: ToolAddress.make("tools.test.org.main.action"),
          args: {},
          request,
        },
      },
    };
    let resumes = 0;
    const engine = stubEngine({
      executeWithPause: () => Effect.succeed(paused),
      getPausedExecution: () => Effect.succeed(paused.execution),
      resume: (_id, response) => {
        resumes += 1;
        return Effect.succeed(completed(response));
      },
    });
    const dispatcher = makeModernMcpDispatcher(() =>
      Effect.succeed({ engine, description: "test" }),
    );
    let retryRequest: DispatcherRequest | undefined;

    await withClient(
      dispatcher,
      async (client) => {
        client.setRequestHandler("elicitation/create", () => ({
          action: "accept",
          content: { approved: true },
        }));
        const result = await client.callTool({
          name: "execute",
          arguments: { code: "await tools.test()" },
        });
        expect(result.structuredContent).toMatchObject({
          status: "completed",
          result: { action: "accept", content: { approved: true } },
        });
        expect(resumes).toBe(1);

        expect(retryRequest).toBeDefined();
        const retry = await Effect.runPromise(
          dispatcher.dispatch(cloneDispatcherRequest(retryRequest!), principal, defaultMcpResource),
        );
        expect(await retry.json()).toMatchObject({
          result: {
            structuredContent: {
              status: "completed",
              result: { action: "accept", content: { approved: true } },
            },
          },
        });
        expect(resumes).toBe(1);

        const otherPrincipal = { ...principal, accountId: "account-2" };
        const crossPrincipal = await Effect.runPromise(
          dispatcher.dispatch(
            cloneDispatcherRequest(retryRequest!),
            otherPrincipal,
            defaultMcpResource,
          ),
        );
        expect(await crossPrincipal.json()).toMatchObject({
          error: { message: expect.stringMatching(/request.?state/i) },
        });
        expect(resumes).toBe(1);
      },
      (request) => {
        if (request.headers.get("mcp-method") === "tools/call") retryRequest = request;
      },
    );
  });
});
