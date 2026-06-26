// Local-only — REPRO + guard for "I've been running executor as stdio as get
// errors trying http one in opencode". The local app's HTTP `/mcp` endpoint is
// bearer-gated (hardened so loopback is not a free pass) and serves NO OAuth
// discovery. An external agent like opencode, pointed at the URL, tries MCP
// OAuth auto-detection, gets a plain `401 Bearer realm="executor"` with no
// resource-metadata to discover an authorization server from, and errors out.
//
// The HTTP transport itself is fine — it works the moment the bearer is supplied
// (opencode's remote MCP supports `headers` + `oauth: false`). This scenario
// proves exactly that: tools list over HTTP WITH the bearer, and the gate 401s
// WITHOUT it. It also asserts the `--foreground` ready output now prints a
// ready-to-paste opencode config (URL + bearer header + `oauth: false`) so a
// user does not have to reverse-engineer the gate.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { scenario } from "../src/scenario";
import { Cli, RunDir } from "../src/services";
import { withLocalServer } from "./local-server";

/** Connect an MCP client to the local `/mcp` over HTTP and list tools. Rejects
 *  if the bearer gate (or transport) refuses the connection. */
const listToolsOverHttp = async (
  origin: string,
  headers?: Record<string, string>,
): Promise<readonly string[]> => {
  const client = new Client({ name: "e2e-http-mcp", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: headers ? { headers } : undefined,
  });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name);
  } finally {
    await client.close().catch(() => {});
  }
};

scenario(
  "Local · HTTP MCP works with the bearer header and 401s without it",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const cli = yield* Cli;
    const runDir = yield* RunDir;

    yield* withLocalServer(cli, runDir, (server) =>
      Effect.gen(function* () {
        // WITH the bearer: the HTTP transport connects and lists tools — the very
        // thing that "errors in opencode" when the agent omits the token.
        const tools = yield* Effect.promise(() =>
          listToolsOverHttp(server.origin, { authorization: `Bearer ${server.token}` }),
        );
        expect(
          tools.length,
          "HTTP MCP lists tools once the bearer is supplied",
        ).toBeGreaterThan(0);

        // WITHOUT the bearer: the gate rejects, which is what trips opencode's
        // default OAuth auto-detection (no resource-metadata to recover from).
        const unauthorized = yield* Effect.promise(async () => {
          try {
            await listToolsOverHttp(server.origin);
            return "connected";
          } catch {
            return "rejected";
          }
        });
        expect(unauthorized, "HTTP MCP rejects a tokenless connection").toBe("rejected");
      }),
    );
  }),
);
