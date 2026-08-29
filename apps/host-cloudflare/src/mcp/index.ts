import { Effect } from "effect";

import { decodeResumeResponse } from "@executor-js/host-mcp/browser-approval";
import type { Principal } from "@executor-js/host-mcp";
import type { McpApprovalOwner } from "@executor-js/cloudflare/mcp/agent-durable-object";
import { mcpSessionStub } from "@executor-js/cloudflare/mcp/session-stub";
import type { BetterAuthHandle } from "@executor-js/api/server";

import type { CloudflareConfig, CloudflareEnv } from "../config";
import { makeAccessVerifier } from "../auth/cloudflare-access";

export { cloudflareAccessMcpAuth } from "./auth";
export { McpSessionDO } from "./session-durable-object";
export { McpExecutionOwnerDirectoryDO } from "@executor-js/cloudflare/mcp/execution-owner-directory";

const PAUSED_PATH = /^\/api\/mcp-sessions\/([^/?#]+)\/executions\/([^/?#]+)$/;
const RESUME_PATH = /^\/api\/mcp-sessions\/([^/?#]+)\/executions\/([^/?#]+)\/resume$/;

const jsonResponse = (value: unknown, status: number): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

export const makeCloudflareApprovalHandler = (
  config: CloudflareConfig,
  env: CloudflareEnv,
  betterAuth: BetterAuthHandle | null,
): ((request: Request) => Promise<Response>) => {
  const { verify } = makeAccessVerifier(config);
  const stubFor = (sessionId: string) => mcpSessionStub(env.MCP_SESSION, sessionId);

  const getPrincipal = (request: Request): Promise<Principal | null> => {
    if (config.authMode === "builtin" && betterAuth) {
      return Effect.runPromise(
        Effect.tryPromise({
          try: () => betterAuth.auth.api.getSession({ headers: request.headers }),
          catch: () => null,
        }).pipe(
          Effect.map((resolved) => {
            if (!resolved) return null;
            const roles = (((resolved.user as any).role ?? "user") as string)
              .split(",")
              .map((role) => role.trim())
              .filter((role) => role.length > 0);
            return {
              accountId: resolved.user.id,
              organizationId:
                (resolved.session as any).activeOrganizationId ?? betterAuth.organizationId,
              organizationName: betterAuth.organizationName,
              email: resolved.user.email,
              name: resolved.user.name ?? null,
              avatarUrl: resolved.user.image ?? null,
              roles,
            } as Principal;
          }),
          Effect.orElseSucceed(() => null),
        ),
      );
    }
    return Effect.runPromise(verify(request)).then((principal) =>
      principal ? (principal as Principal) : null,
    );
  };

  return async (request) => {
    const principal = await getPrincipal(request);
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
