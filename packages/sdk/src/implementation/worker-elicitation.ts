import {
  ElicitationFailed,
  ElicitationReply,
  ElicitationResponse,
  FormElicitation,
  type ElicitationHandler,
} from "apps/contracts";
import { Cause, Effect, Option, Schema } from "effect";

export const invocationElicitation =
  (handler: ElicitationHandler, signal: AbortSignal) =>
  (input: unknown): Promise<typeof ElicitationReply.Encoded> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(FormElicitation)(input, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => new ElicitationFailed({ reason: "invalid-request" })));
        const response = yield* handler(request, signal).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ElicitationResponse)),
          Effect.catchTag("SchemaError", () =>
            Effect.fail(new ElicitationFailed({ reason: "invalid-response" })),
          ),
        );
        return { ok: true as const, response };
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.interrupt;
          const failure = Schema.decodeUnknownOption(ElicitationFailed)(Cause.squash(cause));
          return Effect.succeed({
            ok: false as const,
            error: Option.getOrElse(failure, () => new ElicitationFailed({ reason: "transport" })),
          });
        }),
        Effect.flatMap(Schema.encodeEffect(ElicitationReply)),
      ),
      { signal },
    );

interface Invocation {
  result(): Promise<unknown>;
  drain?: () => Promise<void>;
  cancel(): Promise<void>;
  [Symbol.dispose](): void;
}
export const AppRpcInvocation = Schema.declare(
  (value): value is Invocation =>
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    "result" in value &&
    typeof value.result === "function" &&
    "cancel" in value &&
    typeof value.cancel === "function" &&
    Symbol.dispose in value &&
    typeof value[Symbol.dispose] === "function",
);
interface AppRpcEntrypoint {
  start(
    body: string,
    headers: Readonly<Record<string, string>>,
    elicitation: ReturnType<typeof invocationElicitation> | null,
    workflow?: import("apps/contracts").WorkflowRpc | null,
    controls?: ((input: unknown) => Promise<unknown>) | null,
    cache?: ((input: unknown) => Promise<unknown>) | null,
  ): Promise<unknown>;
}
export const AppRpcEntrypoint = Schema.declare(
  (value): value is AppRpcEntrypoint =>
    typeof value === "object" &&
    value !== null &&
    "start" in value &&
    typeof value.start === "function",
);
