// Cloud: MCP sessions driven by the REAL @modelcontextprotocol/sdk Client over
// StreamableHTTP — exactly the code path Claude/Cursor run. The dev server is
// the production wrangler topology (real workerd, real McpSessionDO), so
// session continuity here is real Durable Object state surviving across
// client connections, not a stub.
//
// Ported from apps/cloud/src/mcp-miniflare.e2e.node.test.ts (unstable_dev +
// test-seam bearers) onto the e2e dev server with real OAuth bearers.
// Telemetry-span assertions from that file required injecting an OTLP
// receiver into the worker env and were NOT carried (not black-box).

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";
import type { Identity } from "../src/target";

const coreApi = composePluginApi([] as const);

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

interface Connected {
  readonly client: Client;
  readonly transport: StreamableHTTPClientTransport;
}

/** A real SDK client over StreamableHTTP; `sessionId` resumes an existing session. */
const connectClient = async (
  mcpUrl: string,
  bearer: string,
  sessionId?: string,
): Promise<Connected> => {
  const client = new Client(
    { name: "executor-e2e-sessions", version: "0.0.1" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    ...(sessionId === undefined ? {} : { sessionId }),
  });
  await client.connect(transport);
  return { client, transport };
};

const textOf = (result: { content?: unknown; toolResult?: unknown }): string =>
  ((result.content ?? []) as Array<{ type: string; text?: string }>)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

const closeQuietly = (connected: Connected): Effect.Effect<void> =>
  Effect.promise(() => connected.client.close().catch(() => undefined));

scenario(
  "MCP sessions · a real MCP client connects, lists tools, and executes code",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    const session = yield* Effect.promise(() => connectClient(target.mcpUrl, bearer));
    yield* Effect.gen(function* () {
      expect(
        session.client.getServerVersion()?.name,
        "the handshake reports the product server",
      ).toBe("executor");
      expect(session.transport.sessionId, "the transport holds a session id").toEqual(
        expect.any(String),
      );

      const { tools } = yield* Effect.promise(() => session.client.listTools());
      expect(
        tools.map((tool) => tool.name),
        "the execute tool is advertised",
      ).toContain("execute");
      expect(
        tools.map((tool) => tool.name),
        "the resume tool is advertised",
      ).toContain("resume");

      const result = yield* Effect.promise(() =>
        session.client.callTool({ name: "execute", arguments: { code: "return 6 * 7;" } }),
      );
      expect(result.isError, "the call succeeds").not.toBe(true);
      expect(textOf(result), "the sandbox returns the value").toContain("42");
    }).pipe(Effect.ensuring(closeQuietly(session)));
  }),
);

scenario(
  "MCP sessions · a second client resuming the session id continues the session",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));

    // First connection establishes the session, does real work, then goes
    // away — the laptop-closed / process-restarted case.
    const first = yield* Effect.promise(() => connectClient(target.mcpUrl, bearer));
    const sessionId = first.transport.sessionId;
    expect(sessionId, "the first client got a session id").toEqual(expect.any(String));
    const before = yield* Effect.promise(() =>
      first.client.callTool({ name: "execute", arguments: { code: 'return "before";' } }),
    ).pipe(Effect.ensuring(closeQuietly(first)));
    expect(textOf(before), "the first client's call succeeded").toContain("before");

    // A brand-new client resumes with nothing but the session id. The
    // session's Durable Object state persists across connections — this is
    // the restore guarantee.
    const second = yield* Effect.promise(() => connectClient(target.mcpUrl, bearer, sessionId));
    yield* Effect.gen(function* () {
      expect(second.transport.sessionId, "the session id is preserved, not reissued").toBe(
        sessionId,
      );
      const { tools } = yield* Effect.promise(() => second.client.listTools());
      expect(
        tools.map((tool) => tool.name),
        "the resumed session serves requests",
      ).toContain("execute");
      const after = yield* Effect.promise(() =>
        second.client.callTool({ name: "execute", arguments: { code: 'return "after";' } }),
      );
      expect(after.isError, "the resumed session executes code").not.toBe(true);
      expect(textOf(after), "the resumed session returns results").toContain("after");
    }).pipe(Effect.ensuring(closeQuietly(second)));
  }),
);

scenario(
  "MCP sessions · an unknown session id fails fast with a clean error, not a hang",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    // A session id the server never issued (right shape, never minted).
    const session = yield* Effect.promise(() =>
      connectClient(target.mcpUrl, bearer, "0".repeat(64)),
    );
    const failure = yield* Effect.flip(
      Effect.tryPromise({
        try: () => session.client.listTools(),
        catch: (cause) => cause,
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () =>
          Effect.die(new Error("listTools on an unknown session hung instead of failing")),
      }),
      Effect.ensuring(closeQuietly(session)),
    );
    expect(String(failure), "the server answered with a JSON-RPC error envelope").toContain(
      "jsonrpc",
    );
  }),
);

scenario(
  "MCP sessions · two concurrent clients hold isolated sessions that don't interfere",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    const [alpha, beta] = yield* Effect.promise(() =>
      Promise.all([connectClient(target.mcpUrl, bearer), connectClient(target.mcpUrl, bearer)]),
    );
    yield* Effect.gen(function* () {
      expect(alpha.transport.sessionId, "each client gets its own session").not.toBe(
        beta.transport.sessionId,
      );

      const [alphaResult, betaResult] = yield* Effect.promise(() =>
        Promise.all([
          alpha.client.callTool({
            name: "execute",
            arguments: {
              code: 'await new Promise((resolve) => setTimeout(resolve, 300));\nreturn "alpha-result";',
            },
          }),
          beta.client.callTool({
            name: "execute",
            arguments: { code: 'return "beta-result";' },
          }),
        ]),
      );
      expect(textOf(alphaResult), "the first session got its own answer").toContain("alpha-result");
      expect(textOf(alphaResult), "no cross-talk into the first session").not.toContain(
        "beta-result",
      );
      expect(textOf(betaResult), "the second session got its own answer").toContain("beta-result");
      expect(textOf(betaResult), "no cross-talk into the second session").not.toContain(
        "alpha-result",
      );
    }).pipe(Effect.ensuring(closeQuietly(alpha)), Effect.ensuring(closeQuietly(beta)));
  }),
);

const APPROVAL_TARGET_TOOL = "executor.coreTools.policies.list";

const GATED_CODE = `
const result = await tools.executor.coreTools.policies.list({});
return JSON.stringify(result);
`;

scenario(
  "MCP sessions · a paused approval survives the client reconnecting and resumes",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const api = yield* client(coreApi, identity);
    const bearer = yield* mcp.mintBearer(emailOf(identity));

    // Gate a built-in tool behind human approval; the org is fresh, so the
    // gate affects no other scenario, but remove it anyway on every exit.
    const policy = yield* api.policies.create({
      payload: { owner: "org", pattern: APPROVAL_TARGET_TOOL, action: "require_approval" },
    });

    yield* Effect.gen(function* () {
      const first = yield* Effect.promise(() => connectClient(target.mcpUrl, bearer));
      const sessionId = first.transport.sessionId;
      const paused = yield* Effect.promise(() =>
        first.client.callTool({ name: "execute", arguments: { code: GATED_CODE } }),
      ).pipe(Effect.ensuring(closeQuietly(first)));
      const pausedText = textOf(paused);
      expect(pausedText, "the gated call pauses instead of completing").toContain(
        "Execution paused",
      );
      const executionId = /\bexecutionId:\s*(\S+)/.exec(pausedText)?.[1];
      expect(executionId, "the paused result carries the executionId").toEqual(expect.any(String));

      // The user answers from a NEW client on the same session — the paused
      // execution lives in the session, not the connection.
      const second = yield* Effect.promise(() => connectClient(target.mcpUrl, bearer, sessionId));
      const resumed = yield* Effect.promise(() =>
        second.client.callTool({
          name: "resume",
          arguments: { executionId: executionId ?? "", action: "accept", content: "{}" },
        }),
      ).pipe(Effect.ensuring(closeQuietly(second)));
      expect(resumed.isError, "the resumed execution completes").not.toBe(true);
      expect(textOf(resumed), "the gated tool's result comes back after approval").toContain(
        APPROVAL_TARGET_TOOL,
      );
    }).pipe(
      Effect.ensuring(
        api.policies
          .remove({ params: { policyId: policy.id }, payload: { owner: "org" } })
          .pipe(Effect.ignore),
      ),
    );
  }),
);
