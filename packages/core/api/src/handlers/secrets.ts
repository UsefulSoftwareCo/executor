import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";
import {
  RemoveSecretInput,
  SetSecretInput,
  type ScopeId,
  type SecretId,
  type SecretRef,
} from "@executor-js/sdk";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { capture } from "@executor-js/api";
import { type SetSecretPayload } from "../secrets/api";

const refToResponse = (ref: SecretRef) => ({
  id: ref.id,
  scopeId: ref.scopeId,
  name: ref.name,
  provider: ref.provider,
  createdAt: ref.createdAt.getTime(),
});

export const SecretsHandlers = HttpApiBuilder.group(ExecutorApi, "secrets", (handlers) =>
  handlers
    .handle(
      "list",
      Effect.fn("secrets.list")(function* () {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            const refs = yield* executor.secrets.list();
            return refs.map(refToResponse);
          }),
        );
      }),
    )
    .handle(
      "listAll",
      Effect.fn("secrets.listAll")(function* () {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            const refs = yield* executor.secrets.listAll();
            return refs.map(refToResponse);
          }),
        );
      }),
    )
    .handle(
      "status",
      Effect.fn("secrets.status")(function* (ctx: { params: { secretId: SecretId } }) {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            const status = yield* executor.secrets.status(ctx.params.secretId);
            return { secretId: ctx.params.secretId, status };
          }),
        );
      }),
    )
    .handle(
      "set",
      Effect.fn("secrets.set")(function* (ctx: {
        params: { scopeId: ScopeId };
        payload: typeof SetSecretPayload.Type;
      }) {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            const ref = yield* executor.secrets.set(
              SetSecretInput.make({
                id: ctx.payload.id,
                scope: ctx.params.scopeId,
                name: ctx.payload.name,
                value: ctx.payload.value,
                provider: ctx.payload.provider,
              }),
            );
            return refToResponse(ref);
          }),
        );
      }),
    )
    .handle(
      "remove",
      Effect.fn("secrets.remove")(function* (ctx: {
        params: { scopeId: ScopeId; secretId: SecretId };
      }) {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            yield* executor.secrets.remove(
              RemoveSecretInput.make({
                id: ctx.params.secretId,
                targetScope: ctx.params.scopeId,
              }),
            );
            return { removed: true };
          }),
        );
      }),
    )
    .handle(
      "usages",
      Effect.fn("secrets.usages")(function* (ctx: { params: { secretId: SecretId } }) {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            return yield* executor.secrets.usages(ctx.params.secretId);
          }),
        );
      }),
    ),
);
