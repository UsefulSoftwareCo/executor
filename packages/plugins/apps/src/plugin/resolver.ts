import { Effect } from "effect";
import {
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
  isToolResult,
  type ConnectionRef,
  type Owner,
  type PluginCtx,
} from "@executor-js/sdk";

import { BindingError, type ClientResolver, type ConnectionCandidate } from "./bindings";

export interface AppsResolverPluginCtx {
  readonly connections: Pick<PluginCtx["connections"], "list" | "get">;
  readonly execute: PluginCtx["execute"];
}

const parseConnectionAddress = (address: string): ConnectionRef | null => {
  const parts = address.split(".");
  if (parts.length !== 4 || parts[0] !== "tools") return null;
  const [, integration, owner, name] = parts;
  if (!integration || !name) return null;
  if (owner !== "org" && owner !== "user") return null;
  return {
    owner: owner as Owner,
    integration: IntegrationSlug.make(integration),
    name: ConnectionName.make(name),
  };
};

const toCandidate = (connection: {
  readonly address?: unknown;
  readonly integration: unknown;
  readonly owner?: unknown;
  readonly name?: unknown;
}): ConnectionCandidate => ({
  address:
    typeof connection.address === "string"
      ? connection.address
      : `tools.${String(connection.integration)}.${String(connection.owner)}.${String(
          connection.name,
        )}`,
  integration: String(connection.integration),
});

export const makePluginCtxAppsResolver = (input: {
  readonly ctx: AppsResolverPluginCtx;
}): ClientResolver => ({
  listConnections: ({ integration }) =>
    input.ctx.connections.list({ integration: IntegrationSlug.make(integration) }).pipe(
      Effect.map((connections) => connections.map(toCandidate)),
      Effect.mapError(
        () =>
          new BindingError({
            role: integration,
            integration,
            message: `failed to list ${integration} connections`,
          }),
      ),
    ),
  resolveConnection: ({ connection }) =>
    Effect.gen(function* () {
      const ref = parseConnectionAddress(connection);
      if (!ref) return null;
      const row = yield* input.ctx.connections.get(ref).pipe(
        Effect.mapError(
          () =>
            new BindingError({
              role: String(ref.integration),
              integration: String(ref.integration),
              requestedConnection: connection,
              message: `failed to resolve connection ${connection}`,
            }),
        ),
      );
      return row ? toCandidate(row) : null;
    }),
  call: ({ integration, connection, path, args, invokeOptions }) =>
    Effect.gen(function* () {
      const ref = parseConnectionAddress(connection);
      if (!ref) {
        return yield* new BindingError({
          role: integration,
          integration,
          requestedConnection: connection,
          message: `invalid connection address ${connection}`,
        });
      }
      if (String(ref.integration) !== integration) {
        return yield* new BindingError({
          role: integration,
          integration,
          requestedConnection: connection,
          message: `connection "${connection}" belongs to integration "${ref.integration}", not "${integration}"`,
        });
      }
      const address = ToolAddress.make(`${connection}.${path.join(".")}`);
      const result = yield* input.ctx.execute(address, args, invokeOptions).pipe(
        Effect.mapError(
          () =>
            new BindingError({
              role: integration,
              integration,
              requestedConnection: connection,
              message: `failed to execute ${address}`,
            }),
        ),
      );
      if (isToolResult(result)) {
        if (result.ok) return result.data;
        return yield* new BindingError({
          role: integration,
          integration,
          requestedConnection: connection,
          message: result.error.message,
        });
      }
      return result;
    }),
});
