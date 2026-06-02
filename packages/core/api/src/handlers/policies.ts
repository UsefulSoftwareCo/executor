import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";
import type { ToolPolicy } from "@executor-js/sdk";
import type { PolicyId, ScopeId } from "@executor-js/sdk/shared";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { type CreateToolPolicyPayload, type UpdateToolPolicyPayload } from "../policies/api";
import { capture } from "@executor-js/api";

const policyToResponse = (p: ToolPolicy) => ({
  id: p.id,
  scopeId: p.scopeId,
  pattern: p.pattern,
  action: p.action,
  position: p.position,
  createdAt: p.createdAt.getTime(),
  updatedAt: p.updatedAt.getTime(),
});

export const PoliciesHandlers = HttpApiBuilder.group(ExecutorApi, "policies", (handlers) =>
  handlers
    .handle(
      "list",
      Effect.fn("policies.list")(function* () {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            const policies = yield* executor.policies.list();
            return policies.map(policyToResponse);
          }),
        );
      }),
    )
    .handle(
      "create",
      Effect.fn("policies.create")(function* (ctx: {
        payload: typeof CreateToolPolicyPayload.Type;
      }) {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            const created = yield* executor.policies.create({
              targetScope: ctx.payload.targetScope,
              pattern: ctx.payload.pattern,
              action: ctx.payload.action,
              position: ctx.payload.position,
            });
            return policyToResponse(created);
          }),
        );
      }),
    )
    .handle(
      "update",
      Effect.fn("policies.update")(function* (ctx: {
        params: { policyId: typeof PolicyId.Type };
        payload: typeof UpdateToolPolicyPayload.Type;
      }) {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            const updated = yield* executor.policies.update({
              id: ctx.params.policyId,
              targetScope: ctx.payload.targetScope,
              pattern: ctx.payload.pattern,
              action: ctx.payload.action,
              position: ctx.payload.position,
            });
            return policyToResponse(updated);
          }),
        );
      }),
    )
    .handle(
      "remove",
      Effect.fn("policies.remove")(function* (ctx: {
        params: { policyId: typeof PolicyId.Type; scopeId: typeof ScopeId.Type };
      }) {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            yield* executor.policies.remove({
              id: ctx.params.policyId,
              targetScope: ctx.params.scopeId,
            });
            return { removed: true };
          }),
        );
      }),
    ),
);
