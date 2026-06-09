import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Context, Effect } from "effect";

import { addGroup, capture } from "@executor-js/api";
import type { McpPluginExtension, McpProbeEndpointInput, McpServerInput } from "../sdk/plugin";
import { parseMcpIntegrationConfig } from "../sdk/types";
import { McpGroup } from "./group";

// ---------------------------------------------------------------------------
// Service tag — holds the raw extension shape the executor produces. Handlers
// wrap their generator bodies with `capture(...)` from `@executor-js/api`,
// which translates `StorageError` to `InternalError` at the edge.
// ---------------------------------------------------------------------------

export class McpExtensionService extends Context.Service<McpExtensionService, McpPluginExtension>()(
  "McpExtensionService",
) {}

// ---------------------------------------------------------------------------
// Composed API
// ---------------------------------------------------------------------------

const ExecutorApiWithMcp = addGroup(McpGroup);

// ---------------------------------------------------------------------------
// Convert API payload → McpServerInput
// ---------------------------------------------------------------------------

const toServerInput = (
  payload: { transport?: "remote" | "stdio" } & Record<string, unknown>,
): McpServerInput => {
  if (payload.transport === "stdio") {
    const p = payload as {
      transport: "stdio";
      name: string;
      command: string;
      args?: readonly string[];
      env?: Record<string, string>;
      cwd?: string;
      slug?: string;
    };
    return {
      transport: "stdio",
      name: p.name,
      command: p.command,
      args: p.args ? [...p.args] : undefined,
      env: p.env,
      cwd: p.cwd,
      slug: p.slug,
    };
  }

  const p = payload as {
    transport?: "remote";
    name: string;
    endpoint: string;
    remoteTransport?: "streamable-http" | "sse" | "auto";
    queryParams?: Record<string, string>;
    headers?: Record<string, string>;
    slug?: string;
    auth?: McpServerInput extends { auth?: infer A } ? A : never;
  };

  return {
    transport: "remote",
    name: p.name,
    endpoint: p.endpoint,
    remoteTransport: p.remoteTransport,
    queryParams: p.queryParams,
    headers: p.headers,
    slug: p.slug,
    auth: p.auth,
  };
};

// ---------------------------------------------------------------------------
// Handlers
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
    .handle("addServer", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* McpExtensionService;
          return yield* ext.addServer(
            toServerInput(payload as Parameters<typeof toServerInput>[0]),
          );
        }),
      ),
    )
    .handle("removeServer", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* McpExtensionService;
          yield* ext.removeServer(path.slug);
          return { removed: true };
        }),
      ),
    )
    .handle("getServer", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* McpExtensionService;
          const integration = yield* ext.getServer(path.slug);
          if (integration === null) return null;
          const config = parseMcpIntegrationConfig(integration.config);
          if (config === null) return null;
          return {
            slug: integration.slug,
            description: integration.description,
            kind: integration.kind,
            canRemove: integration.canRemove,
            canRefresh: integration.canRefresh,
            config,
          };
        }),
      ),
    )
    .handle("configureServer", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* McpExtensionService;
          yield* ext.configureServer(path.slug, payload.config);
          return { config: payload.config };
        }),
      ),
    ),
);
