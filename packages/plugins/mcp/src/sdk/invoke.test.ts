import { beforeAll, describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
// oxlint-disable-next-line executor/no-vitest-import -- boundary: fake-clock coverage for the active-work deadline
import { afterEach, vi } from "vitest";

import {
  ProtocolError,
  SdkErrorCode,
  SdkHttpError,
  type OAuthClientProvider,
  type ClientContext,
} from "@modelcontextprotocol/client";
import { ElicitationResponse } from "@executor-js/sdk";
import { serveTestHttpApp } from "@executor-js/sdk/testing";

import { loadMcpClientSdk } from "./client-module";
import { createMcpConnector, type McpConnection, type McpConnector } from "./connection";

// Classification consults the lazily-loaded client module (client-module.ts);
// in prod every SDK error is preceded by a connect, which loads it. Mirror
// that precondition here — these tests construct SDK errors directly.
beforeAll(() => loadMcpClientSdk());
import { McpInvocationError, McpOAuthReauthorizationRequired } from "./errors";
import { invokeMcpTool, makeActiveWorkDeadline, MCP_ACTIVE_WORK_TIMEOUT_MS } from "./invoke";

const acceptAll = () => Effect.succeed(ElicitationResponse.make({ action: "accept" }));

const rejectingConnector = (cause: unknown): McpConnector =>
  Effect.succeed({
    // oxlint-disable-next-line executor/no-double-cast -- boundary: minimal fake MCP client implements only the methods invokeMcpTool calls
    client: {
      setRequestHandler: () => undefined,
      // oxlint-disable-next-line executor/no-promise-reject -- boundary: fake MCP client rejects to exercise invocation error wrapping
      callTool: () => Promise.reject(cause),
    } as unknown as McpConnection["client"],
    close: () => Promise.resolve(),
  });

const reauthorizationProvider: OAuthClientProvider = {
  get redirectUrl() {
    return "http://localhost/oauth/callback";
  },
  get clientMetadata() {
    return {
      redirect_uris: ["http://localhost/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"] as string[],
      response_types: ["code"] as string[],
      token_endpoint_auth_method: "none" as const,
      client_name: "Executor",
    };
  },
  clientInformation: () => ({ client_id: "test-client" }),
  saveClientInformation: () => undefined,
  tokens: () => ({ access_token: "expired-token", token_type: "Bearer" }),
  saveTokens: () => undefined,
  redirectToAuthorization: async () => {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: MCP SDK OAuthClientProvider callback can only signal reauthorization by throwing
    throw new McpOAuthReauthorizationRequired({ message: "reauthorization required" });
  },
  saveCodeVerifier: () => undefined,
  codeVerifier: () => "unused",
  saveDiscoveryState: () => undefined,
  discoveryState: () => undefined,
};

const serveReauthorizationChallengeServer = () =>
  serveTestHttpApp((request) =>
    Effect.sync(() => {
      const origin = `http://${request.headers.host ?? "127.0.0.1"}`;
      const requestUrl = new URL(request.url, origin);

      if (requestUrl.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return HttpServerResponse.jsonUnsafe({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          bearer_methods_supported: ["header"],
          scopes_supported: ["read"],
        });
      }

      if (
        requestUrl.pathname === "/.well-known/oauth-authorization-server" ||
        requestUrl.pathname === "/.well-known/openid-configuration"
      ) {
        return HttpServerResponse.jsonUnsafe({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["read"],
        });
      }

      if (requestUrl.pathname === "/mcp" && request.method === "GET") {
        return HttpServerResponse.text("SSE disabled", { status: 405 });
      }

      return HttpServerResponse.jsonUnsafe(
        { error: "invalid_token" },
        {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
          },
        },
      );
    }),
  );

// The status-extraction cases share one shape: dial a connector that rejects
// with `cause`, then assert the surfaced failure is a sanitized
// McpInvocationError carrying the expected HTTP status (or none) and never the
// upstream body. Each `cause` embeds a "do-not-leak" sentinel.
const invocationRejectionCases = [
  {
    name: "wraps callTool rejection with a stable message and status",
    toolId: "blocked",
    transport: "streamable-http",
    cause: new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, "token=do-not-leak", {
      status: 401,
    }),
    expectedStatus: 401 as number | undefined,
  },
  {
    name: "does not treat MCP protocol error codes as HTTP statuses",
    toolId: "protocol_error",
    transport: "streamable-http",
    cause: new ProtocolError(401, "application-level do-not-leak"),
    expectedStatus: undefined,
  },
  {
    name: "does not invent a status from non-HTTP rejection shapes",
    toolId: "network",
    transport: "streamable-http",
    cause: { code: -1, message: "socket said do-not-leak" },
    expectedStatus: undefined,
  },
  {
    name: "extracts the status from the SDK SSE POST error prefix without leaking the body",
    toolId: "sse_blocked",
    transport: "sse",
    cause: {
      message: "Error POSTing to endpoint (HTTP 403): do-not-leak: upstream auth challenge",
    },
    expectedStatus: 403,
  },
];

describe("invokeMcpTool", () => {
  afterEach(() => vi.useRealTimers());

  it("pauses the active-work deadline across overlapping elicitations", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const deadline = makeActiveWorkDeadline(100);

    vi.advanceTimersByTime(40);
    deadline.pause();
    deadline.pause();
    vi.advanceTimersByTime(1_000);
    expect(deadline.signal.aborted).toBe(false);

    deadline.resume();
    vi.advanceTimersByTime(100);
    expect(deadline.signal.aborted).toBe(false);

    deadline.resume();
    vi.advanceTimersByTime(59);
    expect(deadline.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(deadline.signal.aborted).toBe(true);
    deadline.dispose();
  });

  it("uses the active signal for a tool call and excludes elicitation from its deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });

    let requestHandler:
      | ((request: { params: unknown }, context: ClientContext) => Promise<unknown>)
      | undefined;
    let callOptions: { signal: AbortSignal; timeout: number } | undefined;
    let finishElicitation: (() => void) | undefined;
    let resolveElicitationStarted: (() => void) | undefined;
    const elicitationStarted = new Promise<void>((resolve) => {
      resolveElicitationStarted = resolve;
    });
    const connectionAbort = new AbortController();

    const client = {
      setRequestHandler: (_method: string, handler: unknown) => {
        requestHandler = handler as typeof requestHandler;
      },
      callTool: async (_request: unknown, options: { signal: AbortSignal; timeout: number }) => {
        callOptions = options;
        await requestHandler!(
          {
            params: { mode: "form", message: "Approve?", requestedSchema: {} },
          },
          { mcpReq: { signal: connectionAbort.signal } } as ClientContext,
        );
        // oxlint-disable-next-line executor/no-promise-reject -- boundary: fake MCP client models SDK abort rejection
        return await new Promise<never>((_resolve, reject) => {
          // oxlint-disable-next-line executor/no-promise-reject -- boundary: fake MCP client models SDK abort rejection
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          });
        });
      },
    };

    const invocation = Effect.runPromise(
      invokeMcpTool({
        toolId: "slow",
        toolName: "slow",
        args: {},
        transport: "streamable-http",
        connector: Effect.succeed({
          // oxlint-disable-next-line executor/no-double-cast -- boundary: minimal fake MCP client implements only invokeMcpTool's surface
          client: client as unknown as McpConnection["client"],
          close: () => Promise.resolve(),
        }),
        elicit: () =>
          Effect.callback((resume) => {
            resolveElicitationStarted!();
            finishElicitation = () =>
              resume(Effect.succeed(ElicitationResponse.make({ action: "accept" })));
          }),
      }),
    ).then(
      () => "completed" as const,
      () => "failed" as const,
    );

    await elicitationStarted;
    expect(callOptions?.timeout).toBeGreaterThan(MCP_ACTIVE_WORK_TIMEOUT_MS);
    vi.advanceTimersByTime(MCP_ACTIVE_WORK_TIMEOUT_MS);
    expect(callOptions?.signal.aborted).toBe(false);

    finishElicitation!();
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(MCP_ACTIVE_WORK_TIMEOUT_MS);
    expect(callOptions?.signal.aborted).toBe(true);
    expect(await invocation).toBe("failed");
  });

  it("interrupts an elicitation when the MCP connection closes", async () => {
    let requestHandler:
      | ((request: { params: unknown }, context: ClientContext) => Promise<unknown>)
      | undefined;
    const connectionAbort = new AbortController();
    const client = {
      setRequestHandler: (_method: string, handler: unknown) => {
        requestHandler = handler as typeof requestHandler;
      },
      callTool: async () => {
        await requestHandler!(
          {
            params: { mode: "form", message: "Approve?", requestedSchema: {} },
          },
          { mcpReq: { signal: connectionAbort.signal } } as ClientContext,
        );
        return { content: [] };
      },
    };

    const invocation = Effect.runPromise(
      invokeMcpTool({
        toolId: "closed",
        toolName: "closed",
        args: {},
        transport: "streamable-http",
        connector: Effect.succeed({
          // oxlint-disable-next-line executor/no-double-cast -- boundary: minimal fake MCP client implements only invokeMcpTool's surface
          client: client as unknown as McpConnection["client"],
          close: () => Promise.resolve(),
        }),
        elicit: () => Effect.callback(() => undefined),
      }),
    ).then(
      () => "completed" as const,
      () => "failed" as const,
    );

    await Promise.resolve();
    connectionAbort.abort();
    expect(await invocation).toBe("failed");
  });

  for (const testCase of invocationRejectionCases) {
    it.effect(testCase.name, () =>
      Effect.gen(function* () {
        const error = yield* invokeMcpTool({
          toolId: testCase.toolId,
          toolName: testCase.toolId,
          args: {},
          transport: testCase.transport,
          connector: rejectingConnector(testCase.cause),
          elicit: acceptAll,
        }).pipe(Effect.flip);

        expect(Predicate.isTagged(error, "McpInvocationError")).toBe(true);
        const invocation = error as McpInvocationError;
        expect(invocation.toolName).toBe(testCase.toolId);
        expect(invocation).toMatchObject({
          message: `MCP tool call failed for ${testCase.toolId}`,
        });
        expect(invocation).toMatchObject({
          message: expect.not.stringContaining("do-not-leak"),
        });
        expect(invocation.status).toBe(testCase.expectedStatus);
        expect("cause" in invocation).toBe(false);
      }),
    );
  }

  it.effect("marks OAuth reauthorization rejections without leaking SDK details", () =>
    Effect.gen(function* () {
      const error = yield* invokeMcpTool({
        toolId: "oauth_scope",
        toolName: "oauth_scope",
        args: {},
        transport: "streamable-http",
        connector: rejectingConnector(
          new McpOAuthReauthorizationRequired({ message: "redirect to do-not-leak" }),
        ),
        elicit: acceptAll,
      }).pipe(Effect.flip);

      expect(Predicate.isTagged(error, "McpOAuthReauthorizationRequired")).toBe(true);
      expect(error).toMatchObject({ message: expect.not.stringContaining("do-not-leak") });
      expect("cause" in error).toBe(false);
    }),
  );

  it.effect("preserves OAuth reauthorization required during auto connection setup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveReauthorizationChallengeServer();
        const error = yield* invokeMcpTool({
          toolId: "oauth_scope",
          toolName: "oauth_scope",
          args: {},
          transport: "auto",
          connector: createMcpConnector({
            transport: "remote",
            endpoint: server.url("/mcp"),
            authProvider: reauthorizationProvider,
          }),
          elicit: acceptAll,
        }).pipe(Effect.flip);

        expect(Predicate.isTagged(error, "McpOAuthReauthorizationRequired")).toBe(true);
      }),
    ),
  );
});
