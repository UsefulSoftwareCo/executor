import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";

import { capture } from "@executor-js/api";
import {
  RemoveConnectionInput,
  UpdateConnectionIdentityInput,
  type ConnectionId,
  type ConnectionIdentityOverride,
  type ConnectionRef,
  type ScopeId,
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
    .handle(
      "list",
      Effect.fn("connections.list")(function* () {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            const refs = yield* executor.connections.list();
            return refs.map(refToResponse);
          }),
        );
      }),
    )
    .handle(
      "remove",
      Effect.fn("connections.remove")(function* (ctx: {
        params: { scopeId: ScopeId; connectionId: ConnectionId };
      }) {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            yield* executor.connections.remove(
              RemoveConnectionInput.make({
                id: ctx.params.connectionId,
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
      Effect.fn("connections.usages")(function* (ctx: { params: { connectionId: ConnectionId } }) {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            return yield* executor.connections.usages(ctx.params.connectionId);
          }),
        );
      }),
    )
    .handle(
      "identity",
      Effect.fn("connections.identity")(function* (ctx: {
        params: { scopeId: ScopeId; connectionId: ConnectionId };
      }) {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            return yield* readConnectionIdentity({
              executor,
              scopeId: ctx.params.scopeId,
              connectionId: ctx.params.connectionId,
            });
          }),
        );
      }),
    )
    .handle(
      "updateIdentity",
      Effect.fn("connections.updateIdentity")(function* (ctx: {
        params: { scopeId: ScopeId; connectionId: ConnectionId };
        payload: { identityOverride: ConnectionIdentityOverride | null };
      }) {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            const ref = yield* executor.connections.setIdentityOverride(
              UpdateConnectionIdentityInput.make({
                id: ctx.params.connectionId,
                targetScope: ctx.params.scopeId,
                identityOverride: ctx.payload.identityOverride,
              }),
            );
            return refToResponse(ref);
          }),
        );
      }),
    ),
);
