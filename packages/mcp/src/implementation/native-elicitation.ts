/** Native approval delivery holds only the active MCP request; codemode remains parked while the user decides. */
import { Clock, Effect, Option, Schema } from "effect";
import { McpSchema } from "effect/unstable/ai";
import { NativeElicitationFailed } from "../contracts/elicitation.ts";
import type { McpBackend } from "../contracts/backend.ts";
import type { makeExecutions } from "./executions.ts";

/** Drive the shared continuation manager using the requesting client's elicitation responses. */
export const executeNative = (
  executions: Effect.Success<ReturnType<typeof makeExecutions>>,
  caller: string,
  backend: McpBackend<Error>,
  code: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* Effect.serviceOption(McpSchema.McpServerClient);
      const { clientCapabilities } = yield* McpSchema.McpRequestContext;
      const capability = clientCapabilities.elicitation;
      // Older elicitation capabilities used an empty object to advertise form support.
      if (
        Option.isNone(client) ||
        capability === undefined ||
        (capability.form === undefined && capability.url !== undefined)
      ) {
        return yield* new NativeElicitationFailed({ reason: "unsupported" });
      }
      const reverse = yield* client.value.getClient;
      let result = yield* executions.execute(caller, backend, code);
      while (result.status === "approval-required" || result.status === "input-required") {
        const request = result;
        result = yield* Effect.gen(function* () {
          const remaining = request.expiresAt - (yield* Clock.currentTimeMillis);
          if (remaining <= 0) return yield* new NativeElicitationFailed({ reason: "expired" });
          const prompt = yield* Schema.decodeUnknownEffect(McpSchema.ElicitRequestFormParams)(
            request.elicitation,
          ).pipe(Effect.mapError(() => new NativeElicitationFailed({ reason: "transport" })));
          const response = yield* reverse.elicit(prompt).pipe(
            Effect.catchTags({
              McpReverseOperationUnsupported: () =>
                Effect.fail(new NativeElicitationFailed({ reason: "unsupported" })),
              McpReverseOperationError: () =>
                Effect.fail(new NativeElicitationFailed({ reason: "transport" })),
            }),
            Effect.timeoutOrElse({
              duration: remaining,
              orElse: () => Effect.fail(new NativeElicitationFailed({ reason: "expired" })),
            }),
          );
          return yield* executions.resume(caller, backend, {
            requestId: request.requestId,
            response,
          });
        }).pipe(Effect.ensuring(executions.discard(caller, request.requestId)));
      }
      return result;
    }),
  );
