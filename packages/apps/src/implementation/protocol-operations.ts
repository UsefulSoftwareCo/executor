/** Project upstream protocol metadata into the same operations authors declare by hand. */
import type { Effect, Schema } from "effect";
import type { OperationContext } from "../contracts/operations.ts";
import type { ToolAnnotations } from "../contracts/tools.ts";
import type { JsonObject, JsonValue } from "../contracts/schema.ts";
import { operationDeclaration, type Operation } from "./operations.ts";

/** Explicit corrections for upstream read-only hints or unusual HTTP semantics. */
export type OperationKinds = Readonly<Record<string, "query" | "mutation">>;
interface ProtocolOperation {
  readonly description: string;
  readonly title?: string | undefined;
  readonly readOnly?: boolean | undefined;
  readonly annotations?: ToolAnnotations | undefined;
  readonly _meta?: JsonObject | undefined;
  readonly input: Schema.Decoder<JsonValue>;
  readonly outputSchema?: JsonObject | undefined;
  readonly run: (context: OperationContext, input: JsonValue) => Effect.Effect<unknown, unknown>;
}
/** Unknown behavior defaults to mutation. Classification never enforces an external service's behavior. */
export const protocolOperations = (
  operations: Readonly<Record<string, ProtocolOperation>>,
  kinds: OperationKinds = {},
) => {
  const queries: Record<string, Operation<JsonValue, unknown, "query", OperationContext>> = {};
  const mutations: Record<string, Operation<JsonValue, unknown, "mutation", OperationContext>> = {};
  for (const [name, operation] of Object.entries(operations)) {
    const kind = Object.hasOwn(kinds, name)
      ? kinds[name]
      : operation.readOnly === true
        ? "query"
        : "mutation";
    const native = {
      description: operation.description,
      ...(operation.title === undefined ? {} : { title: operation.title }),
      ...(operation.annotations === undefined ? {} : { annotations: operation.annotations }),
      ...(operation._meta === undefined ? {} : { _meta: operation._meta }),
      input: operation.input,
      ...(operation.outputSchema === undefined ? {} : { outputSchema: operation.outputSchema }),
      run: operation.run,
    };
    if (kind === "query") queries[name] = operationDeclaration({ ...native, kind });
    else mutations[name] = operationDeclaration({ ...native, kind: "mutation" });
  }
  return { queries, mutations };
};
