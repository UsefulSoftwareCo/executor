import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";

import { capture } from "@executor-js/api";
import { RemoveConnectionInput, type ConnectionRef } from "@executor-js/sdk";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";

const refToResponse = (ref: ConnectionRef) => ({
  id: ref.id,
  scopeId: ref.scopeId,
  provider: ref.provider,
  identityLabel: ref.identityLabel,
  expiresAt: ref.expiresAt,
  oauthScope: ref.oauthScope,
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
            new RemoveConnectionInput({
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
    ),
);
