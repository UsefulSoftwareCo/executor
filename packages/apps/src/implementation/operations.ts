/** Pure operation declarations. Only the author callback crosses the Promise boundary. */
import { Effect, Schema as EffectSchema } from "effect";
import type { AppOperation } from "../contracts/operations.ts";
import type { AppContext, QueryContext, MutationContext } from "../contracts/context.ts";
import type { Approval } from "../approval.ts";
import type { ToolAnnotations } from "../contracts/tools.ts";
import type { JsonObject } from "../contracts/schema.ts";
import { decoderOf, type Schema } from "./schema.ts";

const NativeOperation = Symbol("apps.Operation");
declare const HandlerContext: unique symbol;
/** A server-only declaration with its category preserved for catalog validation. */
export interface OperationDeclaration<Kind extends "query" | "mutation", Context = never> {
  readonly [HandlerContext]?: (context: Context) => void;
  readonly kind: Kind;
  readonly [NativeOperation]: Omit<AppOperation<never>, "kind" | "input"> & {
    readonly kind: Kind;
    readonly input: EffectSchema.Decoder<unknown>;
  };
}
/** Typed operation handles drive browser reference inference without bundling handlers. */
export interface Operation<
  Input,
  Output,
  Kind extends "query" | "mutation",
  Context = AppContext,
> extends OperationDeclaration<Kind, Context> {
  readonly [NativeOperation]: AppOperation<Input, Output> & { readonly kind: Kind };
}
/** Retain a native operation without evaluating it. Used by database and protocol constructors. */
export const operationDeclaration = <
  Input,
  Output,
  Kind extends "query" | "mutation",
  Context = AppContext,
>(
  operation: AppOperation<Input, Output> & { readonly kind: Kind },
): Operation<Input, Output, Kind, Context> => ({
  kind: operation.kind,
  [NativeOperation]: operation,
});
/** Accept only framework-created declarations; input is decoded before its erased callback is invoked. */
export const nativeOperation = (value: unknown): AppOperation | undefined => {
  if (typeof value !== "object" || value === null || !(NativeOperation in value)) return undefined;
  // SAFETY: only our constructors install this private symbol and retain the paired input decoder.
  return value[NativeOperation] as AppOperation;
};
/** Options shared by database and external operations. Output defaults to a JSON-safe host check. */
export interface OperationOptions<Input, Output> {
  readonly description?: string;
  readonly title?: string;
  readonly input: Schema<Input, boolean>;
  readonly output?: Schema<Output, boolean>;
  readonly approval?: Approval<Input>;
  readonly annotations?: ToolAnnotations;
  readonly _meta?: JsonObject;
}
/** Adapt metadata and approval without running user code. */
export const operationOptions = <Input, Output>(options: OperationOptions<Input, Output>) => {
  const approval = options.approval;
  return {
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.annotations === undefined ? {} : { annotations: options.annotations }),
    ...(options._meta === undefined ? {} : { _meta: options._meta }),
    input: decoderOf(options.input),
    ...(approval === undefined
      ? {}
      : {
          approval: (context: Parameters<typeof approval>[0]) =>
            Effect.tryPromise({ try: async () => approval(context), catch: (error) => error }),
        }),
  };
};
/** Attach the same approval function to a generated or shared operation. */
export const withApproval = <Input, Output, Kind extends "query" | "mutation", Context>(
  operation: Operation<Input, Output, Kind, Context>,
  approval: Approval<Input>,
): Operation<Input, Output, Kind, Context> => ({
  ...operation,
  [NativeOperation]: {
    ...operation[NativeOperation],
    approval: (context) =>
      Effect.tryPromise({ try: async () => approval(context), catch: (error) => error }),
  },
});

const make = <Input, Output, Kind extends "query" | "mutation", Context extends AppContext>(
  kind: Kind,
  options: OperationOptions<Input, Output>,
  run: (context: Context, input: Input) => Promise<Output>,
): Operation<Input, Output, Kind, Context> =>
  operationDeclaration({
    ...operationOptions(options),
    kind,
    // The host always validates JSON serialization, even without a stronger output declaration.
    ...(options.output === undefined ? {} : { output: decoderOf(options.output) }),
    run: (context, input) =>
      Effect.tryPromise({
        // SAFETY: defineApp checks the handler context against its requirements.
        // The host validates account bindings and creates the matching storage facade.
        try: () => run(context as Context, input),
        catch: (error) => error,
      }),
  });
/** Read operation. External reads are allowed; only database writes are mechanically prohibited. */
export const query = <Input, Output, Context extends AppContext = QueryContext>(
  options: OperationOptions<Input, Output>,
  run: (context: Context, input: Input) => Promise<Output>,
) => make("query", options, run);
/** Explicit write operation. Database writes roll back on failure; external effects cannot be undone. */
export const mutation = <Input, Output, Context extends AppContext = MutationContext>(
  options: OperationOptions<Input, Output>,
  run: (context: Context, input: Input) => Promise<Output>,
) => make("mutation", options, run);
