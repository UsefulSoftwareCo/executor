import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";

import { capture } from "@executor-js/api";
import {
  RemoveConnectionInput,
  UpdateConnectionIdentityInput,
  type ConnectionRef,
} from "@executor-js/sdk";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { readConnectionIdentity } from "./connection-identity";

const refToResponse = (ref: ConnectionRef) => ({
  id: ref.id,
  scopeId: ref.scopeId,
  provider: ref.provider,
  identityLabel: ref.identityLabel,
  expiresAt: ref.expiresAt,
  oauthScope: ref.oauthScope,
  identityOverride: ref.identityOverride,
  createdAt: ref.createdAt.getTime(),
  updatedAt: ref.updatedAt.getTime(),
});

export const ConnectionsHandlers = HttpApiBuilder.group(ExecutorApi, "connections", (handlers) =>
  handlers
    .handle("list", () =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const refs = yield* executor.connections.list();
          return refs.map(refToResponse);
        }),
      ),
    )
    .handle("remove", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          yield* executor.connections.remove(
            RemoveConnectionInput.make({
              id: path.connectionId,
              targetScope: path.scopeId,
            }),
          );
          return { removed: true };
        }),
      ),
    )
    .handle("usages", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return yield* executor.connections.usages(path.connectionId);
        }),
      ),
    )
    .handle("identity", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return yield* readConnectionIdentity({
            executor,
            scopeId: path.scopeId,
            connectionId: path.connectionId,
          });
        }),
      ),
    )
    .handle("updateIdentity", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const ref = yield* executor.connections.setIdentityOverride(
            UpdateConnectionIdentityInput.make({
              id: path.connectionId,
              targetScope: path.scopeId,
              identityOverride: payload.identityOverride,
            }),
          );
          return refToResponse(ref);
        }),
      ),
    ),
);
