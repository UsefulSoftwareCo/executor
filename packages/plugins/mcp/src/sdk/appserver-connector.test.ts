import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import { fileURLToPath } from "node:url";

import { createMcpConnector, type StdioConnectorInput } from "./connection";

// ---------------------------------------------------------------------------
// The Codex app-server bridge, driven end to end through the ORDINARY MCP
// client path: `createMcpConnector` with an `appServer` marker spawns the
// fixture (a fake `codex app-server` with real protocol shapes), and the
// standard `Client` handshakes, lists, calls, and answers elicitations
// against it. Nothing here touches the bridge internals — if these pass, the
// discover/invoke/health paths work unchanged on top.
// ---------------------------------------------------------------------------

const fixture = fileURLToPath(new URL("./appserver-test-server.ts", import.meta.url));

const appServerInput = (server: string): StdioConnectorInput => ({
  transport: "stdio",
  command: "bun",
  args: ["run", fixture],
  env: { CODEX_HOME: "/tmp/fixture-codex-home" },
  appServer: { server },
});

const withConnection = (input: StdioConnectorInput) =>
  Effect.acquireRelease(createMcpConnector(input).pipe(Effect.orDie), (connection) =>
    Effect.promise(connection.close),
  );

describe("codex app-server bridge", () => {
  it.effect("handshakes, follows status pagination, and lists the server's tools", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* withConnection(appServerInput("messages"));

        const tools = yield* Effect.promise(() => connection.client.listTools());
        expect(tools.tools.map(({ name }) => name).sort()).toEqual(["echo", "needs_approval"]);
        const echo = tools.tools.find(({ name }) => name === "echo");
        expect(echo?.description).toBe("Echo the arguments back");
        expect(echo?.inputSchema).toMatchObject({ type: "object" });
      }),
    ),
  );

  it.effect("calls a tool and carries content, structuredContent, and the spawn env through", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* withConnection(appServerInput("messages"));

        const result = yield* Effect.promise(() =>
          connection.client.callTool({ name: "echo", arguments: { text: "hi" } }),
        );
        expect(result.isError).toBeFalsy();
        expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ text: "hi" }) }]);
        // CODEX_HOME must reach the fixture's process env through the spawn.
        expect(result.structuredContent).toEqual({ codexHome: "/tmp/fixture-codex-home" });
      }),
    ),
  );

  it.effect("bridges an app-server elicitation to the client's elicitation/create handler", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* withConnection(appServerInput("messages"));
        const prompts: string[] = [];
        connection.client.setRequestHandler("elicitation/create", (request) => {
          prompts.push(request.params.message);
          return Promise.resolve({ action: "accept" as const, content: {} });
        });

        const result = yield* Effect.promise(() =>
          connection.client.callTool({ name: "needs_approval", arguments: {} }),
        );
        expect(result.content).toEqual([{ type: "text", text: "approved" }]);
        expect(prompts).toEqual(["Allow the fixture to proceed?"]);
      }),
    ),
  );

  it.effect("starts the thread with an approval policy that lets prompts through", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Codex declines MCP elicitations ITSELF on a thread whose approval
        // policy does not allow them — the prompt never reaches the client and
        // the tool just reports "access was not approved". The fixture only
        // elicits when the bridge asked for a permitting policy, so reaching
        // the handler at all is the assertion.
        const connection = yield* withConnection(appServerInput("messages"));
        let prompted = false;
        connection.client.setRequestHandler("elicitation/create", () => {
          prompted = true;
          return Promise.resolve({ action: "accept" as const, content: {} });
        });

        const result = yield* Effect.promise(() =>
          connection.client.callTool({ name: "needs_approval", arguments: {} }),
        );
        expect(prompted, "the plugin's own approval prompt reached the client").toBe(true);
        expect(result.isError).toBeFalsy();
      }),
    ),
  );

  it.effect("a declined elicitation reaches the app-server as a decline, not an approval", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* withConnection(appServerInput("messages"));
        connection.client.setRequestHandler("elicitation/create", () =>
          Promise.resolve({ action: "decline" as const }),
        );

        const result = yield* Effect.promise(() =>
          connection.client.callTool({ name: "needs_approval", arguments: {} }),
        );
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: "text", text: "denied: decline" }]);
      }),
    ),
  );

  it.effect("a server name Codex does not report fails the tools listing, not the connect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* withConnection(appServerInput("not-installed"));

        const outcome = yield* Effect.promise(() =>
          connection.client.listTools().then(
            () => "unexpected success",
            (failure: Error) => failure.message,
          ),
        );
        expect(outcome).toContain('"not-installed"');
      }),
    ),
  );

  it.effect("a missing codex binary surfaces as a connection error", () =>
    Effect.gen(function* () {
      const error = yield* createMcpConnector({
        transport: "stdio",
        command: "/nonexistent/codex",
        args: ["app-server"],
        appServer: { server: "messages" },
      }).pipe(Effect.flip);

      expect(Predicate.isTagged(error, "McpConnectionError")).toBe(true);
    }),
  );
});
