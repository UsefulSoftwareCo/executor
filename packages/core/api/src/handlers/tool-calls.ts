import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";
import type { ToolCall } from "@executor-js/sdk";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { capture } from "@executor-js/api";

const toResponse = (call: ToolCall) => ({
  id: call.id,
  owner: call.owner,
  address: call.address,
  integration: call.integration,
  connection: call.connection,
  tool: call.tool,
  outcome: call.outcome,
  errorCode: call.errorCode,
  errorMessage: call.errorMessage,
  policyAction: call.policyAction,
  policyPattern: call.policyPattern,
  durationMs: call.durationMs,
  argKeys: call.argKeys,
  createdAt: call.createdAt.getTime(),
});

export const ToolCallsHandlers = HttpApiBuilder.group(ExecutorApi, "toolCalls", (handlers) =>
  handlers.handle("list", ({ query }) =>
    capture(
      Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const calls = yield* executor.toolCalls.list({
          integration: query.integration,
          connection: query.connection,
          outcome: query.outcome,
          // Epoch ms on the wire; the executor filters on a Date.
          since: query.since === undefined ? undefined : new Date(query.since),
          limit: query.limit,
          offset: query.offset,
        });
        return calls.map(toResponse);
      }),
    ),
  ),
);
