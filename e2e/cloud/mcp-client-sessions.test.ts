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

const executionIdOf = (text: string): string | undefined =>
  /\bexecutionId:\s*(\S+)/.exec(text)?.[1];

// The session DO tears its runtime down after 5 minutes without a request
// (SESSION_TIMEOUT_MS in McpSessionDOBase) and rebuilds it from storage on
// the next one — the same engine-state wipe a workerd eviction or a deploy
// causes. Paused approvals deliberately do NOT survive this (durable pause
// state is out of scope); the contract is that an expired pause fails with
// recovery guidance and the session keeps working.
const IDLE_TEARDOWN_GAP = "6 minutes";

scenario(
  "MCP sessions · an approval paused past the idle window expires with re-run guidance, not a dead end",
  { timeout: 480_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const api = yield* client(coreApi, identity);
    const bearer = yield* mcp.mintBearer(emailOf(identity));

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
      const executionId = executionIdOf(pausedText);
      expect(executionId, "the paused result carries the executionId").toEqual(expect.any(String));

      // The user thinks the approval over for longer than the session keeps
      // its runtime warm; the pause is gone when they come back.
      yield* Effect.sleep(IDLE_TEARDOWN_GAP);

      const second = yield* Effect.promise(() => connectClient(target.mcpUrl, bearer, sessionId));
      yield* Effect.gen(function* () {
        const resumed = yield* Effect.promise(() =>
          second.client.callTool({
            name: "resume",
            arguments: { executionId: executionId ?? "", action: "accept", content: "{}" },
          }),
        );
        expect(resumed.isError, "the expired resume is an error, not a silent success").toBe(true);
        expect(
          textOf(resumed),
          "the error tells the model how to recover, not just that the pause is gone",
        ).toContain("run the execute tool again");

        // The advertised recovery actually works on the same session: a fresh
        // execute pauses with a NEW id (stale ids are never reused), and
        // resuming that completes the gated call.
        const reExecuted = yield* Effect.promise(() =>
          second.client.callTool({ name: "execute", arguments: { code: GATED_CODE } }),
        );
        const reExecutedText = textOf(reExecuted);
        expect(reExecutedText, "the re-run pauses for approval again").toContain(
          "Execution paused",
        );
        const freshExecutionId = executionIdOf(reExecutedText);
        expect(freshExecutionId, "the re-run mints a different executionId").not.toBe(executionId);

        const resumedFresh = yield* Effect.promise(() =>
          second.client.callTool({
            name: "resume",
            arguments: { executionId: freshExecutionId ?? "", action: "accept", content: "{}" },
          }),
        );
        expect(resumedFresh.isError, "the fresh approval resumes to completion").not.toBe(true);
        expect(textOf(resumedFresh), "the gated tool's result comes back after approval").toContain(
          APPROVAL_TARGET_TOOL,
        );
      }).pipe(Effect.ensuring(closeQuietly(second)));
    }).pipe(
      Effect.ensuring(
        api.policies
          .remove({ params: { policyId: policy.id }, payload: { owner: "org" } })
          .pipe(Effect.ignore),
      ),
    );
  }),
);

scenario(
  "MCP sessions · a duplicate resume replays the outcome instead of losing the approval",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const api = yield* client(coreApi, identity);
    const bearer = yield* mcp.mintBearer(emailOf(identity));

    const policy = yield* api.policies.create({
      payload: { owner: "org", pattern: APPROVAL_TARGET_TOOL, action: "require_approval" },
    });

    yield* Effect.gen(function* () {
      const session = yield* Effect.promise(() => connectClient(target.mcpUrl, bearer));
      yield* Effect.gen(function* () {
        const paused = yield* Effect.promise(() =>
          session.client.callTool({ name: "execute", arguments: { code: GATED_CODE } }),
        );
        const executionId = executionIdOf(textOf(paused));
        expect(executionId, "the paused result carries the executionId").toEqual(
          expect.any(String),
        );

        const resume = () =>
          Effect.promise(() =>
            session.client.callTool({
              name: "resume",
              arguments: { executionId: executionId ?? "", action: "accept", content: "{}" },
            }),
          );

        const first = yield* resume();
        expect(first.isError, "the first resume completes the execution").not.toBe(true);

        // MCP clients retry resume when a response is lost in transit. The
        // retry must replay the same completed outcome — the production
        // failure mode was "No paused execution" seconds after a successful
        // resume.
        const retry = yield* resume();
        expect(retry.isError, "the duplicate resume is not an error").not.toBe(true);
        expect(textOf(retry), "the duplicate resume returns the same completed result").toContain(
          APPROVAL_TARGET_TOOL,
        );
      }).pipe(Effect.ensuring(closeQuietly(session)));
    }).pipe(
      Effect.ensuring(
        api.policies
          .remove({ params: { policyId: policy.id }, payload: { owner: "org" } })
          .pipe(Effect.ignore),
      ),
    );
  }),
);

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
