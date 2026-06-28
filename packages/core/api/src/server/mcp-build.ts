import { Effect, Layer } from "effect";

import { McpErrorReporter, type Principal } from "@executor-js/host-mcp";
import {
  McpEngineBuildError,
  type McpBuildServer,
  type McpBuildServerOptions,
} from "@executor-js/host-mcp/in-memory-session-store";
import { createExecutorMcpServer } from "@executor-js/host-mcp/tool-server";

import { ErrorCapture } from "../observability";
import { CodeExecutorProvider, EngineDecorator, makeExecutionStack } from "./execution-stack";
import { DbProvider } from "./executor-fuma-db";
import { HostConfig, PluginsProvider, RequestOrgSlug } from "./scoped-executor";

// ---------------------------------------------------------------------------
// Shared in-process MCP host helpers.
//
// Every host that serves MCP from one isolate (self-host, the Cloudflare QuickJS
// host) builds its per-session McpServer the same way — assemble the scoped
// engine via `makeExecutionStack`, wrap it with `createExecutorMcpServer` — and
// reports orchestration defects through the same console `ErrorCapture` seam.
// These two factories are the single home for that logic; a host supplies ONLY
// its fully-provided execution-stack layer and its `ErrorCapture` layer. The
// cross-isolate variant (cloud's Durable Object store) is the exception that
// builds its engine inside the DO.
// ---------------------------------------------------------------------------

/** The five execution-stack seams a host fully provides (no residual). */
export type McpExecutionStackLayer = Layer.Layer<
  DbProvider | PluginsProvider | HostConfig | CodeExecutorProvider | EngineDecorator
>;

/**
 * Build the per-session MCP server factory over a host's execution stack:
 * `makeExecutionStack` → engine → `createExecutorMcpServer`. Hosts differ only
 * in the injected stack layer (libSQL vs D1, etc.).
 */
export const makeMcpBuildServer =
  (executionStack: McpExecutionStackLayer): McpBuildServer =>
  (principal: Principal, options?: McpBuildServerOptions) =>
    makeExecutionStack(principal.accountId, principal.organizationId, principal.organizationName, {
      mcpResource: options?.resource,
    }).pipe(
      Effect.map(({ engine }) => engine),
      // Pin browser-handoff URLs to the principal's org slug when present;
      // absent slug leaves the service unprovided and the URL stays bare.
      principal.organizationSlug !== undefined
        ? Effect.provideService(RequestOrgSlug, { slug: principal.organizationSlug })
        : (effect) => effect,
      Effect.provide(executionStack),
      Effect.mapError((cause) => new McpEngineBuildError({ cause })),
      Effect.flatMap((engine) =>
        createExecutorMcpServer({ engine, ...(options ?? {}) }).pipe(
          Effect.map((mcpServer) => ({ mcpServer, engine })),
        ),
      ),
    );

/**
 * The standard console `McpErrorReporter` seam: route an orchestration defect
 * the MCP envelope would otherwise swallow into a 500 through the host's
 * `ErrorCapture`, so operators still see it. Hosts differ only in the capture
 * layer (self-host/Cloudflare console; cloud overrides with Sentry separately).
 */
export const makeConsoleMcpErrorReporter = (
  errorCapture: Layer.Layer<ErrorCapture>,
): Layer.Layer<McpErrorReporter> =>
  Layer.effect(
    McpErrorReporter,
    Effect.gen(function* () {
      const capture = yield* ErrorCapture;
      return { report: (cause) => Effect.asVoid(capture.captureException(cause)) };
    }),
  ).pipe(Layer.provide(errorCapture));
