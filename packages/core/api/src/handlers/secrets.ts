import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";
import { RemoveSecretInput, SetSecretInput, type SecretRef } from "@executor-js/sdk";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { capture } from "@executor-js/api";

const refToResponse = (ref: SecretRef) => ({
  id: ref.id,
  scopeId: ref.scopeId,
  name: ref.name,
  provider: ref.provider,
  createdAt: ref.createdAt.getTime(),
});

export const SecretsHandlers = HttpApiBuilder.group(ExecutorApi, "secrets", (handlers) =>
  handlers
    .handle("list", () =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const refs = yield* executor.secrets.list();
          return refs.map(refToResponse);
        }),
      ),
    )
    .handle("listAll", () =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const refs = yield* executor.secrets.listAll();
          return refs.map(refToResponse);
        }),
      ),
    )
    .handle("status", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const status = yield* executor.secrets.status(path.secretId);
          return { secretId: path.secretId, status };
        }),
      ),
    )
    .handle("set", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const ref = yield* executor.secrets.set(
            new SetSecretInput({
              id: payload.id,
              scope: path.scopeId,
              name: payload.name,
              value: payload.value,
              provider: payload.provider,
            }),
          );
          return refToResponse(ref);
        }),
      ),
    )
    .handle("remove", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          yield* executor.secrets.remove(
            new RemoveSecretInput({
              id: path.secretId,
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
          return yield* executor.secrets.usages(path.secretId);
        }),
      ),
    ),
);
