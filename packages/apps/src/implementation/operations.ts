/** Pure operation declarations. Only the author callback crosses the Promise boundary. */
import { Schema as EffectSchema } from "effect";
import type { AppOperation } from "../contracts/operations.ts";
import type { AppContext, QueryContext, MutationContext } from "../contracts/context.ts";
import type { Approval } from "../approval.ts";
import type { ToolAnnotations } from "../contracts/tools.ts";
import type { JsonObject } from "../contracts/schema.ts";
import { decoderOf, schemaArgument, type Schema } from "./schema.ts";
import { fromPromise } from "./authoring.ts";

const NativeOperation = Symbol("apps.Operation");
declare const QueryHandlerContext: unique symbol;
declare const MutationHandlerContext: unique symbol;
/**
 * A server-only declaration with its category preserved for catalog validation. Queries and
 * mutations carry their handler context under different phantom keys, so a router can type a
 * query's handler from its query context alone.
 */
export interface OperationDeclaration<Kind extends "query" | "mutation", Context = never> {
  readonly [QueryHandlerContext]?: "query" extends Kind ? (context: Context) => void : never;
  readonly [MutationHandlerContext]?: "mutation" extends Kind ? (context: Context) => void : never;
  readonly kind: Kind;
  readonly [NativeOperation]: Omit<AppOperation<never>, "kind" | "input"> & {
    readonly kind: Kind;
    readonly input: EffectSchema.Decoder<unknown>;
  };
}
/**
 * A router declaration. The phantom contexts let `defineApp` type inline handlers; protocol
 * routers accept any context because their operations only use the framework's own capabilities.
 * The native router is held under a private key in implementation/router.ts.
 */
export interface RouterDeclaration<Query = unknown, Mutation = unknown> {
  readonly [QueryHandlerContext]?: (context: Query) => void;
  readonly [MutationHandlerContext]?: (context: Mutation) => void;
  readonly [NativeRouterKey]: unknown;
}
/** An operation or nested router under one key. Each child is typed only by its own kind's context. */
export interface RouterChild<Query, Mutation> {
  readonly [QueryHandlerContext]?: (context: Query) => void;
  readonly [MutationHandlerContext]?: (context: Mutation) => void;
}
/**
 * A query or mutation whose handler context is checked by its kind, as a dynamic router resolves
 * one. `query()` and `mutation()` results fit with their inferred contexts.
 */
export type OperationChild<Query, Mutation> = RouterChild<Query, Mutation> &
  Pick<OperationDeclaration<"query" | "mutation">, "kind" | typeof NativeOperation>;
/** Private key for a router's native definition. */
export const NativeRouterKey = Symbol("apps.Router");

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
            fromPromise(async () => approval(context), "approval")(),
        }),
  };
};
/**
 * Replace a native operation's approval. Property descriptors are copied so an output schema that
 * a protocol adapter builds only when read stays lazy.
 */
export const approvedOperation = <Input, Native extends AppOperation<Input, unknown>>(
  operation: Native,
  approval: Approval<Input>,
): Native => {
  // SAFETY: the copy has every own property of `operation`, with only `approval` replaced below.
  const copy = Object.defineProperties({}, Object.getOwnPropertyDescriptors(operation)) as Native;
  return Object.defineProperty(copy, "approval", {
    enumerable: true,
    value: (context: Parameters<Approval<Input>>[0]) =>
      fromPromise(async () => approval(context), "approval")(),
  });
};

/** Attach the same approval function to a generated or shared operation. */
export const withApproval = <Input, Output, Kind extends "query" | "mutation", Context>(
  operation: Operation<Input, Output, Kind, Context>,
  approval: Approval<Input>,
): Operation<Input, Output, Kind, Context> => ({
  ...operation,
  [NativeOperation]: approvedOperation(operation[NativeOperation], approval),
});

/**
 * The advisory hints an operation carries, such as an MCP server's `destructiveHint`. App code
 * reads them to choose an approval; the framework never infers one from them.
 */
export const toolAnnotations = (
  operation: OperationDeclaration<"query" | "mutation", never>,
): ToolAnnotations | undefined => nativeOperation(operation)?.annotations;

const make = <Input, Output, Kind extends "query" | "mutation", Context extends AppContext>(
  kind: Kind,
  options: OperationOptions<Input, Output>,
  run: (context: Context, input: Input) => Promise<Output>,
): Operation<Input, Output, Kind, Context> =>
  operationDeclaration({
    ...operationOptions({ ...options, input: schemaArgument(options.input, `The ${kind} input`) }),
    kind,
    // The host always validates JSON serialization, even without a stronger output declaration.
    ...(options.output === undefined
      ? {}
      : { output: decoderOf(schemaArgument(options.output, `The ${kind} output`)) }),
    // SAFETY: defineApp checks the handler context against its requirements.
    // The host validates account bindings and creates the matching storage facade.
    run: (context, input) => fromPromise(run, "handler")(context as Context, input),
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
