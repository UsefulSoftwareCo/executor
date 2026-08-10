import { Cause, Effect, Predicate } from "effect";
import {
  createMcpHandler,
  createRequestStateCodec,
  inputRequired,
  McpServer,
  type InputRequiredResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  EXECUTE_SKILL,
  findSkill,
  renderSkillsIndex,
  skillCatalogFor,
  type ExecutionEngine,
  type ExecutionResult,
} from "@executor-js/execution";

import { mcpResourceKey, principalOwns, type McpResource, type Principal } from "./seams";
import {
  formatMcpExecutionFailure,
  formatMcpExecutionOutcome,
  type McpToolResult,
} from "./tool-server";

const MODERN_FLOW_TTL_MS = 10 * 60 * 1000;
const MAX_WORKSPACES = 100;
const MAX_TERMINAL_FLOWS = 1_000;

interface ModernRequestState {
  readonly version: 1;
  readonly kind: "executor.execute";
  readonly tool: "execute";
  readonly executionId: string;
  readonly argsDigest: string;
  readonly phase: "awaiting_input";
}

interface ModernFlow {
  readonly principal: Principal;
  readonly resource: McpResource;
  readonly engine: ExecutionEngine<Cause.YieldableError>;
  readonly argsDigest: string;
  readonly workspaceKey: string;
  touchedAt: number;
}

interface ModernTerminalFlow {
  readonly principal: Principal;
  readonly resource: McpResource;
  readonly argsDigest: string;
  readonly result: McpToolResult;
  touchedAt: number;
}

interface ModernWorkspace {
  readonly engine: ExecutionEngine<Cause.YieldableError>;
  readonly description: string;
  readonly close?: () => Promise<void>;
  touchedAt: number;
}

export interface ModernMcpBuild {
  readonly engine: ExecutionEngine<Cause.YieldableError>;
  readonly description: string;
  readonly close?: () => Promise<void>;
}

export type BuildModernMcp = (
  principal: Principal,
  options?: { readonly resource?: McpResource },
) => Effect.Effect<ModernMcpBuild, unknown>;

export interface ModernMcpDispatcher {
  readonly dispatch: (
    request: Request,
    principal: Principal,
    resource: McpResource,
  ) => Effect.Effect<Response>;
  readonly close: () => Promise<void>;
}

const ownerKey = (principal: Principal, resource: McpResource): string =>
  `${principal.accountId}\0${principal.organizationId}\0${mcpResourceKey(resource)}`;

const digest = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const isModernRequestState = (value: unknown): value is ModernRequestState => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Partial<ModernRequestState>;
  return (
    state.version === 1 &&
    state.kind === "executor.execute" &&
    state.tool === "execute" &&
    typeof state.executionId === "string" &&
    typeof state.argsDigest === "string" &&
    state.phase === "awaiting_input"
  );
};

const unavailableFlowResult = (executionId: string): McpToolResult => ({
  content: [
    {
      type: "text",
      text: `The paused execution ${executionId} is no longer available. Run execute again to start a fresh flow.`,
    },
  ],
  structuredContent: {
    status: "execution_expired",
    executionId,
    recovery: "re_execute",
  },
  isError: true,
});

const invalidFlowResult = (message: string): McpToolResult => ({
  content: [{ type: "text", text: message }],
  structuredContent: { status: "invalid_request_state" },
  isError: true,
});

const isMcpToolResult = (value: McpToolResult | ExecutionResult): value is McpToolResult =>
  "content" in value;

const resumeResponse = (
  ctx: ServerContext,
): {
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: Record<string, unknown>;
} | null => {
  const raw = ctx.mcpReq.inputResponses?.elicitation;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const response = raw as { action?: unknown; content?: unknown };
  if (
    response.action !== "accept" &&
    response.action !== "decline" &&
    response.action !== "cancel"
  ) {
    return null;
  }
  const content =
    typeof response.content === "object" &&
    response.content !== null &&
    !Array.isArray(response.content)
      ? (response.content as Record<string, unknown>)
      : undefined;
  return content === undefined ? { action: response.action } : { action: response.action, content };
};

const inputRequestFor = (
  execution: Extract<ExecutionResult, { status: "paused" }>["execution"],
) => {
  const request = execution.elicitationContext.request;
  return Predicate.isTagged(request, "UrlElicitation")
    ? inputRequired.elicitUrl({ message: request.message, url: request.url })
    : inputRequired.elicit({
        message: request.message,
        requestedSchema: request.requestedSchema as Parameters<
          typeof inputRequired.elicit
        >[0]["requestedSchema"],
      });
};

export const makeModernMcpDispatcher = (
  build: BuildModernMcp,
  options?: {
    readonly requestStateKey?: Uint8Array | string;
    readonly onExecutionPaused?: (executionId: string) => Promise<void>;
    readonly onResumeStarted?: (executionId: string) => Promise<void>;
    readonly onResumeSettled?: (executionId: string) => Promise<void>;
  },
): ModernMcpDispatcher => {
  const requestStateKey = options?.requestStateKey ?? crypto.getRandomValues(new Uint8Array(32));
  const flows = new Map<string, ModernFlow>();
  const terminalFlows = new Map<string, ModernTerminalFlow>();
  const resumeRuns = new Map<string, Promise<ExecutionResult | McpToolResult | null>>();
  const workspaces = new Map<string, ModernWorkspace>();
  const workspaceBuilds = new Map<string, Promise<ModernWorkspace>>();

  const sweep = (): void => {
    const cutoff = Date.now() - MODERN_FLOW_TTL_MS;
    for (const [executionId, flow] of flows) {
      if (flow.touchedAt < cutoff) {
        flows.delete(executionId);
        void options?.onResumeSettled?.(executionId).then(
          () => undefined,
          () => undefined,
        );
      }
    }
    for (const [executionId, flow] of terminalFlows) {
      if (flow.touchedAt < cutoff) terminalFlows.delete(executionId);
    }
    while (terminalFlows.size > MAX_TERMINAL_FLOWS) {
      const oldest = terminalFlows.keys().next().value;
      if (oldest === undefined) break;
      terminalFlows.delete(oldest);
    }
    const activeWorkspaceKeys = new Set([...flows.values()].map((flow) => flow.workspaceKey));
    for (const [key, workspace] of workspaces) {
      if (workspace.touchedAt < cutoff && !activeWorkspaceKeys.has(key)) {
        workspaces.delete(key);
        void workspace.close?.().then(
          () => undefined,
          () => undefined,
        );
      }
    }
    while (workspaces.size > MAX_WORKSPACES) {
      const evictable = [...workspaces.entries()]
        .filter(([key]) => !activeWorkspaceKeys.has(key))
        .sort(([, a], [, b]) => a.touchedAt - b.touchedAt)[0];
      if (!evictable) break;
      const [oldest, workspace] = evictable;
      workspaces.delete(oldest);
      void workspace?.close?.().then(
        () => undefined,
        () => undefined,
      );
    }
  };

  const workspaceFor = async (
    principal: Principal,
    resource: McpResource,
  ): Promise<ModernWorkspace> => {
    const key = ownerKey(principal, resource);
    const existing = workspaces.get(key);
    if (existing) {
      existing.touchedAt = Date.now();
      return existing;
    }
    const pending = workspaceBuilds.get(key);
    if (pending) return pending;
    const building = Effect.runPromise(build(principal, { resource })).then((built) => {
      const workspace: ModernWorkspace = { ...built, touchedAt: Date.now() };
      workspaces.set(key, workspace);
      return workspace;
    });
    workspaceBuilds.set(key, building);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: clear the in-flight build cache on both fulfillment and rejection without changing the original promise result.
    try {
      return await building;
    } finally {
      workspaceBuilds.delete(key);
    }
  };

  const dispatch = (
    request: Request,
    principal: Principal,
    resource: McpResource,
  ): Effect.Effect<Response> =>
    Effect.promise(async () => {
      sweep();
      const binding = `${ownerKey(principal, resource)}\0tools/call\0execute`;
      const codec = createRequestStateCodec<ModernRequestState>({
        key: requestStateKey,
        ttlSeconds: MODERN_FLOW_TTL_MS / 1000,
        bind: () => binding,
      });

      const serverFactory = () => {
        const server = new McpServer(
          { name: "executor", version: "1.0.0" },
          {
            capabilities: { tools: {} },
            requestState: { verify: codec.verify },
          },
        );

        server.registerTool(
          "execute",
          {
            description: [
              "Execute TypeScript in Executor's sandbox against the authenticated caller's integrations.",
              'Call `skills({ name: "execute" })` first for the workflow, live integration inventory, and result rules.',
            ].join("\n"),
            inputSchema: z.object({ code: z.string().trim().min(1) }),
          },
          async ({ code }, ctx): Promise<McpToolResult | InputRequiredResult> => {
            const argsDigest = await digest(code);
            const decoded = ctx.mcpReq.requestState<ModernRequestState>();
            let outcome: ExecutionResult;
            let activeEngine: ExecutionEngine<Cause.YieldableError>;

            if (decoded !== undefined) {
              if (!isModernRequestState(decoded) || decoded.argsDigest !== argsDigest) {
                return invalidFlowResult(
                  "The execute retry does not match its signed request state.",
                );
              }
              const terminal = terminalFlows.get(decoded.executionId);
              if (
                terminal &&
                principalOwns(terminal.principal, principal) &&
                mcpResourceKey(terminal.resource) === mcpResourceKey(resource) &&
                terminal.argsDigest === argsDigest
              ) {
                terminal.touchedAt = Date.now();
                return terminal.result;
              }
              const flow = flows.get(decoded.executionId);
              if (
                !flow ||
                !principalOwns(flow.principal, principal) ||
                mcpResourceKey(flow.resource) !== mcpResourceKey(resource) ||
                flow.argsDigest !== argsDigest
              ) {
                return unavailableFlowResult(decoded.executionId);
              }
              flow.touchedAt = Date.now();
              const workspace = workspaces.get(flow.workspaceKey);
              if (workspace) workspace.touchedAt = Date.now();
              activeEngine = flow.engine;
              const response = resumeResponse(ctx);
              if (!response) {
                const paused = await Effect.runPromise(
                  flow.engine.getPausedExecution(decoded.executionId),
                );
                if (!paused) return unavailableFlowResult(decoded.executionId);
                return inputRequired({
                  inputRequests: {
                    elicitation: inputRequestFor({ status: "paused", execution: paused }.execution),
                  },
                  requestState: await codec.mint(decoded, ctx),
                });
              }
              let resumed: ExecutionResult | McpToolResult | null;
              let run = resumeRuns.get(decoded.executionId);
              if (!run) {
                run = (async () => {
                  await options?.onResumeStarted?.(decoded.executionId);
                  // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: the DO keepalive lease must settle even if an engine adapter rejects unexpectedly.
                  try {
                    return await Effect.runPromise(
                      flow.engine
                        .resume(decoded.executionId, response)
                        .pipe(
                          Effect.catchCause((cause) =>
                            Effect.succeed(formatMcpExecutionFailure(cause)),
                          ),
                        ),
                    );
                  } finally {
                    await options?.onResumeSettled?.(decoded.executionId);
                  }
                })();
                resumeRuns.set(decoded.executionId, run);
                void run.then(
                  () => resumeRuns.delete(decoded.executionId),
                  () => resumeRuns.delete(decoded.executionId),
                );
              }
              resumed = await run;
              if (resumed === null) return unavailableFlowResult(decoded.executionId);
              if (isMcpToolResult(resumed)) {
                flows.delete(decoded.executionId);
                terminalFlows.set(decoded.executionId, {
                  principal,
                  resource,
                  argsDigest,
                  result: resumed,
                  touchedAt: Date.now(),
                });
                return resumed;
              }
              outcome = resumed;
            } else {
              const workspace = await workspaceFor(principal, resource);
              activeEngine = workspace.engine;
              const executed = await Effect.runPromise(
                workspace.engine
                  .executeWithPause(code)
                  .pipe(
                    Effect.catchCause((cause) => Effect.succeed(formatMcpExecutionFailure(cause))),
                  ),
              );
              if (isMcpToolResult(executed)) return executed;
              outcome = executed;
            }

            if (outcome.status === "completed") {
              const result = formatMcpExecutionOutcome(outcome);
              if (decoded !== undefined) {
                flows.delete(decoded.executionId);
                terminalFlows.set(decoded.executionId, {
                  principal,
                  resource,
                  argsDigest,
                  result,
                  touchedAt: Date.now(),
                });
              }
              return result;
            }

            const state: ModernRequestState = {
              version: 1,
              kind: "executor.execute",
              tool: "execute",
              executionId: outcome.execution.id,
              argsDigest,
              phase: "awaiting_input",
            };
            if (decoded !== undefined) flows.delete(decoded.executionId);
            flows.set(outcome.execution.id, {
              principal,
              resource,
              engine: activeEngine,
              argsDigest,
              workspaceKey: ownerKey(principal, resource),
              touchedAt: Date.now(),
            });
            await options?.onExecutionPaused?.(outcome.execution.id);
            return inputRequired({
              inputRequests: { elicitation: inputRequestFor(outcome.execution) },
              requestState: await codec.mint(state, ctx),
            });
          },
        );

        server.registerTool(
          "skills",
          {
            description: "Fetch Executor's execution guide and live integration inventory.",
            inputSchema: z.object({ name: z.string().optional() }),
          },
          async ({ name }): Promise<McpToolResult> => {
            const catalog = skillCatalogFor({ artifacts: false });
            const trimmed = name?.trim();
            if (!trimmed) return { content: [{ type: "text", text: renderSkillsIndex(catalog) }] };
            const skill = findSkill(trimmed, catalog);
            if (!skill) {
              return {
                content: [
                  {
                    type: "text",
                    text: `No skill named "${trimmed}".\n\n${renderSkillsIndex(catalog)}`,
                  },
                ],
                isError: true,
              };
            }
            if (skill.name !== EXECUTE_SKILL.name) {
              return { content: [{ type: "text", text: skill.body }] };
            }
            const workspace = await workspaceFor(principal, resource);
            return {
              content: [{ type: "text", text: `${skill.body}\n\n${workspace.description}` }],
            };
          },
        );

        return server;
      };

      const handler = createMcpHandler(serverFactory, { legacy: "reject" });
      return handler.fetch(request);
    });

  return {
    dispatch,
    close: async () => {
      const flowIds = [...flows.keys()];
      flows.clear();
      terminalFlows.clear();
      resumeRuns.clear();
      workspaceBuilds.clear();
      const closes = [...workspaces.values()].flatMap((workspace) =>
        workspace.close ? [workspace.close()] : [],
      );
      workspaces.clear();
      await Promise.allSettled([
        ...closes,
        ...flowIds.flatMap((executionId) =>
          options?.onResumeSettled ? [options.onResumeSettled(executionId)] : [],
        ),
      ]);
    },
  };
};
