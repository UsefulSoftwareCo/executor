import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";
import { PolicyId, type ToolPolicy } from "@executor-js/sdk";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { capture } from "@executor-js/api";

const policyToResponse = (p: ToolPolicy) => ({
  id: p.id,
  owner: p.owner,
  pattern: p.pattern,
  action: p.action,
  position: p.position,
  createdAt: p.createdAt.getTime(),
  updatedAt: p.updatedAt.getTime(),
});

export const PoliciesHandlers = HttpApiBuilder.group(ExecutorApi, "policies", (handlers) =>
  handlers
    .handle("list", () =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const policies = yield* executor.policies.list();
          return policies.map(policyToResponse);
        }),
      ),
    )
    .handle("create", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const created = yield* executor.policies.create({
            owner: payload.owner,
            pattern: payload.pattern,
            action: payload.action,
            position: payload.position,
          });
          return policyToResponse(created);
        }),
      ),
    )
    .handle("update", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const updated = yield* executor.policies.update({
            id: PolicyId.make(path.policyId),
            owner: payload.owner,
            pattern: payload.pattern,
            action: payload.action,
            position: payload.position,
          });
          return policyToResponse(updated);
        }),
      ),
    )
    .handle("remove", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          yield* executor.policies.remove({
            id: PolicyId.make(path.policyId),
            owner: payload.owner,
          });
          return { removed: true };
        }),
      ),
    ),
);
