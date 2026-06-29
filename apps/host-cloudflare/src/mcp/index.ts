import { Effect } from "effect";

import { decodeResumeResponse } from "@executor-js/host-mcp/browser-approval";
import type {
  McpApprovalOwner,
  McpSessionApprovalResult,
  McpSessionResumeApprovalResult,
} from "@executor-js/cloudflare/mcp/agent-durable-object";
import type { ResumeResponse } from "@executor-js/execution";

import type { CloudflareConfig, CloudflareEnv } from "../config";
import { makeAccessVerifier } from "../auth/cloudflare-access";

export { cloudflareAccessMcpAuth } from "./auth";
export { McpSessionDO } from "./session-durable-object";

const toApprovalStub = (stub: unknown): McpApprovalStub => stub as McpApprovalStub;

interface McpApprovalStub {
  getPausedExecutionForApproval(
    executionId: string,
    identity: McpApprovalOwner,
  ): Promise<McpSessionApprovalResult>;
  resumeExecutionForApproval(
    executionId: string,
    identity: McpApprovalOwner,
    response: ResumeResponse,
  ): Promise<McpSessionResumeApprovalResult>;
}

const PAUSED_PATH = /^\/api\/mcp-sessions\/([^/?#]+)\/executions\/([^/?#]+)$/;
const RESUME_PATH = /^\/api\/mcp-sessions\/([^/?#]+)\/executions\/([^/?#]+)\/resume$/;

const jsonResponse = (value: unknown, status: number): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

export const makeCloudflareApprovalHandler = (
  config: CloudflareConfig,
  env: CloudflareEnv,
): ((request: Request) => Promise<Response>) => {
  const { verify } = makeAccessVerifier(config);
  const stubFor = (sessionId: string): McpApprovalStub =>
    toApprovalStub(env.MCP_SESSION.get(env.MCP_SESSION.idFromName(`streamable-http:${sessionId}`)));

  return async (request) => {
    const principal = await Effect.runPromise(verify(request));
    if (!principal) return jsonResponse({ error: "Unauthorized" }, 401);
    const owner: McpApprovalOwner = {
      accountId: principal.accountId,
      organizationId: principal.organizationId,
    };
    const { pathname } = new URL(request.url);

    const paused = PAUSED_PATH.exec(pathname);
    if (paused && request.method === "GET") {
      const result = await stubFor(decodeURIComponent(paused[1]!)).getPausedExecutionForApproval(
        decodeURIComponent(paused[2]!),
        owner,
      );
      if (result.status !== "ok") return jsonResponse({ error: "Paused execution not found" }, 404);
      return jsonResponse({ text: result.text, structured: result.structured }, 200);
    }

    const resume = RESUME_PATH.exec(pathname);
    if (resume && request.method === "POST") {
      const raw = await Effect.runPromise(
        Effect.tryPromise({ try: () => request.json(), catch: () => null }).pipe(
          Effect.orElseSucceed(() => null),
        ),
      );
      const response = raw === null ? null : decodeResumeResponse(raw);
      if (!response) return jsonResponse({ error: "Invalid approval response" }, 400);

      const result = await stubFor(decodeURIComponent(resume[1]!)).resumeExecutionForApproval(
        decodeURIComponent(resume[2]!),
        owner,
        response,
      );
      if (result.status !== "ok") return jsonResponse({ error: "Paused execution not found" }, 404);
      return jsonResponse(
        {
          status: result.executionStatus,
          text: result.text,
          structured: result.structured,
          isError: result.isError ?? false,
        },
        200,
      );
    }

    return jsonResponse({ error: "Not found" }, 404);
  };
};
