import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Context, Effect } from "effect";

import { addGroup, capture } from "@executor-js/api";
import { ScopeId } from "@executor-js/sdk/core";
import type { OAuth2SourceConfigType } from "@executor-js/sdk/http-source";
import type { McpPluginExtension, McpProbeEndpointInput, McpSourceConfig } from "../sdk/plugin";
import type { McpConfiguredValueInput } from "../sdk/types";
import { McpStoredSourceSchema } from "../sdk/stored-source";
import { McpGroup } from "./group";

// ---------------------------------------------------------------------------
// Service tag — holds the raw extension shape the executor produces.
// Handlers wrap their generator bodies with `capture(...)` from
// `@executor-js/api`, which translates `StorageError` to `InternalError`
// at the edge; that's why the tag type matches the SDK shape directly
// (no `Captured<>` inversion).
// ---------------------------------------------------------------------------

export class McpExtensionService extends Context.Service<McpExtensionService, McpPluginExtension>()(
  "McpExtensionService",
) {}

// ---------------------------------------------------------------------------
// Composed API
// ---------------------------------------------------------------------------

const ExecutorApiWithMcp = addGroup(McpGroup);

// ---------------------------------------------------------------------------
// Convert API payload → McpSourceConfig
// ---------------------------------------------------------------------------

const toSourceConfig = (
  payload: { transport: "remote" | "stdio" } & Record<string, unknown>,
  scope: string,
): McpSourceConfig => {
  if (payload.transport === "stdio") {
    const p = payload as {
      transport: "stdio";
      name: string;
      command: string;
      args?: readonly string[];
      env?: Record<string, string>;
      cwd?: string;
      namespace?: string;
    };
    return {
      transport: "stdio",
      scope,
      name: p.name,
      command: p.command,
      args: p.args ? [...p.args] : undefined,
      env: p.env,
      cwd: p.cwd,
      namespace: p.namespace,
    };
  }

  const p = payload as {
    transport: "remote";
    name: string;
    endpoint: string;
    remoteTransport?: "streamable-http" | "sse" | "auto";
    queryParams?: Record<string, McpConfiguredValueInput>;
    headers?: Record<string, McpConfiguredValueInput>;
    namespace?: string;
    oauth2?: OAuth2SourceConfigType;
    credentials?: Extract<McpSourceConfig, { readonly transport: "remote" }>["credentials"];
  };

  return {
    transport: "remote",
    scope,
    name: p.name,
    endpoint: p.endpoint,
    remoteTransport: p.remoteTransport,
    queryParams: p.queryParams,
    headers: p.headers,
    namespace: p.namespace,
    oauth2: p.oauth2,
    credentials: p.credentials,
  };
};

// ---------------------------------------------------------------------------
// Handlers
//
// Each handler is exactly: yield the extension service, call the method,
// return. Plugin SDK errors flow through the typed channel and are
// schema-encoded to 4xx by HttpApi (see group.ts `.addError(...)` calls).
// Defects bubble up and are captured + downgraded to `InternalError(traceId)`
// by the API-level observability middleware (see apps/cloud/src/observability.ts).
//
// No `sanitize*`, no `liftDomainErrors`, no `withObservability` per handler.
// If you find yourself adding error-handling here you're in the wrong layer.
// ---------------------------------------------------------------------------

export const McpHandlers = HttpApiBuilder.group(ExecutorApiWithMcp, "mcp", (handlers) =>
  handlers
    .handle("probeEndpoint", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* McpExtensionService;
          return yield* ext.probeEndpoint(payload as McpProbeEndpointInput);
        }),
      ),
    )
    .handle("addSource", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* McpExtensionService;
          return yield* ext.addSource(
            toSourceConfig(payload as Parameters<typeof toSourceConfig>[0], path.scopeId),
          );
        }),
      ),
    )
    .handle("removeSource", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* McpExtensionService;
          yield* ext.removeSource(payload.namespace, path.scopeId);
          return { removed: true };
        }),
      ),
    )
    .handle("refreshSource", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* McpExtensionService;
          return yield* ext.refreshSource(payload.namespace, path.scopeId);
        }),
      ),
    )
    .handle("getSource", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* McpExtensionService;
          const source = yield* ext.getSource(path.namespace, path.scopeId);
          return source
            ? McpStoredSourceSchema.make({
                namespace: source.namespace,
                scope: ScopeId.make(source.scope),
                name: source.name,
                config: source.config,
              })
            : null;
        }),
      ),
    ),
);
