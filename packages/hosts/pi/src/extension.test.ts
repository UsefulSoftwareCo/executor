// End-to-end for the bridge: a real MCP server over HTTP, the real MCP client,
// and the real tool definitions — only Pi itself is faked.

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { serveMcpServer, TEST_IMAGE_PNG_BASE64 } from "@executor-js/plugin-mcp/testing";
import z from "zod";

import { resolvePiExecutorConfig } from "./config";
import { createExecutorConnection, type ExecutorConnection } from "./connection";
import { describeConnection } from "./extension";
import { registerExecutorTools } from "./tools";

const API_KEY = "key_123";

/** A stand-in for Executor: the same three tool names, scripted results. */
const executorLikeServer = (): McpServer => {
  const server = new McpServer({ name: "executor-fake", version: "1.0.0" });
  server.registerTool(
    "execute",
    { description: "run code", inputSchema: { code: z.string() } },
    ({ code }) => {
      if (code === "boom") {
        return {
          content: [{ type: "text" as const, text: "Error: policy blocked" }],
          isError: true,
        };
      }
      if (code === "screenshot") {
        return {
          content: [{ type: "image" as const, data: TEST_IMAGE_PNG_BASE64, mimeType: "image/png" }],
        };
      }
      return { content: [{ type: "text" as const, text: `ran: ${code}` }] };
    },
  );
  server.registerTool(
    "skills",
    { description: "docs", inputSchema: { name: z.string().optional() } },
    ({ name }) => ({ content: [{ type: "text" as const, text: `doc: ${name ?? "index"}` }] }),
  );
  server.registerTool(
    "resume",
    {
      description: "resume",
      inputSchema: {
        executionId: z.string(),
        action: z.enum(["accept", "decline", "cancel"]),
        content: z.string().default("{}"),
      },
    },
    ({ executionId, action }) => ({
      content: [{ type: "text" as const, text: `${action}ed ${executionId}` }],
    }),
  );
  return server;
};

interface CapturedTool {
  readonly name: string;
  readonly call: (
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ readonly content: unknown }>;
}

interface FakePi {
  readonly api: ExtensionAPI;
  readonly tools: Map<string, CapturedTool>;
  readonly commands: string[];
  readonly events: string[];
}

const makeFakePi = (): FakePi => {
  const tools = new Map<string, CapturedTool>();
  const commands: string[] = [];
  const events: string[] = [];
  const api: Pick<ExtensionAPI, "registerTool" | "registerCommand" | "on"> = {
    registerTool: (tool) => {
      tools.set(tool.name, {
        name: tool.name,
        call: (params, signal) =>
          tool.execute("call-1", params as never, signal, undefined, {} as ExtensionContext),
      });
    },
    registerCommand: (name) => {
      commands.push(name);
    },
    on: (event: string) => {
      events.push(event);
    },
  };
  return { api: api as ExtensionAPI, tools, commands, events };
};

const callTool = (
  pi: FakePi,
  name: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ readonly content: unknown }> => {
  const tool = pi.tools.get(name);
  if (tool === undefined) return Promise.reject(new Error(`${name} was never registered`));
  return tool.call(params, signal);
};

/** Resolve to the thrown message instead of the value, for failure assertions. */
const failureOf = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "resolved",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

/** Everything wired the way `executorExtension` wires it, minus Pi. `source` is
 *  the variable the bearer arrives in — hosted API key by default, the local
 *  server's own token when a scenario asks for it. */
const connect = (
  endpoint: string | undefined,
  token = API_KEY,
  source: "EXECUTOR_API_KEY" | "EXECUTOR_AUTH_TOKEN" = "EXECUTOR_API_KEY",
): { pi: FakePi; connection: ExecutorConnection } => {
  const pi = makeFakePi();
  const connection = createExecutorConnection(
    resolvePiExecutorConfig(
      endpoint === undefined ? {} : { EXECUTOR_MCP_URL: endpoint, [source]: token },
    ),
  );
  registerExecutorTools(pi.api, connection);
  return { pi, connection };
};

const authorizedServer = () =>
  serveMcpServer(executorLikeServer, {
    path: "/mcp",
    auth: {
      validateAuthorization: (authorization) =>
        Effect.succeed(authorization === `Bearer ${API_KEY}`),
    },
  });

describe("the Pi extension", () => {
  it.effect("registers its tools with no Executor reachable at all", () =>
    Effect.sync(() => {
      const { pi } = connect(undefined);
      // The whole point of registering from a literal: Pi still starts.
      expect([...pi.tools.keys()]).toEqual([
        "executor_execute",
        "executor_skills",
        "executor_resume",
      ]);
    }),
  );

  it.effect("explains what to set when a call happens without configuration", () =>
    Effect.gen(function* () {
      const { pi } = connect(undefined);
      const failure = yield* Effect.promise(() =>
        failureOf(callTool(pi, "executor_execute", { code: "1 + 1" })),
      );
      expect(failure).toContain("EXECUTOR_MCP_URL");
    }),
  );

  it.effect("round-trips a tool call over HTTP with the bearer attached", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* authorizedServer();
        const { pi } = connect(server.endpoint);

        const result = yield* Effect.promise(() =>
          callTool(pi, "executor_execute", { code: "1 + 1" }),
        );
        expect(result.content).toEqual([{ type: "text", text: "ran: 1 + 1" }]);

        const requests = yield* server.requests;
        expect(
          requests.some((request) => request.authorization === `Bearer ${API_KEY}`),
          "the API key reached the server",
        ).toBe(true);
        expect(
          requests.some((request) => request.url.includes("elicitation_mode=model")),
          "the endpoint is pinned to model elicitation",
        ).toBe(true);
      }),
    ),
  );

  it.effect("sends a rejected hosted key to the API Keys page", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* authorizedServer();
        const { pi } = connect(server.endpoint, "wrong-key", "EXECUTOR_API_KEY");

        const failure = yield* Effect.promise(() =>
          failureOf(callTool(pi, "executor_execute", { code: "1 + 1" })),
        );
        expect(failure, "the failure is the rejection, not a missing token").toContain(
          "was rejected",
        );
        expect(failure, "names the variable that holds the bad key").toContain("EXECUTOR_API_KEY");
        expect(failure, "and where hosted keys come from").toContain("API Keys page");
      }),
    ),
  );

  // A local or desktop Executor has no API Keys page: it hands out its own
  // server token, so telling that user to mint an API key is a dead end.
  it.effect("sends a rejected local server token back to the server's own token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* authorizedServer();
        const { pi } = connect(server.endpoint, "wrong-token", "EXECUTOR_AUTH_TOKEN");

        const failure = yield* Effect.promise(() =>
          failureOf(callTool(pi, "executor_execute", { code: "1 + 1" })),
        );
        expect(failure, "the failure is the rejection, not a missing token").toContain(
          "was rejected",
        );
        expect(failure, "names the variable that holds the bad token").toContain(
          "EXECUTOR_AUTH_TOKEN",
        );
        expect(failure, "and does not send a local user to a page they do not have").not.toContain(
          "API Keys page",
        );
      }),
    ),
  );

  it.effect("turns an isError result into a thrown error carrying the server's text", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* authorizedServer();
        const { pi } = connect(server.endpoint);

        // Pi has no error flag on results: only a throw marks the call failed.
        const failure = yield* Effect.promise(() =>
          failureOf(callTool(pi, "executor_execute", { code: "boom" })),
        );
        expect(failure).toBe("Error: policy blocked");
      }),
    ),
  );

  it.effect("hands images to Pi rather than a placeholder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* authorizedServer();
        const { pi } = connect(server.endpoint);

        const result = yield* Effect.promise(() =>
          callTool(pi, "executor_execute", { code: "screenshot" }),
        );
        expect(result.content).toEqual([
          { type: "image", data: TEST_IMAGE_PNG_BASE64, mimeType: "image/png" },
        ]);
      }),
    ),
  );

  it.effect("passes the resume arguments the model-mode schema promises", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* authorizedServer();
        const { pi } = connect(server.endpoint);

        const result = yield* Effect.promise(() =>
          callTool(pi, "executor_resume", { executionId: "exec_1", action: "accept" }),
        );
        expect(result.content).toEqual([{ type: "text", text: "accepted exec_1" }]);
      }),
    ),
  );

  it.effect("cancels an in-flight call when Pi aborts the turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* authorizedServer();
        const { pi } = connect(server.endpoint);

        const outcome = yield* Effect.promise(() =>
          callTool(pi, "executor_execute", { code: "1 + 1" }, AbortSignal.abort()).then(
            () => "resolved",
            () => "rejected",
          ),
        );
        expect(outcome).toBe("rejected");
      }),
    ),
  );

  it.effect("`/executor` reports the endpoint and the tools it can see", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* authorizedServer();
        const { connection } = connect(server.endpoint);

        const report = yield* Effect.promise(() => describeConnection(connection));
        expect(report.type).toBe("info");
        expect(report.message).toContain("execute");
        yield* Effect.promise(() => connection.close());
      }),
    ),
  );

  it.effect("`/executor` says what is missing when nothing is configured", () =>
    Effect.gen(function* () {
      const { connection } = connect(undefined);
      const report = yield* Effect.promise(() => describeConnection(connection));
      expect(report.type).toBe("error");
      expect(report.message).toContain("EXECUTOR_MCP_URL");
    }),
  );
});
