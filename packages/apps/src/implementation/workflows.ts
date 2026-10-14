/** Ordinary async workflow declarations, adapted once into native Effect handlers. */
import type { Schema as EffectSchema } from "effect";
import type { AppWorkflow, WorkflowContext } from "../contracts/workflows.ts";
import type { AppRequirements } from "../contracts/context.ts";
import type { AccountScope } from "../contracts/app.ts";
import { fromPromise } from "./authoring.ts";
import { decoderOf, schemaArgument, type Schema } from "./schema.ts";

const NativeWorkflow = Symbol("apps.Workflow");
/**
 * The context any workflow may declare: either scope, so a run started without a caller, such as
 * by an app schedule, declares `WorkflowContext<typeof requirements, "app">`.
 */
export type AnyWorkflowContext = WorkflowContext<AppRequirements, AccountScope>;
declare const HandlerContext: unique symbol;
/** A workflow declaration retains input/output inference and required context compatibility. */
export interface Workflow<Input, Output, Context extends AnyWorkflowContext = WorkflowContext> {
  readonly [HandlerContext]?: (context: Context) => void;
  readonly [NativeWorkflow]: AppWorkflow<Input, Output>;
}
/** Composition view erases input only after retaining its runtime decoder. */
export interface WorkflowDeclaration<Context extends AnyWorkflowContext> {
  readonly [HandlerContext]?: (context: Context) => void;
  readonly [NativeWorkflow]: Omit<AppWorkflow<never>, "input"> & {
    readonly input: EffectSchema.Decoder<unknown>;
  };
}
/** Declare durable orchestration without starting a run or performing I/O. */
export const workflow = <Input, Output, Context extends AnyWorkflowContext = WorkflowContext>(
  options: {
    readonly input: Schema<Input, boolean>;
    readonly output?: Schema<Output, boolean>;
    readonly description?: string;
  },
  run: (context: Context, input: Input) => Promise<Output>,
): Workflow<Input, Output, Context> => ({
  [NativeWorkflow]: {
    input: decoderOf(schemaArgument(options.input, "The workflow input")),
    ...(options.output === undefined
      ? {}
      : { output: decoderOf(schemaArgument(options.output, "The workflow output")) }),
    ...(options.description === undefined ? {} : { description: options.description }),
    // SAFETY: defineApp checks required context; the host supplies the pinned run's capabilities.
    run: (context, input) => fromPromise(run, "workflow")(context as Context, input),
  },
});
/** Only this module creates the private declaration symbol; input is decoded before invocation. */
export const nativeWorkflow = (value: unknown): AppWorkflow | undefined => {
  if (typeof value !== "object" || value === null || !(NativeWorkflow in value)) return undefined;
  // SAFETY: declaration constructors preserve the callback/decoder pairing behind this symbol.
  return value[NativeWorkflow] as AppWorkflow;
};
