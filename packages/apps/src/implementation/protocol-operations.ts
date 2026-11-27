/** Project upstream protocol metadata into the same operations authors declare by hand. */
import type { Effect, Schema } from "effect";
import type { OperationContext } from "../contracts/operations.ts";
import type { ToolAnnotations } from "../contracts/tools.ts";
import type { JsonObject, JsonValue } from "../contracts/schema.ts";
import { nativeOperation, operationDeclaration, type Operation } from "./operations.ts";
import { fixedRouter } from "./router-catalog.ts";
import { routerDeclaration } from "./router.ts";
import type { AppOperation } from "../contracts/operations.ts";

/** Explicit corrections for upstream read-only hints or unusual HTTP semantics. */
export type OperationKinds = Readonly<Record<string, "query" | "mutation">>;
interface ProtocolOperation {
  readonly description: string;
  readonly title?: string | undefined;
  readonly readOnly?: boolean | undefined;
  readonly annotations?: ToolAnnotations | undefined;
  readonly _meta?: JsonObject | undefined;
  readonly input: Schema.Decoder<JsonValue>;
  /** Checks and describes every returned value. */
  readonly output?: Schema.Decoder<JsonValue> | undefined;
  /** Describes the returned value without checking it; ignored when `output` is declared. */
  readonly outputSchema?: JsonObject | undefined;
  readonly run: (context: OperationContext, input: JsonValue) => Effect.Effect<unknown, unknown>;
}
/** Unknown behavior defaults to mutation. Classification never enforces an external service's behavior. */
export const protocolOperations = (
  operations: Readonly<Record<string, ProtocolOperation>>,
  kinds: OperationKinds = {},
) => {
  const declared: Record<
    string,
    Operation<JsonValue, unknown, "query" | "mutation", OperationContext>
  > = {};
  for (const [name, operation] of Object.entries(operations)) {
    const kind = Object.hasOwn(kinds, name)
      ? (kinds[name] ?? "mutation")
      : operation.readOnly === true
        ? "query"
        : "mutation";
    const native = {
      description: operation.description,
      ...(operation.title === undefined ? {} : { title: operation.title }),
      ...(operation.annotations === undefined ? {} : { annotations: operation.annotations }),
      ...(operation._meta === undefined ? {} : { _meta: operation._meta }),
      input: operation.input,
      ...(operation.output === undefined ? {} : { output: operation.output }),
      run: operation.run,
    };
    const output = Object.getOwnPropertyDescriptor(operation, "outputSchema");
    const withOutput = <T extends object>(target: T): T =>
      operation.output !== undefined ||
      output === undefined ||
      (output.get === undefined && output.value === undefined)
        ? target
        : Object.defineProperty(target, "outputSchema", { ...output, enumerable: true });
    declared[name] = operationDeclaration(withOutput({ ...native, kind }));
  }
  return declared;
};

/** Operations already discovered, as a router keyed by upstream name. */
export const protocolRouter = (
  operations: Readonly<Record<string, ProtocolOperation>>,
  kinds: OperationKinds = {},
) => {
  const native: Record<string, AppOperation> = {};
  for (const [name, declaration] of Object.entries(protocolOperations(operations, kinds))) {
    const operation = nativeOperation(declaration);
    if (operation !== undefined) native[name] = operation;
  }
  return routerDeclaration(fixedRouter(native));
};
