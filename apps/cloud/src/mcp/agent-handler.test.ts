import { describe, expect, it } from "@effect/vitest";
// oxlint-disable-next-line executor/no-vitest-import -- vi.mock is hoisted only when imported from vitest itself
import { vi } from "vitest";
import { Effect, Layer } from "effect";

import { McpAuthProvider, authenticated, type Principal } from "@executor-js/host-mcp";

import type { CloudPrincipal } from "./auth-provider";

// The handler's collaborators are replaced so the test sees only its ordering:
// which path a request takes after authentication.
const mocks = vi.hoisted(() => ({
  principal: undefined as unknown,
  validateMcpSessionOwner: vi.fn(),
  serveFetch: vi.fn(),
  forwardToV2: vi.fn(),
}));

vi.mock("./auth-provider", () => ({
  cloudMcpAuth: Layer.succeed(McpAuthProvider)({
    discoveryRoutes: [],
    resourceMetadataUrl: () => "https://executor.test/.well-known/oauth-protected-resource/mcp",
    authenticate: () => Effect.succeed(authenticated(mocks.principal as Principal)),
  }),
}));
vi.mock("../observability/telemetry", () => ({ WorkerTelemetryLive: Layer.empty }));
vi.mock("../observability/memory-metrics", () => ({
  wrapMcpSseResponse: (_request: Request, _env: unknown, response: Response) => response,
}));
vi.mock("./session-durable-object", () => ({
  McpSessionDOSqlite: {
    serve: () => ({ fetch: mocks.serveFetch }),
  },
}));
vi.mock("@executor-js/cloudflare/mcp/session-stub", () => ({
  mcpSessionStub: () => ({ validateMcpSessionOwner: mocks.validateMcpSessionOwner }),
}));
vi.mock("./toolkit-lookup", () => ({ resolveToolkitRowId: vi.fn() }));
vi.mock("./v2-forward", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./v2-forward")>()),
  forwardToV2: mocks.forwardToV2,
}));

const { makeCloudMcpAgentHandler } = await import("./agent-handler");

const base: Principal = {
  accountId: "user_EXAMPLE",
  organizationId: "org_EXAMPLE",
  organizationName: "Example",
  orgRoleModel: "organization",
  orgRole: "member",
  email: "",
  name: null,
  avatarUrl: null,
  roles: [],
};

// oxlint-disable-next-line executor/no-double-cast -- minimal Env stub: the mocked collaborators never read it
const env = { MCP_SESSION: {} } as unknown as Env;
const ctx = {} as ExecutionContext;

const post = (headers: Record<string, string> = {}) =>
  new Request("https://executor.sh/mcp", { method: "POST", headers, body: "{}" });

describe("cloud MCP handler v2 forwarding", () => {
  it("forwards a moved org with an mcp-session-id without touching the v1 session DO", async () => {
    const principal: CloudPrincipal = { ...base, movedToV2: { v2OrganizationId: "v2-org" } };
    mocks.principal = principal;
    mocks.forwardToV2.mockResolvedValue(new Response("from v2", { status: 200 }));

    const response = await makeCloudMcpAgentHandler()(
      post({ "mcp-session-id": "v2-issued-session" }),
      env,
      ctx,
    );

    expect(await response.text()).toBe("from v2");
    expect(mocks.forwardToV2).toHaveBeenCalledTimes(1);
    expect(mocks.forwardToV2.mock.calls[0]?.[2]).toEqual({ v2OrganizationId: "v2-org" });
    expect(mocks.validateMcpSessionOwner).not.toHaveBeenCalled();
    expect(mocks.serveFetch).not.toHaveBeenCalled();
  });

  it("leaves a non-moved org on the v1 session path", async () => {
    mocks.principal = base;
    mocks.forwardToV2.mockClear();
    mocks.validateMcpSessionOwner.mockResolvedValue("ok");
    mocks.serveFetch.mockResolvedValue(new Response("from v1", { status: 200 }));

    const response = await makeCloudMcpAgentHandler()(
      post({ "mcp-session-id": "v1-session" }),
      env,
      ctx,
    );

    expect(await response.text()).toBe("from v1");
    expect(mocks.forwardToV2).not.toHaveBeenCalled();
    expect(mocks.validateMcpSessionOwner).toHaveBeenCalledTimes(1);
    expect(mocks.serveFetch).toHaveBeenCalledTimes(1);
  });

  it("answers OPTIONS before authenticating, even for a moved org", async () => {
    mocks.principal = { ...base, movedToV2: { v2OrganizationId: "v2-org" } };
    mocks.forwardToV2.mockClear();

    const response = await makeCloudMcpAgentHandler()(
      new Request("https://executor.sh/mcp", { method: "OPTIONS" }),
      env,
      ctx,
    );

    expect(response.status).toBe(204);
    expect(mocks.forwardToV2).not.toHaveBeenCalled();
  });
});
