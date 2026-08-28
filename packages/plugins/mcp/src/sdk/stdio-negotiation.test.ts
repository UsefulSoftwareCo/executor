import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import { fileURLToPath } from "node:url";

import { createMcpConnector, type StdioConnectorInput } from "./connection";

const fixture = fileURLToPath(new URL("./stdio-negotiation-test-server.ts", import.meta.url));

const stdioInput = (
  overrides: Partial<Omit<StdioConnectorInput, "transport" | "command">> & {
    readonly args: readonly string[];
  },
): StdioConnectorInput => ({
  transport: "stdio",
  command: "bun",
  ...overrides,
});

const withConnection = (input: StdioConnectorInput) =>
  Effect.acquireRelease(createMcpConnector(input).pipe(Effect.orDie), (connection) =>
    Effect.promise(connection.close),
  );

describe("stdio version negotiation", () => {
  it.effect("auto negotiation connects modern to a server with legacy support disabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* withConnection(
          stdioInput({ args: ["run", fixture, "--legacy-reject"], versionNegotiation: "auto" }),
        );

        expect(connection.client.getProtocolEra()).toBe("modern");
        const tools = yield* Effect.promise(() => connection.client.listTools());
        expect(tools.tools.map(({ name }) => name)).toContain("add");
        const result = yield* Effect.promise(() =>
          connection.client.callTool({ name: "add", arguments: { a: 2, b: 2 } }),
        );
        expect(result.content).toEqual([{ type: "text", text: "4" }]);
      }),
    ),
  );

  it.effect("the default handshake surfaces a connection error on that same server", () =>
    Effect.gen(function* () {
      const error = yield* createMcpConnector(
        stdioInput({ args: ["run", fixture, "--legacy-reject"] }),
      ).pipe(Effect.flip);

      expect(Predicate.isTagged(error, "McpConnectionError")).toBe(true);
    }),
  );

  it.effect("absent config keeps the legacy handshake against a both-era server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* withConnection(stdioInput({ args: ["run", fixture] }));

        expect(connection.client.getProtocolEra()).toBe("legacy");
        const tools = yield* Effect.promise(() => connection.client.listTools());
        expect(tools.tools.map(({ name }) => name)).toContain("add");
      }),
    ),
  );
});
