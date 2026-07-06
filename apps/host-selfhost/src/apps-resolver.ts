import { Effect } from "effect";

import {
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
  isToolResult,
  type ConnectionRef,
  type ExecuteError,
  type Owner,
  type PluginCtx,
} from "@executor-js/sdk";
import {
  BindingError,
  type ClientResolver,
  type ConnectionCandidate,
} from "@executor-js/plugin-apps/api";

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

const bindingError = (input: {
  readonly integration: string;
  readonly connection?: string;
  readonly message: string;
  readonly cause?: unknown;
}): BindingError =>
  new BindingError({
    role: input.integration,
    integration: input.integration,
    requestedConnection: input.connection,
    message: input.message,
  });

const executeErrorMessage = (cause: ExecuteError): string =>
  typeof cause.message === "string" && cause.message.length > 0 ? cause.message : cause._tag;

const toCandidate = (connection: {
  readonly address: unknown;
  readonly integration: unknown;
  readonly name?: unknown;
  readonly owner?: unknown;
}): ConnectionCandidate => ({
  address: String(connection.address),
  integration: String(connection.integration),
  ...(connection.name !== undefined ? { name: String(connection.name) } : {}),
  ...(connection.owner !== undefined ? { owner: String(connection.owner) } : {}),
});

export const makeSelfHostAppsResolver = (input: { readonly ctx: PluginCtx }): ClientResolver => ({
  listConnections: ({ integration }) =>
    input.ctx.connections.list({ integration: IntegrationSlug.make(integration) }).pipe(
      Effect.map((connections) => connections.map(toCandidate)),
      Effect.mapError((cause) =>
        bindingError({
          integration,
          message: `failed to list ${integration} connections`,
          cause,
        }),
      ),
    ),

  resolveConnection: ({ connection }) =>
    Effect.gen(function* () {
      const ref = parseConnectionAddress(connection);
      if (!ref) return null;
      const row = yield* input.ctx.connections.get(ref).pipe(
        Effect.mapError((cause) =>
          bindingError({
            integration: String(ref.integration),
            connection,
            message: `failed to resolve connection ${connection}`,
            cause,
          }),
        ),
      );
      return row ? toCandidate(row) : null;
    }),

  call: ({ integration, connection, path, args, invokeOptions }) =>
    Effect.gen(function* () {
      const ref = parseConnectionAddress(connection);
      if (!ref) {
        return yield* bindingError({
          integration,
          connection,
          message: `invalid connection address ${connection}`,
        });
      }
      if (String(ref.integration) !== integration) {
        return yield* bindingError({
          integration,
          connection,
          message: `connection "${connection}" belongs to integration "${ref.integration}", not "${integration}"`,
        });
      }
      const tool = path.join(".");
      const address = ToolAddress.make(`${connection}.${tool}`);
      const payload = args[0] ?? {};
      const result = yield* input.ctx.execute(address, payload, invokeOptions).pipe(
        Effect.mapError((cause) =>
          bindingError({
            integration,
            connection,
            message: executeErrorMessage(cause),
            cause,
          }),
        ),
      );
      if (isToolResult(result)) {
        if (result.ok) return result.data;
        return yield* bindingError({
          integration,
          connection,
          message: result.error.message,
        });
      }
      return result;
    }),
});
