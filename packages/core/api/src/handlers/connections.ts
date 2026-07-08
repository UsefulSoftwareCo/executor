import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";

import { capture } from "@executor-js/api";
import {
  ConnectionNotFoundError,
  type Connection,
  type ConnectionRef,
  type CreateConnectionInput,
  type HealthCheckResult,
  type Tool,
  type ValidateConnectionInput,
} from "@executor-js/sdk";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";

const toResponse = (c: Connection) => ({
  owner: c.owner,
  name: c.name,
  integration: c.integration,
  template: c.template,
  provider: c.provider,
  address: c.address,
  identityLabel: c.identityLabel ?? null,
  description: c.description ?? null,
  expiresAt: c.expiresAt ?? null,
  oauthClient: c.oauthClient ?? null,
  oauthClientOwner: c.oauthClientOwner ?? null,
  oauthScope: c.oauthScope ?? null,
  lastHealth: c.lastHealth ?? null,
  toolsSyncError: c.toolsSyncError ?? null,
});

const toolToResponse = (t: Tool) => ({
  address: String(t.address),
  owner: t.owner,
  integration: t.integration,
  connection: t.connection,
  name: String(t.name),
  pluginId: t.pluginId,
  description: t.description,
});

const toHealthResponse = (r: HealthCheckResult) => ({
  status: r.status,
  checkedAt: r.checkedAt,
  ...(r.httpStatus !== undefined ? { httpStatus: r.httpStatus } : {}),
  ...(r.identity !== undefined ? { identity: r.identity } : {}),
  ...(r.detail !== undefined ? { detail: r.detail } : {}),
  ...(r.responseSample !== undefined ? { responseSample: r.responseSample } : {}),
});

export const ConnectionsHandlers = HttpApiBuilder.group(ExecutorApi, "connections", (handlers) =>
  handlers
    .handle("list", ({ query }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const connections = yield* executor.connections.list({
            integration: query.integration,
            owner: query.owner,
          });
          return connections.map(toResponse);
        }),
      ),
    )
    .handle("create", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          // The payload is the discriminated `CreateConnectionInput` union
          // (`{ value }` | `{ values }` | `{ from }`); pass it through verbatim.
          const created = yield* executor.connections.create(payload as CreateConnectionInput);
          return toResponse(created);
        }),
      ),
    )
    .handle("get", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const ref: ConnectionRef = {
            owner: path.owner,
            integration: path.integration,
            name: path.name,
          };
          const connection = yield* executor.connections.get(ref);
          if (connection === null) {
            return yield* new ConnectionNotFoundError({
              owner: path.owner,
              integration: path.integration,
              name: path.name,
            });
          }
          return toResponse(connection);
        }),
      ),
    )
    .handle("update", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const updated = yield* executor.connections.update(
            {
              owner: path.owner,
              integration: path.integration,
              name: path.name,
            },
            {
              ...(payload.description !== undefined ? { description: payload.description } : {}),
              ...(payload.identityLabel !== undefined
                ? { identityLabel: payload.identityLabel }
                : {}),
            },
          );
          return toResponse(updated);
        }),
      ),
    )
    .handle("remove", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          yield* executor.connections.remove({
            owner: path.owner,
            integration: path.integration,
            name: path.name,
          });
          return { removed: true };
        }),
      ),
    )
    .handle("refresh", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const tools = yield* executor.connections.refresh({
            owner: path.owner,
            integration: path.integration,
            name: path.name,
          });
          return tools.map(toolToResponse);
        }),
      ),
    )
    .handle("checkHealth", ({ params: path, query }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const result = yield* executor.connections.checkHealth(
            {
              owner: path.owner,
              integration: path.integration,
              name: path.name,
            },
            query.ifStaleMs !== undefined ? { ifStaleMs: query.ifStaleMs } : undefined,
          );
          return toHealthResponse(result);
        }),
      ),
    )
    .handle("validate", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          // The payload mirrors `ValidateConnectionInput`: owner/integration/
          // template/spec plus a single credential origin (`value` | `values` |
          // `from`). Pass it through verbatim.
          const result = yield* executor.connections.validate(payload as ValidateConnectionInput);
          return toHealthResponse(result);
        }),
      ),
    ),
);
