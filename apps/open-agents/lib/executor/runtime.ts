import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiSwagger } from "effect/unstable/httpapi";
import { Cause, Effect, Layer } from "effect";
import { observabilityMiddleware, ErrorCapture } from "@executor-js/api";
import {
  createExecutorFumaDb,
  CoreHandlers,
  ExecutionEngineService,
  ExecutorService,
  composePluginApi,
  composePluginHandlers,
} from "@executor-js/api/server";
import {
  createExecutionEngine,
  formatExecuteResult,
  formatPausedExecution,
} from "@executor-js/execution";
import {
  ElicitationResponse,
  Subject,
  Tenant,
  createExecutor,
  matchPattern,
  ToolAddress,
  ToolBlockedError,
  type Executor,
  type OnElicitation,
  type Tool,
} from "@executor-js/sdk";
import { makeHostedHttpClientLayer } from "@executor-js/sdk/host-internal";
import { ensureDrizzleRuntimeSchemaFromTables } from "@executor-js/fumadb/adapters/drizzle";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { db } from "@/lib/db/client";
import { openAgentsExecutorPlugins, type OpenAgentsExecutorPlugins } from "./config";
import { openAgentsIntegrationPresets } from "./integration-presets";
import {
  OPEN_AGENTS_EXECUTOR_DB_PROVIDER,
  OPEN_AGENTS_EXECUTOR_NAMESPACE,
  OPEN_AGENTS_EXECUTOR_SCHEMA_VERSION,
  openAgentsExecutorTables,
} from "./db-definition";

type OpenAgentsExecutor = Executor<OpenAgentsExecutorPlugins>;

const Api = composePluginApi(openAgentsExecutorPlugins);
const ExecutorObservability = observabilityMiddleware(Api);
const ExecutorRouterConfig = Layer.succeed(HttpRouter.RouterConfig)({
  maxParamLength: 1000,
});

const OPEN_AGENTS_EXECUTOR_TENANT = Tenant.make("open-agents");

type OpenAgentsExecutorRunResult =
  | ReturnType<typeof formatExecuteResult>
  | (ReturnType<typeof formatPausedExecution> & { isError?: false });

const openAgentsExecutorDb = createExecutorFumaDb(db, {
  tables: openAgentsExecutorTables,
  namespace: OPEN_AGENTS_EXECUTOR_NAMESPACE,
  version: OPEN_AGENTS_EXECUTOR_SCHEMA_VERSION,
  provider: OPEN_AGENTS_EXECUTOR_DB_PROVIDER,
});

let executorDbReady: Promise<void> | undefined;

const ensureOpenAgentsExecutorDb = () => {
  executorDbReady ??= ensureDrizzleRuntimeSchemaFromTables(db, {
    tables: openAgentsExecutorTables,
    namespace: OPEN_AGENTS_EXECUTOR_NAMESPACE,
    version: OPEN_AGENTS_EXECUTOR_SCHEMA_VERSION,
    provider: OPEN_AGENTS_EXECUTOR_DB_PROVIDER,
  });
  return executorDbReady;
};

const nextTraceId = () =>
  `open-agents-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const ErrorCaptureLive: Layer.Layer<ErrorCapture> = Layer.succeed(
  ErrorCapture,
  ErrorCapture.of({
    captureException: (cause) =>
      Effect.sync(() => {
        const traceId = nextTraceId();
        const squashed = Cause.squash(cause);
        console.error(
          `[executor ${traceId}]`,
          squashed instanceof Error ? (squashed.stack ?? squashed) : squashed,
        );
        console.error(`[executor ${traceId}] cause:`, Cause.pretty(cause));
        return traceId;
      }),
  }),
);

export type OpenAgentsExecutorScopeInput = {
  userId: string;
  sessionId?: string;
  sessionTitle?: string;
  automationId?: string;
  automationName?: string;
  automationRunId?: string;
  automationVersionId?: string;
  automationEventId?: string;
  automationCorrelationKey?: string;
  executorToolPatterns?: string[];
  onElicitation?: OnElicitation;
};

export const getUserExecutorScopeId = (userId: string) =>
  `open-agents:user:${userId}`;

export const getSessionExecutorScopeId = (sessionId: string) =>
  `open-agents:session:${sessionId}`;

export const getAutomationExecutorScopeId = (automationId: string) =>
  `open-agents:automation:${automationId}`;

export const getAutomationRunExecutorScopeId = (runId: string) =>
  `open-agents:automation-run:${runId}`;

export const getAutomationVersionExecutorScopeId = (versionId: string) =>
  `open-agents:automation-version:${versionId}`;

export const getAutomationEventExecutorScopeId = (eventId: string) =>
  `open-agents:automation-event:${eventId}`;

export const getAutomationCorrelationExecutorScopeId = (correlationKey: string) =>
  `open-agents:automation-correlation:${correlationKey}`;

export const getSystemExecutorScopeId = () => "open-agents:system:global";

export function getExecutorApiBasePath(sessionId?: string): string {
  return sessionId ? `/api/executor/session/${encodeURIComponent(sessionId)}` : "/api/executor";
}

type OpenAgentsExecutorScope = {
  id: string;
  name: string;
  createdAt: Date;
};

function createScopes(input: OpenAgentsExecutorScopeInput): OpenAgentsExecutorScope[] {
  const now = new Date();
  const scopes: OpenAgentsExecutorScope[] = [];

  if (input.sessionId) {
    scopes.push(
      {
        id: getSessionExecutorScopeId(input.sessionId),
        name: input.sessionTitle ? `Session tools · ${input.sessionTitle}` : "Session tools",
        createdAt: now,
      },
    );
  }

  if (input.automationId) {
    scopes.push(
      {
        id: getAutomationExecutorScopeId(input.automationId),
        name: input.automationName
          ? `Automation tools · ${input.automationName}`
          : "Automation tools",
        createdAt: now,
      },
    );
  }

  if (input.automationRunId) {
    scopes.push(
      {
        id: getAutomationRunExecutorScopeId(input.automationRunId),
        name: "Automation run tools",
        createdAt: now,
      },
    );
  }

  if (input.automationVersionId) {
    scopes.push(
      {
        id: getAutomationVersionExecutorScopeId(input.automationVersionId),
        name: "Automation version tools",
        createdAt: now,
      },
    );
  }

  if (input.automationEventId) {
    scopes.push(
      {
        id: getAutomationEventExecutorScopeId(input.automationEventId),
        name: "Automation event tools",
        createdAt: now,
      },
    );
  }

  if (input.automationCorrelationKey) {
    scopes.push(
      {
        id: getAutomationCorrelationExecutorScopeId(
          input.automationCorrelationKey,
        ),
        name: "Automation correlation tools",
        createdAt: now,
      },
    );
  }

  const userScope = {
    id: getUserExecutorScopeId(input.userId),
    name: "Personal tools",
    createdAt: now,
  };
  scopes.push(userScope);

  if (input.automationId) {
    scopes.push(
      {
        id: getSystemExecutorScopeId(),
        name: "System tools",
        createdAt: now,
      },
    );
  }

  return scopes;
}

function createOpenAgentsScopeInfo(input: OpenAgentsExecutorScopeInput) {
  const scopes = createScopes(input);
  const currentScope = scopes[0]!;

  return {
    id: currentScope.id,
    name: currentScope.name,
    dir: currentScope.name,
    stack: scopes.map((scope) => ({
      id: scope.id,
      name: scope.name,
      dir: scope.name,
    })),
  };
}

export async function createOpenAgentsExecutor(
  input: OpenAgentsExecutorScopeInput,
): Promise<OpenAgentsExecutor> {
  await ensureOpenAgentsExecutorDb();

  const httpClientLayer = makeHostedHttpClientLayer({
    allowLocalNetwork:
      process.env.NODE_ENV !== "production" || process.env.EXECUTOR_ALLOW_LOCAL_NETWORK === "true",
  });

  return Effect.runPromise(
    createExecutor({
      tenant: OPEN_AGENTS_EXECUTOR_TENANT,
      subject: Subject.make(input.userId),
      db: openAgentsExecutorDb.db,
      plugins: openAgentsExecutorPlugins,
      integrationPresets: openAgentsIntegrationPresets,
      httpClientLayer,
      onElicitation:
        input.onElicitation ??
        (input.automationId
          ? () => Effect.succeed(ElicitationResponse.make({ action: "decline" }))
          : "accept-all"),
    }),
  );
}

function normalizeExecutorPattern(pattern: string): string {
  return pattern.trim().replace(/\//g, ".");
}

function toolMatchesPatterns(toolId: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return true;
  }

  const normalizedToolId = toolId.replace(/\//g, ".");
  const normalizedWithoutPrefix = normalizedToolId.startsWith("tools.")
    ? normalizedToolId.slice("tools.".length)
    : normalizedToolId;
  return patterns.some((pattern) => {
    const normalizedPattern = normalizeExecutorPattern(pattern);
    return (
      matchPattern(normalizedPattern, normalizedToolId) ||
      matchPattern(normalizedPattern, normalizedWithoutPrefix)
    );
  });
}

function filterTools(tools: readonly Tool[], patterns: string[]): readonly Tool[] {
  return tools.filter((tool) => toolMatchesPatterns(String(tool.address), patterns));
}

function withExecutorToolFilters(
  executor: OpenAgentsExecutor,
  patterns: string[] | undefined,
): OpenAgentsExecutor {
  const normalizedPatterns = patterns?.map((pattern) => pattern.trim()).filter(Boolean) ?? [];
  if (normalizedPatterns.length === 0) {
    return executor;
  }

  return {
    ...executor,
    tools: {
      ...executor.tools,
      list: (filter) =>
        executor.tools
          .list(filter)
          .pipe(Effect.map((tools) => filterTools(tools, normalizedPatterns))),
      schema: (address) =>
        toolMatchesPatterns(String(address), normalizedPatterns)
          ? executor.tools.schema(address)
          : Effect.succeed(null),
    },
    execute: (address, args, options) =>
      toolMatchesPatterns(String(address), normalizedPatterns)
        ? executor.execute(address, args, options)
        : Effect.fail(
            new ToolBlockedError({
              address: ToolAddress.make(String(address)),
              pattern: normalizedPatterns.join(", "),
            }),
          ),
  } as OpenAgentsExecutor;
}

export async function createOpenAgentsExecutorRuntime(
  input: OpenAgentsExecutorScopeInput,
) {
  const executor = withExecutorToolFilters(
    await createOpenAgentsExecutor(input),
    input.executorToolPatterns,
  );
  const engine = createExecutionEngine({
    executor,
    codeExecutor: makeQuickJsExecutor(),
  });

  return {
    execute: async (code: string): Promise<OpenAgentsExecutorRunResult> => {
      const result = await Effect.runPromise(engine.executeWithPause(code));
      if (result.status === "paused") {
        return formatPausedExecution(result.execution);
      }
      return formatExecuteResult(result.result);
    },
  };
}

async function createExecutorApiHandler(input: OpenAgentsExecutorScopeInput) {
  const executor = await createOpenAgentsExecutor(input);
  const engine = createExecutionEngine({
    executor,
    codeExecutor: makeQuickJsExecutor(),
  });

  const PluginHandlers = composePluginHandlers(openAgentsExecutorPlugins, executor);

  const apiLayer = HttpApiBuilder.layer(Api).pipe(
    Layer.provide(CoreHandlers),
    Layer.provide(ExecutorObservability),
    Layer.provide(ErrorCaptureLive),
    Layer.provideMerge(PluginHandlers),
    Layer.provideMerge(Layer.succeed(ExecutorService)(executor)),
    Layer.provideMerge(Layer.succeed(ExecutionEngineService)(engine)),
    Layer.provideMerge(HttpApiSwagger.layer(Api, { path: "/docs" })),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(ExecutorRouterConfig),
  );

  return HttpRouter.toWebHandler(apiLayer);
}

export async function handleExecutorApiRequest(
  request: Request,
  input: OpenAgentsExecutorScopeInput & { executorPath: string },
): Promise<Response> {
  if (input.executorPath === "/scope") {
    return Response.json(createOpenAgentsScopeInfo(input));
  }

  const handlers = await createExecutorApiHandler(input);
  const url = new URL(request.url);
  url.pathname = input.executorPath;

  try {
    return await handlers.handler(new Request(url, request));
  } finally {
    await handlers.dispose();
  }
}
